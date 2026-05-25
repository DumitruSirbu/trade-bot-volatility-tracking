# ADR 0021 — Kill-switch contract (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0020 (auth), M0 (halt flag), M4 (risk halts), M5 (execution honors halt), ADR 0014 (recovery rejects exposure-increasing intents).
**Consumed by:** ADR 0022 (read-API exposes halt state), ADR 0023 (WS pushes halt transitions), ADR 0024 (Telegram alert on halt).

## 1. Context

M0 shipped a process-local halt flag; M4 added programmatic risk-halts (global market-stress, model-divergence kill-switch, daily/weekly loss windows); M5 made the executor refuse exposure-increasing intents while halted. M9 adds the **operator-driven** path: a single authenticated HTTP action that flips the same flag, with audit + rate-limit + alert.

The invariant is `no order path bypasses the risk gate, including the kill-switch flatten`. The kill-switch is therefore **not** a backdoor to the exchange — it sets a flag the gate and executor already honor.

## 2. Decision

### 2.1 Endpoint shape

```
POST /v1/control/halt
Authorization: Bearer <token with scope=halt>
Body: { "reason": "<free-text, max 256 chars>", "flattenOpenPositions": <boolean, optional> }
→ 200 { "haltState": "HALTED", "haltedAt": "<ISO>", "haltReason": "OPERATOR:<reason>", "flattenRequested": <bool>, "auditId": "<uuid>" }

POST /v1/control/resume
Authorization: Bearer <token with scope=halt>
Body: { "reason": "<free-text, max 256 chars>" }
→ 200 { "haltState": "RUNNING", "resumedAt": "<ISO>", "auditId": "<uuid>" }

GET /v1/control/halt
Authorization: Bearer <token with scope=read>
→ 200 IKillSwitchState  (shape in packages/shared, see §2.6)
```

Idempotency: a second `POST /halt` while already halted returns `200` with the same `haltState` but a fresh `auditId` (the operator action is still audited). It does **not** re-trigger a flatten — the flatten flag is bound to the first transition.

### 2.2 Rate-limit policy

Per token `sub`: max **5 halt/resume toggles per 60 seconds**, sliding window. Exceeded → HTTP `429` with `Retry-After`. Rationale: the kill-switch is a panic button, not a polling mechanism; an operator slamming it repeatedly is either confused or compromised — either way, throttle.

Rate-limit is enforced server-side in an interceptor; bypass for `scope=admin` is **not** granted (the admin token is for revocation/rotation, not for control-plane spam).

### 2.3 Audit-log schema

A new table `control_audit` (one row per accepted toggle):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | server-minted |
| `occurred_at` | `timestamptz` NOT NULL | event-time, monotonic via injected clock (live↔backtest determinism — even though no replay path uses this, the convention holds) |
| `actor_sub` | `text` NOT NULL | from `IAuthSubject.sub` |
| `actor_jti` | `text` NOT NULL | for forensic correlation with revocation |
| `source_ip` | `inet` NULL | from the proxied request; null if loopback |
| `action` | `text` NOT NULL | `HALT` \| `RESUME` |
| `reason` | `text` NOT NULL | operator-supplied, truncated server-side at 256 |
| `flatten_requested` | `boolean` NOT NULL DEFAULT false | only meaningful on `HALT` |
| `previous_state` | `text` NOT NULL | `RUNNING` \| `HALTED` |
| `new_state` | `text` NOT NULL | `RUNNING` \| `HALTED` |
| `correlation_event_id` | `text` NULL | set when the toggle was triggered by a programmatic source (e.g., the alert side-channel hits the same endpoint) — null for operator |

Indexed on `(occurred_at DESC)` and `(actor_sub, occurred_at DESC)`.

**Pagination codec (M9 R1 adjudication D).** `GET /v1/control/halt/history` MUST use the shared `CursorCodec` (HMAC tamper-guarded, same key as the rest of W4) — not plaintext base64. The audit log is read-scoped but operator-authored: an attacker who somehow obtains a read token should not be able to construct cursors that probe row existence beyond their authenticated session, and consistency across the read API eases the dashboard's cursor handling. Decision is: one codec, one rule.

`control_audit` is **append-only**. No update/delete from the engine; operator-driven deletion requires a manual migration.

**Halt source-of-truth split (M9 R1 adjudication A — Option β chosen).** The dual-storage problem (M4 `RiskGateService.persistHalt` writing `risk_state.is_halted` AND the W3 listener writing `control_audit` for the same event) is resolved by separating concerns by surface:

- `risk_state.is_halted` (UTC-day row, written by `persistHalt`) is the **hot-path source of truth for the risk gate's GLOBAL_HALT check**. It is DB-canonical, replay-safe, idempotent on the UTC-day key, and is what the gate consults each `evaluate(...)`. This must not change — the live-vs-backtest determinism contract depends on it.
- `control_audit` is the **operator audit log + boot-recovery source for the in-process halt flag**. It is the SoT for `GET /v1/control/halt/history` and for `HaltStateRestoreService` PHASE 3 boot replay.
- `RiskListeners.onRiskHalt` / `onModelDivergence` (W6) are **alert-only**. They MUST NOT call `HaltService.engageHalt(...)`. They publish the `IAlertPayload` and update the in-memory halt flag via `HaltFlagService` only (so M5's flag-based refusal works in the same tick). They do NOT write a `control_audit` row; the programmatic halt is already durable in `risk_state.is_halted`.
- `control_audit` rows are written exclusively by the **operator path** (`POST /v1/control/halt`, `POST /v1/control/resume`) and (later, M11) any external programmatic resume. `GET /v1/control/halt/history` therefore returns operator history only; the dashboard surfaces programmatic halts via the `IRiskHaltEvent` bus stream (ADR 0023) + the per-day `risk_state.haltReason`.

Consequences locked here:

1. The `actor_sub = 'SYSTEM:<source>'` convention is REMOVED from this ADR — `control_audit` rows always carry a real `actor_sub`.
2. `IKillSwitchState.haltSource` is derived as: if `risk_state.is_halted=true AND no operator audit row newer than the risk-day's start` → the persisted `risk_state.haltReason` maps to a `HaltSourceEnum`; otherwise the latest `control_audit` row wins.
3. `HaltStateRestoreService` PHASE 3 reads BOTH: it picks the more-recent of (latest `control_audit` row, `risk_state` for today with `is_halted=true`). Whichever is newer drives the in-process halt flag on boot.
4. `IHaltChangedEvent` bus emit (W3) fires from BOTH `HaltService.engageHalt` (operator path) AND from `RiskListeners` after they flip the in-memory flag (programmatic path). The event is the unified stream for the WS gateway.

Why not Option α (`control_audit` as sole SoT): the gate would need to consult `control_audit` on the hot path, which (a) breaks the gate's "reads `risk_state` snapshot once per evaluate" invariant and (b) introduces a dependency from the deterministic gate into the operator audit table. Not worth it.

Why not Option γ ("passive" engage): it requires `HaltService` to silently no-op the flag-flip branch when called from the listener, which is exactly the side-effect-on-flag-state coupling Option β removes by making the listener own the in-memory flip directly.

### 2.4 `flattenOpenPositions` default & semantics

Default = `false`. Rationale: a panic halt should **stop new risk** but leave existing positions under their stops; force-closing into a stressed tape is often worse than holding to the SL. The operator opts in to flatten by explicitly setting `flattenOpenPositions: true`.

The default is config-overridable via env `KILL_SWITCH_FLATTEN_DEFAULT` (false by default). **The value is read once at boot by `AppConfigService` with typed boolean coercion** (ADR 0020 §2.7) and injected into `HaltController` as a constant; `HaltController` MUST NOT touch `process.env` per request (M9 R1 adjudication E). Rationale: per-request `process.env` parsing is allergic to typos (a stray `'False'` casing slips through the truthy check) and silently differs from any other env-coerced value in the engine.

When `flattenOpenPositions = true`:

- The halt flag flips first.
- The engine enqueues a `CLOSE` intent (`OrderIntentActionEnum.CLOSE`) for each open position via the **normal risk gate + executor path**, NOT a direct exchange call. The gate's "de-risking always allowed during halt" rule (ADR 0014 §1 revision) lets these through. ExecutionModule routes each through `REDUCE_MARKET` policy (ADR 0005).
- A `flatten_requested` audit row is written; per-position close events surface via existing M6/M5 instrumentation.

If a programmatic halt (e.g., model-divergence kill-switch) wants to flatten, it sets the same flag and emits the same intents — no special code path.

### 2.5 How ExecutionModule consumes the halt state

No change to M5: the executor already reads the halt flag via the M0 `IHaltFlag` port and refuses exposure-increasing intents. M9 only adds **two write paths** into the same flag:

1. operator `POST /halt` / `POST /resume`,
2. programmatic risk halts (M4) — already wired pre-M9; this ADR formalises that they also emit a `control_audit` row.

The flag itself stays in-process (no migration; recovery on restart loads the most recent `control_audit` row to re-establish state — added in W1 of M9 to the boot pipeline).

### 2.6 Shared state shape

`IKillSwitchState` (locked in `packages/shared/src/interface/IKillSwitchState.ts`, added by shared-maintainer in W0):

```
{
  haltState: 'RUNNING' | 'HALTED',
  haltedAt: string | null,        // ISO; null when RUNNING
  haltReason: string | null,      // null when RUNNING
  haltSource: HaltSourceEnum,     // OPERATOR | MARKET_STRESS | MODEL_DIVERGENCE | DAILY_LOSS | WEEKLY_LOSS | RECOVERY | OTHER
  flattenInProgress: boolean,     // true while flatten intents are in-flight
  lastTransitionAuditId: string,  // uuid into control_audit
}
```

`HaltSourceEnum` is a new shared enum (W0). The string `haltReason` is the operator-supplied or M4-supplied reason verbatim, redacted of any secret-shaped substring (regex strip in the alert layer per ADR 0024).

## 3. Consequences

- The kill-switch never reaches the exchange directly — it flips one flag the rest of the engine already respects. This preserves the "no order path bypasses the risk gate" invariant.
- Every halt — operator or programmatic — produces a `control_audit` row and a Telegram alert (ADR 0024). Single source of truth for both forensic review and dashboard timelines.
- Boot-pipeline now must load the last `control_audit` row to restore halt state; documented in §2.5 and folded into M9 W1.
- Rate-limit is per-`sub`, not per-IP — correct for a single-operator system; revisit for multi-operator in M11.
- `flattenOpenPositions` defaults to `false` and is loud about it in the response — surprise-free.

## 4. Alternatives considered

- **Flatten by default.** Rejected: forced exits into stress (the most common reason to halt) often realise worse fills than the standing SLs. The cautious default is "stop new risk, preserve existing stops."
- **Direct exchange-side cancelAll on halt.** Rejected: this is the bypass path the project invariants forbid. Cancels go through the executor like any other order.
- **No rate-limit (panic button should never throttle).** Rejected: the first toggle is unthrottled (rate-limit starts at the 6th in 60s). The operator's first jab always lands.
- **Audit in a JSON log file only.** Rejected: the dashboard (M10) needs queryable history; a table is cheaper than parsing logs from the UI.
- **Kill-switch as a WS command.** Rejected: per M9 "Telegram is never a control path" and the WS is similarly read-only — control-plane stays HTTP for explicit, auditable, idempotent semantics.
