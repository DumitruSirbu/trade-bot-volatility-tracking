# ADR 0024 — Telegram alerts: outbound-only, redaction, rate-limit (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0021 (halt sources), M4 (risk halts + model divergence), M5 (execution events), M6 (position open/close), `docs/plans/00-overview.md` (UTC risk-day).
**Consumed by:** none (terminal side-channel).

## 1. Context

M9 requires phone alerts on `open / close / error / halt` plus a daily PnL summary aligned to the UTC risk-day. The brief is explicit: **strictly outbound, no inbound command handling, redact secrets.** Telegram is never a control path — the bot does not subscribe to inbound updates.

## 2. Decision

### 2.1 Outbound-only invariant

The engine uses Telegram Bot API's `sendMessage` only. It does **not**:

- call `getUpdates`,
- set a webhook,
- register any inbound handler.

The Telegram bot token is treated as a write-only credential. Even if the token leaks, an attacker gets the ability to send-as-bot, not to control the engine. This is documented in ADR + enforced by code review (W5 checklist).

### 2.2 Event taxonomy

| Event | Trigger | Severity | Coalesces? |
|---|---|---|---|
| `POSITION_OPENED` | `position.opened` (M6) | info | No |
| `POSITION_CLOSED` | `position.closed` (M6) | info | No |
| `ORDER_REJECTED_TERMINAL` | M5 terminal-reject classifier | warn | 1/min per symbol |
| `RISK_HALT_ENGAGED` | M4 market-stress halt fires | critical | No |
| `MODEL_DIVERGENCE_ENGAGED` | M4 model-divergence kill-switch fires | critical | No |
| `OPERATOR_HALT` | ADR 0021 operator halt | critical | No |
| `OPERATOR_RESUME` | ADR 0021 operator resume | info | No |
| `BOOT_SCHEMA_GATE_FAILED` | ADR 0025 schema-validation gate trips | critical | No (loud + once per boot) |
| `RECONCILIATION_DRIFT_UNRESOLVED` | M6 drift case escalated past auto-resolution | warn | 1/min per symbol |
| `UNHANDLED_EXCEPTION` | top-level error handler | critical | 1/5min global (avoid loops) |
| `DAILY_PNL_SUMMARY` | 00:00 UTC tick (scheduler) | info | Daily, exactly once |

### 2.3 Payload shape & redaction

Every alert renders from a structured `IAlertPayload` (shared interface, W0). The renderer applies a **redaction pass** before sending:

- Strip any substring matching token-shaped regexes: `eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}` (JWT), `[A-Za-z0-9]{32,}` runs that match known secret-shaped envs at boot.
- Never include: `AUTH_SIGNING_SECRET`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, raw stack traces (only top frame + error type).
- Never include: full bearer tokens from request audit, exchange-side `orderId` raw payload (use `clientOrderId` slug only).
- Money in messages: render as `$1,234.56` (two-decimal display); never the raw decimal-string `MoneyValue` (avoid scientific notation surprises). The structured field on the audit row keeps full precision.

The redactor is a single pure function tested with adversarial fixtures (W5) including: token-shaped strings inside `reason` fields, accidental `process.env.dump`, error.cause chains. Failing redaction is a blocker-severity finding.

### 2.4 Rate-limit

- Global ceiling: **30 messages/minute** (Telegram's own per-bot per-chat ceiling is ~20/min; we stay under).
- Per-symbol ceiling: 1/min for `ORDER_REJECTED_TERMINAL` and `RECONCILIATION_DRIFT_UNRESOLVED` (coalesce-and-summarise: `[symbol] 4 terminal rejects in 60s — last: REASON`).
- Critical events (`RISK_HALT_ENGAGED`, `MODEL_DIVERGENCE_ENGAGED`, `OPERATOR_HALT`, `BOOT_SCHEMA_GATE_FAILED`) **bypass coalescing** but still count against the global ceiling — if the global ceiling is hit, criticals are sent and lower-severity messages are dropped (with a `[N alerts suppressed in last 60s]` line appended to the next message).
- `UNHANDLED_EXCEPTION` has a 1-per-5-minute floor to prevent a tight error loop from melting the Telegram API quota.

### 2.5 UTC risk-day alignment

The "daily" summary runs at exactly `00:00:00 UTC` via the same injected clock the engine uses elsewhere (so test runs can fake the trigger). The summary reads:

- `risk_state` for the just-completed UTC day,
- aggregated PnL from `positions` closed in that window,
- count of halts in `control_audit` for the window,
- summary line: `[YYYY-MM-DD UTC] realized $X.XX, trades N (W/L), max drawdown $Y.YY, halts: M`.

No timezone other than UTC is used anywhere in the alert pipeline — the risk-day is UTC by project decision (`00-overview.md`).

### 2.6 Delivery & failure

Delivery uses an HTTP client with: 5s timeout, 3 retries with exponential backoff (1s/3s/9s), then drop + log. The alert pipeline **never blocks the trade loop** — it consumes from an internal in-memory queue (bounded at 1000; oldest-dropped on overflow with a counter increment). Drops are observable via a metric, not silent.

Telegram outage does NOT trigger a halt — the bot keeps trading. Alerts are advisory, not consensus.

### 2.7 Configuration

- `TELEGRAM_BOT_TOKEN` (env, required for prod, optional in dev — undefined disables the sender, replaced with a no-op).
- `TELEGRAM_CHAT_ID` (env, required when token set).
- `ALERTS_ENABLED` (env, default `true`).
- `ALERTS_MIN_SEVERITY` (env, default `info`).

Boot fails (per ADR 0025) if `ALERTS_ENABLED=true` and the token/chat id is missing — refusing to boot is better than silently swallowing alerts.

### 2.8 `IHaltChangedEvent` dedupe (M9 R1 adjudication B)

When an operator presses HALT while the engine is already HALTED, `HaltService.engageHalt` still writes an audit row (operator action is always audited) but the in-process halt state does not transition. To prevent the dashboard from flashing a `HALTED → HALTED` transition, the bus emit follows this rule:

- The `IHaltChangedEvent` interface gains a `wasAlreadyHalted: boolean` field (set by `HaltService` from the pre-write `previousState === newState` check). Same for `RESUME` while already RUNNING.
- The WS gateway (ADR 0023) and the Telegram alert pipeline both consume the bus event. The WS gateway forwards the event verbatim (the dashboard decides whether to render an "operator re-affirmed halt" toast or suppress). The Telegram pipeline DOES still fire an `OPERATOR_HALT` / `OPERATOR_RESUME` alert even when `wasAlreadyHalted=true` (the operator wants confirmation the action landed).
- Programmatic re-engages (same `HaltSourceEnum` firing while already halted) are suppressed at the bus level by `RiskListeners`' existing dedup window — no `IHaltChangedEvent` is emitted on a re-fire. The Telegram coalescer (§2.4) provides a second floor.

Rationale for surfacing the flag (not suppressing the emit entirely): the operator's audit row is real and the dashboard's audit timeline must update; flagging the no-op transition lets each consumer choose how loud to be.

## 3. Consequences

- Alerts are advisory and lossy by design; the source of truth stays in the database and the dashboard (M10).
- Redaction is a hard checkpoint at the rendering boundary — single function to review, fuzz, and own.
- No inbound surface means the Telegram bot token is the least dangerous credential on the box.
- Rate-limits protect both the operator's attention and Telegram's quotas; criticals always land.
- The summary aligns with the UTC risk-day used everywhere else — no off-by-one operator confusion.

## 4. Alternatives considered

- **Two-way Telegram (inbound `/halt` command).** Rejected per M9 brief — adds a control surface with weaker auth than the bearer-gated HTTP endpoint, and an inbound webhook needs a public endpoint we don't otherwise need.
- **Email/PagerDuty/Slack.** Deferred to M11; the operator wants a phone notification today, Telegram is the lowest-friction path. The alert dispatch sits behind an `IAlertSink` port so a second sink (PagerDuty) is additive.
- **No rate-limit (alert on everything).** Rejected: an error loop in a noisy module would hammer Telegram, get the bot rate-limited by them, and starve the critical alerts.
- **No daily summary.** Rejected: operators want a single-glance EOD line; absence of alerts is itself information ("nothing engaged today").
- **Synchronous send in the trade-loop path.** Rejected: Telegram latency must never block an order or a state transition.
