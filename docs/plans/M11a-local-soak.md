# M11a — Local soak hardening

**PAPER is not exchange demo trading (invariant)**

This must be visible to every reader before they read anything else:

**PAPER validates strategy / risk / operational behaviour against live
market data. PAPER does not validate live exchange execution semantics.**

That means PAPER does **not** test: Binance order acceptance, rejections,
partial fills, cancel semantics, protective-order behaviour at the
matching engine, rate-limit-ban responses against real orders, or any
other property of the exchange's order lifecycle. Those properties still
require TESTNET drills (see §"TESTNET pre-M11b drill" below).

A successful PAPER soak is a **necessary but not sufficient** condition
for M11b. Real-money go-live requires both PAPER's statistical/operational
evidence and TESTNET's exchange-contract evidence.

---

**Goal:** Make the existing stack production-grade on a single trusted machine so
the user can run a multi-week **PAPER** soak (engine-local paper trading against
live market data) at $0 infra cost and collect real signal on the
strategies before any cloud spend.

**Depends on:** M1–M10.
**Follows into:** M11b (cloud go-live) — only entered once the soak confirms a
live edge worth paying ~$5–60/mo to host.

**Review baseline:** architect / devops / security / logic review completed
2026-05-25 against commit `4bfeab4`. All blocker + high findings are folded into
the waves below; medium / low findings are tracked in the per-task notes.

## PAPER-mode architecture (locked decisions D1–D17)

The `PAPER` design is an engine-local paper-trading mode:

- WebSocket connects to **live** `fapi.binance.com` for market data + funding
  (real prices, real depth, real spread, real OI, real funding rates).
- Orders are intercepted before reaching ccxt and routed to a local
  `PaperFillSimulator`, which uses `FillSimulatorCore` (D15 — pure shared
  module; M7 backtests use the same core via `HistoricalFillAdapter`,
  PAPER uses `StreamingFillAdapter` on live event-time; causality test
  asserts no future-tick read).
- Account state (positions, balances, margin) is simulated locally in a new
  `PaperAccountStateService`; never reads or writes a real Binance account.
- Reconciliation in PAPER mode runs against the local simulated state plus a
  periodic null-probe against the exchange (catches engine-internal drift
  **and** the worst-case "did we accidentally leak an order" failure mode).
- Key-permission assertion is **mode-aware** and **stricter** in PAPER than in
  LIVE.

### Locked decisions D1–D17

#### D1 — `paper_account_state` is a dedicated table

Reject the `mode` discriminator on `positions` alternative. Reasons:
- PAPER retention follows a different policy from live positions.
- Crash recovery's phase-1 reader is simpler with a dedicated table.
- No risk of a PAPER position accidentally being read by a LIVE-mode read API
  query.
- `paper_account_state` writes are restricted to the engine DB role; the
  read-API role gets `SELECT` only.

#### D2 — `IExecutionClient` surface (frozen — order commands only)

`IExecutionClient` is **order-command-only**. Methods:
- `placeOrder(intent: IOrderIntent): Promise<IOrder>`
- `cancelOrder(symbol: string, id: string): Promise<void>`
- `cancelAllOrdersForSymbol(symbol: string): Promise<void>`
- `fetchOrderStatus(symbol: string, id: string): Promise<IOrder>`
- `fetchOpenOrders(symbol?: string): Promise<IOrder[]>` (here because
  the engine treats it as part of the order-lifecycle surface — pair
  with cancel/status)

Two implementations:
- `CcxtExecutionClient` (LIVE / TESTNET) — delegates to ccxt.
- `PaperExecutionClient` (PAPER) — delegates to `PaperFillSimulator`.

**Account-state reads (balance, positions, funding history) are NOT on
`IExecutionClient`.** They live on `IAccountStateSource` per D14
(`fetchBalance`, `fetchPositions`, `fetchOpenOrders`, `fetchFundingHistory`).

#### D3 — PaperFillSimulator determinism

Per-order PRNG seed schema (stateless derivation):
```
seed_master  = HKDF(bootstrap_secret, info='paper_simulator_seed v1')
order_seed   = HMAC-SHA256(seed_master, event_id || symbol || order_intent_id || version_namespace)
```

`seed_master` is **never persisted**. It is re-derived at every boot from
the bootstrap secret via HKDF. `order_seed` for any specific order is
recomputed from the persisted decision row at any time. No long-lived
secret-equivalent material lives in the database.

**Idempotency ledger, not an event cursor.** A single market event can
produce multiple order intents across active (v1 PAPER) and shadow (v2/v3)
versions; event-level cursoring is too coarse and would collide. Replace
with a `paper_simulator_idempotency` table keyed by
`(event_id, order_intent_id, version_namespace)` recording the
`simulated_fill_id` produced. On restart, the simulator looks up by key
before rolling; if a fill already exists for the key, return it verbatim
(byte-identical replay).

**Retention floor pinned:** the idempotency ledger retains for **soak_duration + 30 days**.
A SIGKILL replay after GC'd ledger rows would silently break replay
determinism otherwise.

#### D4 — Funding ordering and math

`PaperFundingAccrualService` applies live funding rates to
`PaperAccountStateService` positions at the **Binance-published funding
timestamp**, not local processing time.

**Sign convention pinned in account-PnL terms.** The convention follows the operator's intuition:
a positive funding rate is paid by longs to shorts.

```
funding_pnl = -position_notional × funding_rate × side_sign
  where side_sign(LONG)  = +1
        side_sign(SHORT) = -1
```

Equivalently:
- For `rate > 0`: long → funding_pnl is **negative** (long pays);
  short → funding_pnl is **positive** (short receives).
- For `rate < 0`: long receives, short pays.

**Magnitude bound is a warning, not a hard reject.** Funding-rate ingest
applies the rate to the position, writes an audit row, and emits a CRITICAL
Telegram alert. A simulator that silently zeroes funding during a stress
regime flatters expectancy at exactly the moment funding cost matters most
for shorts.

**Funding / PnL ordering inside a tick batch** is pinned: `apply_funding
→ recompute_unrealised_pnl → evaluate_drawdown_abort`.

**Funding force-flushes the MTM throttle.** A funding event arriving mid-throttle
would otherwise wait up to 100 ms before being applied — and a coincident
adverse mark could delay the abort by the same window. Funding event arrival
is therefore a throttle-exemption trigger: immediate `apply_funding +
recompute_unrealised + evaluate_abort`, regardless of throttle state.

#### D5 — Mark-to-market cadence + drawdown denominator

PaperAccountStateService unrealised PnL is recomputed on price updates for
held symbols at a **throttled cadence**. Binance mark-price ticks fire
multiple times per second under volatility; running MTM + drawdown abort
on every raw tick would saturate the Node.js event loop.

Throttle rule:
- Coalesce updates per held symbol to at most **once per 100 ms**, OR
  immediately when the cumulative price move since the last MTM exceeds
  one tick size (whichever comes first). The 100 ms ceiling protects the
  event loop; the tick-size early-trip protects abort-threshold latency
  during fast moves.
- Inside the throttle window, the latest tick is retained and applied
  when the throttle fires (no dropped data, only deferred work).

**Drawdown denominator pinned to running peak equity.**
The drawdown abort threshold (15%) compares against `peak_equity`, not
starting equity:
```
drawdown(t)    = (peak_equity(t) - equity(t)) / peak_equity(t)
peak_equity(t) = max(equity(τ)) for τ ∈ [soak_start, t]
peak_equity(0) = PAPER_STARTING_EQUITY_USDT   // cold start; not the first MTM tick
```

With D11's $500 starting equity and 0.25% risk per trade, peak-equity
denominator means the abort fires on a true regime break, not on a routine
losing streak from a high-water mark.

#### D6 — Mode-switch predicate + integrity

Predicate: **persisted last-known boot mode ≠ current `EXCHANGE_ENV`** →
abort with a clear error. Recorded in a new `boot_mode_history` table
written **at successful boot** (not at shutdown — crash-safety).

The HMAC subkey derivation uses HKDF per-purpose subkeys so a leak of one
key does not compromise others.

**Threat model — tamper-evidence, not tamper-proofing.** The HMAC
chains catch accidental corruption and unauthorized DB-only modification
by a process that does not have the host's bootstrap secret. They do **not**
protect against an attacker who gains host shell access.

#### D7 — Mode-transition matrix (append-only, never truncate the chain)

ADR 0032 includes the transition matrix; the operator must follow the
documented drain procedure for each transition. **Undocumented transitions
are rejected at boot**.

**Chain rotation primitive: append-only typed rows.** Every legitimate
transition is recorded as an **append-only typed row** that references the
prior tip's HMAC, signed under the appropriate sub-key. The chain is
**never truncated**.

| From | To | Procedure |
|------|----|-----------|
| TESTNET | PAPER | Confirm `paper_account_state` empty; operator provides `TESTNET_TO_PAPER_TOKEN_FILE`; boot appends transition row; proceeds. |
| TESTNET | LIVE | Operator provides both `TESTNET_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; CRITICAL alert. |
| PAPER | TESTNET | Reject unless `paper_account_state` empty; operator provides `PAPER_TO_TESTNET_TOKEN_FILE`; runbook documents cleanup step. |
| PAPER | LIVE | Reject unless `paper_account_state` empty; operator provides `PAPER_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; CRITICAL alert. |
| LIVE | PAPER | Reject unless no open live positions; operator provides `LIVE_TO_PAPER_TOKEN_FILE`; CRITICAL alert. **Predicate must use transition-time `ExchangeAccountStateSource(prior_env_credentials)`.** |
| LIVE | TESTNET | Reject. Use separate machine or execute documented destructive-wipe runbook (records `MACHINE_REPURPOSE_WIPE` row). |

#### D8 — PAPER allowlist (full enumeration)

The PAPER allowlist rejects `enableFutures: true` — a tradeable key paired
with PAPER mode is a hard error:

```ts
isKeyPermissionSnapshotAcceptable(snapshot, nowMs, { mode: 'paper' })
=> 
  snapshot.enableReading === true
  && snapshot.enableFutures === false
  && snapshot.enableSpot === false
  && snapshot.enableWithdrawals === false
  && snapshot.enableInternalTransfer === false
  && snapshot.permitsUniversalTransfer === false
  && snapshot.enableMargin === false
  && snapshot.enableVanillaOptions === false
  && snapshot.enableSubAccountManagement === false
  && snapshot.ipRestrict === true
  && snapshot.ipAllowList.length > 0
  && snapshot.tradingAuthorityExpirationTime !== null
  && snapshot.tradingAuthorityExpirationTime > nowMs
```

**Endpoint-accessibility verification (blocker resolution — gbt R2-M1).**
Some futures endpoints require `enableFutures: true`. Solution:
**PAPER runs under a dedicated zero-balance sub-account** with `enableFutures: true`:

- API key on a dedicated Binance sub-account whose sole purpose is to
  host the PAPER probe key. The main account is never reachable via
  this key.
- Allowlist amended: `{enableReading: true, enableFutures: true}` on
  this key — but **the engine refuses to boot if**:
  - Sub-account balance ≠ 0 at boot or at any reconciliation tick.
  - Sub-account has any open position at boot or at any tick.
  - Key has any transfer permission — must remain false.
  - IP allow-list is empty.
  - Trading authority is expired or null.

#### D9 — `LIVE_GO_AHEAD_TOKEN` is LIVE-only

PAPER does **not** require the go-ahead token. The read-only-only assertion
(D8) is PAPER's safety teeth.

#### D10 — Closed-trade counting (full enumeration)

| `closeReason` | Counts toward ≥80-trade floor? | Notes |
|--------------|-------------------------------|-------|
| `sl` | ✅ Yes | Stop-loss intra-bar fill. |
| `tp` | ✅ Yes | Take-profit intra-bar fill. |
| `intra_bar_stop` | ✅ Yes | Generic intra-bar protective stop. |
| `force_close` | ❌ No (excluded) | M7 end-of-window. Surfaced separately. |
| Operator drain | ❌ No (excluded) | Operator-initiated close during incident. |
| Reconciliation-forced close | ❌ No (excluded) | Engine-internal cleanup. |

Additionally:
- A simulator decision with `missed: true` does **not** consume the
  restricted profile's `max_trades_per_day: 3` slot.
  Missed fills are observability only.
- The soak evaluator emits a "excluded fills" report alongside the
  primary trade count.

#### D11 — PAPER starting equity

PAPER starting equity defaults to **$500**. Surfaced as
`PAPER_STARTING_EQUITY_USDT` env var, validated by Zod schema with `$500`
as the default.

#### D12 — Reconciliation in PAPER

PaperReconciliationAdapter inherits the **same triggers** as M6 W4b live
reconciliation — source swapped from exchange to PaperAccountStateService.

**Drift action in PAPER is more severe than in LIVE.** In PAPER, any drift
between in-memory `PaperAccountStateService` and the persisted
`paper_account_state` rows is a production bug. Action: CRITICAL Telegram
alert, audit row, halt new decision routing, await operator intervention.

#### D13 — PaperExchangeNullityProbe (defence in depth)

Independent of `PaperExecutionClient`'s internal invariants, the
reconciliation cycle calls **both** `fetchOpenOrders()` **and**
`fetchPositions()` against the live exchange and asserts both are empty.
Two readers, not one, because `fetchOpenOrders` only sees resting orders
— an accidental market-order fill closes immediately and leaves a position
with no open order trace.

**Dedicated PAPER sub-account, strongly preferred.** A dedicated Binance
sub-account whose only role is to hold the read-only PAPER key trivially
lets the probe assert **absolute nullity**: zero open orders AND zero
positions across all symbols.

**Capability preflight at PAPER boot:**
- The engine performs one `fetchOpenOrders` + one `fetchPositions` call
  against the configured PAPER key.
- Three branches:
  1. **Both succeed and both are empty** → probe is operational.
  2. **Both succeed and non-empty engine-attributed entry exists** →
     CRITICAL halt before soak starts.
  3. **Either call returns 401/403/permission error** →
     PAPER startup aborts. The probe cannot run with this key.

**Runtime failure-class taxonomy:**
- `Network / 5xx / timeout` → log and continue for up to 5 consecutive
  failures. On the 6th, emit WARNING and switch to exponential backoff.
  Binance outage cannot halt the soak.
- `401 / 403 / permission / malformed credential` → CRITICAL halt.
  The key changed mid-soak; soak result is invalidated.
- `Non-empty engine-attributed response` →
  CRITICAL halt + audit row.

**Cadence:** Probe runs **once per minute** for each of
`fetchOpenOrders` and `fetchPositions`.

#### D14 — `IAccountStateSource` port (full surface, not only orders)

Introduce `IAccountStateSource` as a second port:

```
IAccountStateSource {
  fetchBalance(): Promise<Balance>
  fetchPositions(symbol?): Promise<Position[]>
  fetchOpenOrders(symbol?): Promise<Order[]>
  fetchFundingHistory(symbol, since): Promise<Funding[]>
}
```

Two implementations:
- `ExchangeAccountStateSource` (LIVE / TESTNET) — delegates to ccxt.
- `PaperAccountStateSource` (PAPER) — backed by `PaperAccountStateService`.

`AccountSnapshotWriter`, reconciliation phase 1, funding cashflow readers,
and the read-API account projections are bound to **this port**, not to
`IExchangeClient`.

**The exception list** (rows the LIVE ccxt account-state methods are still
allowed to be called from in PAPER) is exactly two:
1. `KeyPermissionAssertionService` (boot-time `/sapi` calls).
2. `PaperExchangeNullityProbe` (D13).

**Runtime guard, not only static graph.** Pair the static check with:
1. **Capability-tagged proxy** on the two whitelisted methods using
   `AsyncLocalStorage` to tag the call-stack origin.
2. **ESLint rule** banning the strings outside the whitelisted file set.

#### D15 — `PaperFillSimulator` is **not** `BacktestRunnerService` reuse

**Decision: extract a pure shared fill library, two adapters.**

```
@bot/shared/fill-simulator/
  FillSimulatorCore   // pure functions
  HistoricalFillAdapter  // backtest: replay with complete tick paths
  StreamingFillAdapter   // PAPER: live event-time
```

**SL/TP evaluation is event-driven, never timer-driven.**
The `StreamingFillAdapter` evaluates intra-bar SL/TP triggers on **tick
arrival** from the live WS feed, not via wall-clock `setTimeout`.

**Causality test:** at time `t`, the streaming adapter cannot read tick /
book-snapshot data with timestamp `> t`.

**The M7 backtest is rerun against the extracted core** as the R0.5
validation step — any divergence is a blocker.

**Equivalence is numerical, not byte-for-byte.** The equivalence test
asserts per-field numerical equality on `simulated_fill` rows with
documented tolerance for fields where order-dependent serialization is
unavoidable.

#### D16 — Paper-state source-of-truth (per datum)

| Datum | Source-of-truth in PAPER |
|-------|--------------------------|
| Open paper-position state | `paper_account_state` |
| Closed paper-trade PnL | `paper_account_state_history` |
| Fees / funding / slippage | columns on `paper_account_state_history` |
| Risk-day trade count | computed from `paper_account_state_history.closed_at` per D10 |
| Account equity curve | snapshot rows in `paper_account_snapshots` |
| Read-API dashboard display | read from the four paper tables (separate read-API filter `mode=paper`) |
| Soak-exit evaluator input | read from `paper_account_state_history` exclusively |

**Unrealised PnL is derived, not state.** `unrealised_pnl` is computed on
demand, never persisted. The `paper_account_state` table holds only state
that is genuinely position-defining.

**Atomicity guarantee.** Every paper fill writes to
`paper_account_state` (current state mutation) + `paper_account_state_history`
(closed-trade record if applicable) + `paper_state_audit`
(HMAC-chained audit) in **one transaction**.

#### D17 — Shadow randomness: independence + paired common-random-numbers

**Decision: separate active execution from offline comparison.**

- **Active PAPER execution** uses deterministic, idempotent per-version
  order seeds. Each version's actual decisions are scored independently.

- **Offline same-event strategy comparison** uses a **pre-registered
  Common Random Numbers (CRN) scheme** keyed by
  `(event_id, simulator_component, pair_id)`.

**Per-soak CRN root:**
```
soak_start_id     = uuid generated at soak start
bootstrap_at_start = bootstrap_secret captured at soak start (immutable for the soak)
crn_root          = HKDF(bootstrap_at_start, info='paper_crn v1', salt=soak_start_id)
crn_tape[i]       = HMAC(crn_root, event_id_i || simulator_component_i || pair_id_i)
```

`bootstrap_at_start` is **never persisted in plaintext**; only its
fingerprint (e.g. SHA-256) goes into the audit row.

**Commit-reveal audit-row pattern.** At soak start, write a single audit
row to `paper_state_audit` under a dedicated subkey:
```
crn_commitment = HMAC(crn_root, soak_start_ts
                              || bootstrap_at_start_fingerprint
                              || symbol_universe_hash
                              || pair_list_hash
                              || PAPER_STARTING_EQUITY_USDT)
```

Only the commitment goes into the audit row pre-soak. The CRN tape itself
is **not revealed mid-soak**. The tape is materialised by the evaluator
post-soak from `crn_root`; the commitment row binds it.

**Skip-case pairing.** v1 and v2 generally produce different order intents
on the same event. The paired difference series must handle events where
only one version traded.

**Roll consumption rule.** Per `(event_id, simulator_component)`, the CRN
roll is consumed by **whichever version trades**. If both trade, they
consume the same roll (true pairing). If only one trades, the roll is
consumed by the trader.

**Two evaluator outputs + inconclusive truth table:**
The soak-exit report produces two CIs on `E[v1] − E[v2]`:

1. **Paired CRN CI**: same simulator rolls on the same events.
2. **Independent-noise robustness CI**: each version's actual decisions
   scored under independent rolls.

Truth table for the "active version beats shadow v2/v3" criterion:

| Paired CRN CI | Independent-noise CI | Result |
|--------------|---------------------|--------|
| Decisive, v1 wins | Decisive, v1 wins | **Pass.** |
| Decisive, v1 wins | Decisive, v2 wins | **Fail.** |
| Decisive, v1 wins | Inconclusive | **Inconclusive.** |
| Inconclusive | Decisive | **Inconclusive.** |
| Both inconclusive | — | **Inconclusive.** |

---

## Why split M11

The original M11 conflated two very different problems:

1. **Operate the bot safely on hardware you already own**, against Binance demo
   trading, for weeks, while you observe whether the strategies actually work.
2. **Move the same stack to a cloud with managed Postgres, private networking,
   secret manager, static egress IP, multi-instance, external reverse proxy.**

For an account sized $500–$1,000 with a target of survival over returns, paying
$30–60/mo in infra before there is *any* evidence of live edge is negative-EV.
The local soak is the gating experiment; the cloud topology is the prize you pay
for only if the experiment succeeds.

## Wave structure

M11a runs in explicit waves so cross-cutting contracts land before consumers,
matching the dispatch rules in `docs/best-practices/dev-qa-cycle.md`.

| Wave | Owner | Content |
|------|-------|---------|
| **W0** | `bot-shared-maintainer` (+ `bot-architect` for ADRs) | Shared contracts: `ExchangeEnvironmentEnum`, `IKeyPermissionSnapshot`, `IExchangeClient.fetchKeyPermissions()`, `ILiveModeProfile`, `LIVE_GO_AHEAD_TOKEN` config gate |
| **W1** | `bot-engine-nestjs` | Exchange & key safety, auth rotation, demo-trading client switch |
| **W2** | `bot-engine-nestjs` | M6 pre-go-live blockers (2.2.3 / 2.2.5 / 2.2.7) + soak-blocking pre-M11 deferred items |
| **W3** | `bot-devops` (+ `bot-scribe` for runbook) | Local deployment posture (bind policy, backups, retention, host hardening, runbook) |
| **W4** | main session (operator) | Soak start: restricted-profile commit, calibration day, crash-recovery drill, soak runs |

## W0 — Shared contracts (BLOCKING all other waves)

**Owner:** `bot-shared-maintainer`; ADRs by `bot-architect`.

The previous draft of M11a leaned on a binary `EXECUTION_MODE` plus the
`disableFuturesSandboxWarning` toggle to distinguish testnet from "live." That
shape cannot express demo trading and cannot enforce the demo→live invariant.

- **W0.1 — `ExchangeEnvironmentEnum`.** Add the enum
  `{ TESTNET, DEMO, LIVE }` to `packages/shared/`, replace every existing
  testnet/live branch in engine config, exchange clients, and execution policies
  to switch on it, and add a config-loader validation that:
  - rejects an unset value (no silent defaults);
  - requires `EXCHANGE_ENV=LIVE` to be paired with a separate `LIVE_GO_AHEAD_TOKEN`
    file whose hash matches a value baked into config at build time;
  - emits a loud Telegram alert at boot containing the resolved env + API-key
    fingerprint (first/last 4 chars of the public key only — never the secret).
  - *Output:* every place that previously branched on testnet/live now reads the
    enum; `EXCHANGE_ENV=LIVE` cannot boot from a config edit alone.
- **W0.2 — `IKeyPermissionSnapshot` + `IExchangeClient.fetchKeyPermissions()`.**
  Define the shared shape returned by the assertion query. Snapshot must
  include: `enableReading`, `enableFutures`, `enableSpot`, `enableWithdrawals`,
  `enableInternalTransfer`, `permitsUniversalTransfer`, `enableMargin`,
  `enableVanillaOptions`, `enableSubAccountManagement`, `ipRestrict`,
  `ipAllowList`, `tradingAuthorityExpirationTime`. Add a small ADR documenting
  which ccxt path (`sapiGetAccountApiRestrictions` for spot vs futures-private
  endpoints) returns each field — ccxt does **not** uniformly surface Binance
  futures restrictions, so this is an explicit port, not a unified-method call.
  - *Output:* a documented port that lets W1 implement the assertion without
    hand-rolling `privateGet*` calls inside `CcxtBinanceExchangeClient`.
- **W0.3 — `ILiveModeProfile`.** Promote the restricted-profile JSON (currently
  inline) to a shared schema so config and runtime cannot drift. Validate at
  boot via Zod.
  - *Output:* the restricted profile is a typed contract; field renames cause
    compile errors, not silent drift.
- **W0.4 — `EXCHANGE_NOT_IN_DB` reconciliation event shape.** Cited by M6 W4b
  but never elevated to shared package; needed for the abort-threshold logic in
  W4. Add the event to shared.
  - *Output:* the soak runbook can listen for this event by typed name.
- **W0.5 — Shadow-decisions contract.** W4.2 routes v0/v2/v3 over the same
  `event_id` tape that v1 sees but never executes them. The recording shape
  must land in W0 so W4 has nothing left to design. Pick **one** in the plan
  now (rejecting the other two with one line of rationale):
  1. **New `shadow_decisions` table.** Owned by the decisions module, columns
     mirror `decisions` plus `shadow_version`, `virtual_slot_state_snapshot`,
     `simulated_fill` (jsonb — see schema below). **Recommended** — keeps the
     high-volume `decisions` table free of nullable shadow-only columns and
     avoids retention-policy collisions with real decisions.

     `simulated_fill` JSONB schema (pinned inline so the table is queryable
     without inspecting code; mirrors the M7 fill-simulator output):
     ```ts
     interface ISimulatedFill {
       entryPrice: string;          // decimal
       exitPrice: string | null;    // null until close
       slippageEntryPct: string;    // decimal, signed
       slippageExitPct: string | null;
       slippageComponents: {
         tierBase: string;
         latency: string;
         crossingSpread: string;
       };
       missed: boolean;             // true if simulator skipped the fill
       forceClose: boolean;         // true if closed by end-of-window rule
       lowFidelity: boolean;        // mirrors M7 IBacktestReport
       closedAt: string | null;     // ISO timestamp of simulated close
       closeReason: 'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | null;
     }
     ```
  2. Add `shadow_version` + `executed` to `decisions`. Rejected: pollutes the
     hot table and forces every existing query to filter on `executed=true`.
  3. Sidecar JSONL log file. Rejected: untyped, not queryable from the read
     API, fails the "criteria must be measurable from recorded data" rule.
  - *Output:* migration + repository + entity for `shadow_decisions` landed in
    W0; downstream waves consume the typed contract.
- **W0.6 — Shadow counterfactual + fill-simulator contract.** Two independent
  reviewers flagged that shadow comparison is statistically unsound without
  these two pieces. Define both in W0 so W4.2 is fully specified:
  1. **Independent virtual slot ledgers per shadow version.** Each shadow
     version maintains its own `IVirtualPositionLedger` honouring the same
     restricted-profile gates (`max_open_positions: 1`, `halt_after_consecutive_losses: 2`,
     `max_trades_per_day: 3`, exhaustion-confirmation, market-stress skip).
     A shadow version is **not** filtered by v1's slot state — it is filtered
     by its **own** ledger evaluated against the same event tape. This is the
     counterfactual: "what would version X have decided with its own state at
     this event."

     **Shadow-close semantics (pinned in the W0.6 ADR):** the
     `halt_after_consecutive_losses` and `max_trades_per_day` gates require a
     definition of "loss" and "day" for the virtual ledger. Pin to M7's
     existing rules — a shadow position closes on simulated SL/TP hit
     (intra-bar stop), on M7's end-of-window force-close, or when a reverse
     signal would have been routed by the same version. "Day" follows the
     existing `risk_day` boundary used by the live limiter so the gate
     behaves identically to v1's. Without these pins the two gates produce
     different shadow behaviour across runs.
  2. **Shadow decisions are scored by replaying through the M7
     `BacktestRunnerService` fill simulator** (tier slippage + latency +
     missed-fill + intra-bar stops) before any comparison metric is computed.
     Raw "if it had filled at decision price" PnL is **forbidden** as a
     comparison input — it ignores adverse selection, partial fills, and
     spread, and would trivially beat v1's realised PnL by construction. An
     ADR captures the rule.

     **`lowFidelity` propagation (mirrors M8 ADR-0019 criterion 12):** every
     shadow trade carries the M7 `lowFidelity` flag (currently always true
     until the depth-aware extension lands). The shadow-comparison report
     must produce **two** rankings — one over all shadow trades, one
     excluding `lowFidelity` trades — and the "active version beats shadow
     v2/v3" exit criterion requires the **same winner on both**. If they
     disagree, the criterion is marked inconclusive and downgrades to the
     v1-only expectancy CI gate.
  - *Output:* `IVirtualPositionLedger` interface in shared, ADR locking the
    counterfactual + fill-simulator pipeline + shadow-close semantics +
    `lowFidelity` propagation; W4.2 references each by name.
- **W0.7 — `risk_state.updated_at` server-side timestamp migration.** W2.4
  consumes a true server-side `updated_at` (`DEFAULT now() ON UPDATE`); verify
  the column shape today, and if it is derived (TypeORM `@UpdateDateColumn`
  client-side) rather than server-set, the migration belongs here in W0, not
  in the W2 consumer wave. Skip this task entirely if the column is already
  server-side; record the verification result (column shape + decision) in
  `docs/work-log.md` under the M11a W0 entry either way.
  - *Output:* the W2 consumer fix lands against a contract that already
    enforces newer-wins at the database, not at the application layer.

## W1 — Exchange & key safety + auth rotation

**Owner:** `bot-engine-nestjs`. Consumes W0 contracts.

### Exchange

- **W1.1 — PAPER mode engine-local paper trading.** Per D1–D17 above:
  CcxtBinanceExchangeClient subscribes to **live** `fapi.binance.com` for
  market data in PAPER mode. Orders are intercepted and routed to
  `PaperFillSimulator` (D15) using the M7 fill-simulator core. Account state
  is simulated locally by `PaperAccountStateService` (D16). Reconciliation
  includes the nullity probe (D13) to catch accidental order leaks.
  - *Output:* engine simulates fills locally against live order-book depth
    via the shared `FillSimulatorCore`, never writes to a real Binance account.
- **W1.2 — Startup key-permission assertion (mode-aware allowlist).** Implement
  `verifyKeyPermissionsOrAbort()` on engine boot per D8. **Allowlist, not denylist:**
  - **TESTNET:** skip (audit `KEY_PERMISSION_ASSERTION_SKIPPED`, no exchange call).
  - **PAPER:** abort startup unless the snapshot has `{ enableReading: true,
    enableFutures: false }` and **every** other capability flag is false. Abort
    if `ipRestrict !== true`, `ipAllowList` is empty, or
    `tradingAuthorityExpirationTime` is in the past or unset. (D8 Fallback
    Profile: dedicated zero-balance sub-account with `enableFutures: true` is
    permitted; the engine enforces sub-account invariants at D13 probe time.)
  - **LIVE:** identical to current; abort if key has `enableFutures: false`.
  - *Output:* a key with `enableFutures: true` in PAPER or `enableFutures: false`
    in LIVE prevents startup; an empty IP allow-list does the same; an expired
    trading-authority does the same (both modes share IP-restrict + authority
    checks).
- **W1.3 — WebSocket resilience verification.** Reconnect-with-backoff already
  exists (M1 `MarketDataModule` + M6 W2 `SubscriptionRetainer`). The M11a task
  is to **verify under simulated 10-minute drop**, confirm the existing Telegram
  alert fires on stall detection, and write the verification into the soak
  runbook. No new code expected unless the verification surfaces a gap.
  - *Output:* documented drill result; any gap raised becomes a follow-up.
- **W1.4 — Rate-limit guards (ADR + implementation).** ccxt's `enableRateLimit`
  does not express Binance's per-IP / per-UID / per-symbol order-weight
  classes. Architect ADR defines the in-engine token-bucket policy (one bucket
  per weight class); engine implements + wires reconciliation polling and
  funding poll through it.
  - *Output:* no rate-limit bans under burst conditions; ADR committed.

### Auth rotation (pre-M11 deferred items pulled in)

These bite under a multi-week run, not a 10-minute smoke:

- **W1.5 — `AuthFailureReasonEnum.BAD_SIGNATURE` split.** Separate signature
  failures from other auth failures in audit + metrics + Telegram alerts.
- **W1.6 — `revoked_jti` TTL prune + age-floor.** Scheduled prune so the table
  stays bounded; floor so a still-valid JWT cannot out-live its revocation
  entry. ADR clarifies the relationship between prune TTL and JWT lifetime.
- **W1.7 — HKDF cursor sub-key derivation.** Separate keys for cursor encryption
  and auth signing.
- **W1.8 — Bootstrap-secret rotation procedure.** Procedure (no code if it's
  config-only) for rotating the ADR 0027 bootstrap secret without operator-
  visible downtime. The soak runbook (W3) schedules at least one rotation in
  the soak window so the path is exercised, not just implemented.
- **W1.9 — Login rate-limiter state persistence.** Currently in-memory; an
  engine restart re-opens a brute-force window. Persist to Postgres (cheapest
  path; Redis is already in compose but the limiter does not currently use it).
  - *Output:* a restart preserves lockout counters; documented test.
- **W1.10 — `TRUSTED_PROXY_HOPS=0` pinned in `.env.example` + parity test.**
  M10 added XFF spoof rejection; once M11b adds an external reverse proxy this
  regresses silently. Pin the value to `0` for M11a (no external proxy) and add
  an integration test that fails CI if the limiter ever trusts an untrusted hop
  at this setting.

### Telegram redaction

- **W1.11 — Telegram + log redaction sweep.** pino redact must cover
  `*.telegram.token` and `req.url` for `api.telegram.org`; the alert formatter
  uses a field whitelist, not a blacklist. Verify error payloads on retry
  cannot leak the bot token in the URL path.
  - *Output:* documented redaction rules + a test asserting a synthetic payload
    cannot exfiltrate the token.

## W2 — M6 pre-go-live blockers + remaining soak-blocking items

**Owner:** `bot-engine-nestjs`.

These were left open at M6 close and labelled "M7 validation before M8 live."
The soak **is** the live validation, so they must land before W4 starts.

- **W2.1 — M6 blocker 2.2.3: exposure clamp-at-zero silent.** Add the alert
  + correctness fix so a clamp event surfaces in Telegram and audit.
- **W2.2 — M6 blocker 2.2.5: adoption slot-A misallocation.** Fix the slot
  selector so reconciliation-driven adoption picks the correct slot.
- **W2.3 — M6 blocker 2.2.7: `setOpenExposureFromBoot` post-boot guard.**
  Guard against post-boot calls that would overwrite live state.
- **W2.4 — `risk_state.updated_at` true newer-wins.** Rationale: the M9 R2
  crash-recovery race between bootstrap restore and a still-running write,
  *not* multi-instance (M11a explicitly excludes multi-instance — that is
  M11b). Fix the timestamp source so tie-break is deterministic.
- **W2.5 — `LiveGateway` AppConfigService injection + parser parity test.**
- **W2.6 — `notePragmaticTransition` cleanups.** Clamps + try-block ordering +
  `startOfRiskDayMs` init + `lastTransitionAuditId` JSDoc.
- **W2.7 — Cache-Control on halt/history endpoints.**
- **W2.8 — AUTH token TTL comment.** One-line edit adjacent to W1.5 work;
  pulled forward from the deferred list because it lives next to BAD_SIGNATURE.
- **W2.9 — pino-pretty dev-arg fallback (engine-side).** Detect missing pretty
  transport at logger init and fall back to JSON with a warning; the Dockerfile
  forced-flag can then drop. Defence in depth so a prod image accidentally
  booted with `NODE_ENV=development` does not crash.

Other pre-M11 deferred items (BaseRepository uuid-PK widening,
strategy-comparison UI) are **not** soak-blocking and remain deferred.

## W3 — Local deployment posture

**Owner:** `bot-devops` (compose, Dockerfile, healthchecks); `bot-scribe`
authors `RUNBOOK.md`.

### Compose changes (concrete, file:line)

The current `docker-compose.yml` publishes engine, dashboard, adminer, and
postgres on `0.0.0.0`, contradicting the bind policy. W3 lands all of:

- **W3.1 — Engine bind.** `docker-compose.yml:90-93` — replace
  `ports: ["${ENGINE_PORT:-3000}:3000"]` with `expose: ["3000"]`. The dashboard
  reaches the engine over the compose network; the container HEALTHCHECK runs
  inside the container and is unaffected. Document host-side debugging via
  `docker compose exec engine wget -qO- localhost:3000/v1/health`.
- **W3.2 — Dashboard bind.** `docker-compose.yml:112-113` — prefix with
  `127.0.0.1:` so it is not reachable from LAN/Wi-Fi peers.
- **W3.3 — Postgres bind.** `docker-compose.yml:15-16` — prefix with
  `127.0.0.1:` (or drop the host mapping entirely; engine reaches DB on the
  compose network).
- **W3.4 — Adminer bind (superseded).** Originally a loopback-bind hardening
  task. Superseded by **W3.16 (adminer removal)** — binding a service we are
  about to delete is dead work. Kept in the list as a numbered placeholder so
  prior commits / cross-references do not shift.
- **W3.5 — Engine network topology.** Two-network shape — flagged independently
  by architect + devops + security as a "soak won't boot" bug if implemented
  as a single `internal: true` network:
  - `backend` network with `internal: true` — postgres + redis only. No
    external egress; no other container can reach them.
  - default bridge network (`internal: false`) — engine + dashboard. Engine
    needs outbound TLS to `fapi.binance.com` and `api.telegram.org` plus
    external DNS; `internal: true` would break trading.
  - **Engine attaches to both networks**, postgres + redis attach only to
    `backend`, dashboard attaches only to the bridge.
  - Host loopback exposes only the dashboard's nginx (W3.2).
  - Daemon-level `icc=false` is a host-hardening item (W3.12), not a compose
    change.
- **W3.6 — Graceful shutdown + core-dump suppression.** `stop_grace_period: 30s`
  on the engine so SIGTERM has time to close WS, cancel in-flight orders, and
  flush `FillAccumulator`. Verify NestJS `enableShutdownHooks` is on. Add a
  small `docker-entrypoint.sh` that runs `ulimit -c 0` then `exec node
  dist/main.js`; update the Dockerfile to use it as `ENTRYPOINT`. Optionally
  call `prctl(PR_SET_DUMPABLE, 0)` via a tiny native shim or process-level
  setting for defence in depth.

  **Not in scope:** in-process API-secret zeroing. JavaScript strings are
  immutable and V8 retains copies in interning + the compiled-code cache; a
  `Buffer.fill(0)` on a value derived from a string only wipes a downstream
  copy, not the originals. The combination of `ulimit -c 0`, encrypted swap
  (W3.12), and `PR_SET_DUMPABLE=0` is the real protection. Document
  explicitly that in-process secret scrubbing is **not** a goal so the
  implementer does not ship security theatre.
- **W3.7 — `start_period: 60s`** on the engine healthcheck so the M6 10-phase
  crash-recovery cold start does not flap.
- **W3.8 — `env_file:` only — verify + CI lint.** Confirmed today
  (round-3 devops): no secret is inlined in `docker-compose.yml`; engine +
  migrator already use `env_file: [.env]`. Reframed from "convert" to
  "verify + add a CI lint" that fails on any future `environment:` block
  whose value matches a known secret-key name (`*_API_KEY`, `*_SECRET`,
  `*_TOKEN`, `JWT_*`, `BOOTSTRAP_*`). Prevents drift, no-op work avoided.
- **W3.16 — Remove adminer service entirely.** Delete the `adminer` service
  from `docker-compose.yml:124-130` (currently behind `profile: dev`). Even
  profile-gated, adminer is a real attack-surface item under a multi-week
  soak:
  - it holds full Postgres super-credentials in its env, so anyone reaching
    its bind (`docker` group, root, tailnet ACL slip, accidental `0.0.0.0`)
    has unaudited read/write to `decisions`, `positions`, `audit_events`,
    `revoked_jti` — bypassing every M9 audit guard;
  - it is a single-file PHP login form with file uploads and a non-trivial
    CVE history; a stale image during the soak is exposure;
  - profile gating is honour-system — one accidental
    `docker compose --profile dev up` and it stays running until manually
    torn down.

  Operator DB access is unaffected: connect any local tool (`psql`, DBeaver,
  TablePlus, DataGrip) to `127.0.0.1:5432` after the W3.3 loopback bind, or
  `docker compose exec postgres psql -U …`. Add this line to W3.15
  `RUNBOOK.md` as the documented inspection procedure.
  - *Output:* `adminer` service removed from compose; no `dev` profile left
    referring to it; runbook updated; smoke-test confirms `docker compose ps`
    shows no `adminer` container under any profile.

### Backups

- **W3.9 — Backup + restore sidecars.** Add two compose profiles. Note that
  `postgres:18.4-alpine` has neither `age` nor `rclone` — bake a small custom
  image and pin it in the compose file. **Pin the apk package versions** so
  an Alpine package refresh mid-soak cannot change the encryption tool under
  the cron:
  ```dockerfile
  FROM postgres:18.4-alpine
  # Pin to the versions current at soak-start; bump in a deliberate edit.
  RUN apk add --no-cache age=~1.2 rclone=~1.68
  ```
  - `profiles: [backup]` — runs
    `pg_dump -h postgres … | gzip | age -r <pubkey> | rclone rcat b2:bucket/path`.
    Driven by host-cron `0 3 * * * docker compose --profile backup run --rm pgbackup`.
  - `profiles: [restore-test]` — spins a throwaway postgres + `pg_restore`
    from the latest dump and asserts row counts on `decisions`, `positions`,
    `audit_events`. Host-cron weekly.

  **`age` key custody (mandatory):**
  - **Public key committed in-tree** at `infra/backup/age-recipient.pub` so
    the recipient baked into the compose profile is tamper-evident under
    `git log` rather than hidden inside a gitignored file an attacker with
    `.env` write access could silently rotate.
  - **Private key on two independent hardware devices**, one offsite. A
    YubiKey + an offline encrypted USB on a separate physical site is the
    documented baseline. Loss of both is loss of the backups; document the
    recovery procedure (rotate to a new pubkey + re-encrypt the most recent
    on-host dump before the old pubkey is forgotten).
  - **Quarterly decrypt-drill** added to W4.3: pull the latest off-host
    dump, decrypt with the primary private key, restore into a throwaway
    container, assert row counts. A drill that has never restored from the
    *offsite* copy is not a tested backup.
  - *Output:* documented backup + restore procedure; key-custody section in
    `RUNBOOK.md`; last successful on-host + offsite restore timestamps
    recorded.

### Disk + retention

Per the devops review, sizing estimate: `decisions` ≈ 5–10M rows / 3–6 GB over
60 days at single-symbol ceiling; `account_snapshots` and `audit_events`
negligible; alert log unbounded under retry spikes; `tick_aggregates` already
has partition rollover (M2/M8 W0).

- **W3.10 — Retention SQL.** Retention floors must not collide with the
  soak-closeout evidence window — a 60-day prune over a 60-day soak strips
  day-1 evidence on day 60 when the exit-gate evaluator runs. Apply
  `soak_duration + 30 days` as the floor for tables that feed the exit gate,
  and a tighter floor for the rest.
  - `decisions`: floor at **soak-duration + 30 days** (so a 60-day soak
    retains ≥90 days). Pruning runs but excludes any `created_at` newer than
    that floor. The exit-gate evaluator (W4) reads `decisions` for the
    expectancy + per-regime breakdown; pruning evidence under it produces a
    false inconclusive.
  - `account_snapshots`: same floor — feeds drawdown abort-threshold +
    soak-window equity curve.
  - `audit_events`: **archive, not prune** — copy expired rows to a separate
  - `audit_events`: **archive, not prune** — copy expired rows to a separate
    table or off-host archive before deletion. Security audit trail must be
    append-only for the soak window.
  - Telegram alert log: bound by row count (keep most recent N), not age.
  - Document projected disk growth in `RUNBOOK.md`.

### Host hardening + secrets

- **W3.11 — `.env` permissions.** `chmod 600 .env`; add `make check-env-perms`
  helper that fails if the file is group/world readable. `.env` is already
  gitignored (`.gitignore:25-28`).
- **W3.12 — Host hardening checklist.** Full-disk encryption (including
  swap — call this out explicitly because the SIGTERM handler relies on it);
  OS auto-updates; SSH key-only; unattended-upgrades for security patches;
  host firewall denies inbound by default; daemon `icc=false`; neutral
  hostname (no `tradebot.local` mDNS broadcast).
  - *Output:* one-page host-setup checklist in `RUNBOOK.md`.
- **W3.13 — Remote access via Tailscale.** `127.0.0.1` bind is unreachable
  from the tailnet by default. Mandated configuration:
  - **Tailscale runs as a host package**, not a compose service. Install via
    the OS package manager (`brew install tailscale` / distro package +
    `systemctl enable --now tailscaled`). A containerised tailscale sidecar
    inside the compose network cannot reach the host's `127.0.0.1` bind, so
    `tailscale serve` only works from the host daemon.
  - `tailscale up --shields-up`;
  - `tailscale serve` proxying to the dashboard's `127.0.0.1:<port>`;
  - ACL restricting the dashboard port to the operator's own node;
  - **Verify funnel was never enabled** (`tailscale funnel status` empty);
    funnel is off by default — the check is to confirm no prior session
    enabled it.
  Verification: nmap from a LAN peer **and** from a second tailnet node with
  the ACL applied; both must fail to reach the dashboard.
  - *Output:* documented tunnel setup + nmap verification; recorded in runbook.
- **W3.14 — Power + network resilience.** UPS sized for ≥10 min runtime,
  triggering graceful shutdown via NUT or apcupsd. Document expected behaviour
  on full power loss (engine restarts, M6 crash-recovery pipeline rebuilds
  state from Postgres + exchange). Drill once; record recovery time.

### Runbook

- **W3.15 — `docs/operations/RUNBOOK.md`** (fixed path so the scribe does not
  create duplicates) covering:
  - daily check (what to look at in dashboard + Telegram);
  - which alerts are "look now" vs "look tomorrow";
  - halt + drain + resume;
  - strategy-version rollback;
  - **key-compromise / token-rotation procedure** (suspected leaked exchange
    key or API token);
  - **bootstrap-secret rotation procedure** (W1.8);
  - **soak abort triggers** (see W4);
  - **demo → live transition checklist** (the two-token boot procedure from
    W0.1);
  - "do not run `docker compose config` outside a redirected shell" rule
    (renders interpolated env to stdout).

## W4 — Soak operations

**Owner:** main session (operator); `bot-engine-nestjs` only if a drill surfaces
a code gap.

- **W4.1 — Restricted v1 profile committed as soak config.**

  ```json
  {
    "live_mode": "restricted",
    "max_open_positions": 1,
    "max_coin_tier": 1,
    "risk_per_trade_pct": 0.25,
    "allow_mean_reversion": true,
    "allow_momentum": false,
    "require_exhaustion_confirmation": true,
    "require_oi_available": true,
    "skip_fresh_universe_entrants": true,
    "skip_market_stress": true,
    "max_trades_per_day": 3,
    "halt_after_consecutive_losses": 2,
    "margin_mode": "isolated"
  }
  ```
  - `risk_per_trade_pct` is in **percent** (0.25 = 0.25% of account equity).
  - Validated against `ILiveModeProfile` (W0.3) at boot.
  - No daily profit target.

- **W4.2 — Shadow-mode dry-run for v0/v2/v3 over the soak window.** v0 is
  no-trade by definition, so the M8 paired-bootstrap CI has no v0 outcome
  series to resample against v1. To produce a meaningful comparison without
  routing v2/v3 to the exchange, run them in **shadow mode** over the same
  `event_id` tape v1 sees — strategies emit decisions, the orchestrator
  records them into the `shadow_decisions` table from **W0.5**, and the
  soak-evaluation tool reads them like a backtest.

  Two contracts from W0 are load-bearing here; the comparison metric is
  invalid without both:
  1. **Independent virtual slot ledgers per shadow version** (W0.6.1). Each
     shadow version is gated by its **own** `IVirtualPositionLedger`, not by
     v1's slot state. A shadow version decides on every event using its own
     restricted-profile gates; this is the only counterfactual that produces
     a fair comparison.
  2. **Shadow decisions are scored by replaying through the M7
     `BacktestRunnerService` fill simulator** (W0.6.2). Raw "filled at
     decision price" PnL is forbidden — it ignores adverse selection,
     partial fills, latency, and spread that v1 actually pays, and would
     trivially beat v1 by construction.

  The "active version beats shadow v2/v3" soak exit criterion (below) is
  **suspended** if either W0.6 contract is missing at soak-start; the soak
  still runs but the comparison is downgraded to "expectancy CI excludes
  zero on v1 alone" until both ledgers + fill-simulator pipeline are in
  place.
  - *Output:* `shadow_decisions` rows for each non-executed version over
    the soak window, each carrying a simulated-fill record from the M7
    fill simulator; the soak-evaluation tool produces per-version
    expectancy + per-regime metrics + paired-bootstrap CIs on the
    differences.

- **W4.3 — Crash-recovery drill — recurring.** Three scenarios, executed once
  before soak start **and** monthly during the soak, **and** after any auth
  secret rotation or config change touching M6 ADR-0014 phase 1 reads:
  1. Engine `SIGKILL` mid-fill — verify position, protective orders,
     reservation ledger reconcile against Binance demo state on restart.
  2. Postgres restart with engine running — verify the engine reconnects and
     state is consistent.
  3. Binance WS drop exceeding the reconnect-backoff ceiling — verify the
     stall alert fires and the engine recovers without operator action.
  Each drill verifies the W2.1/W2.2/W2.3 fixes did not regress (zero-clamp
  alert fires, slot adoption is correct, post-boot guard rejects writes).

  **Drill recency for soak closeout:** a soak ending on day 45 with the last
  drill on day 30 is 15 days stale. Tighten the cadence to **≤21 days**, and
  require an additional drill in the **final 7 days** of the soak before
  closeout evaluation. Bundling a routine drill with an auth-rotation drill
  (W1.8 bootstrap-secret rotation or JWT rotation) into a single operational
  window is allowed and encouraged — counts as one drill, not two.

- **W4.4 — Calibration day + pre-soak sanity + sample-size pre-flight.**
  Before the soak proper begins:
  1. **Disk sizing.** Record 24h of growth on `decisions`, `tick_aggregates`,
     `account_snapshots`, `audit_events`, Telegram alert log, and project × 60 days.
     If projection exceeds host disk headroom, adjust retention in W3.10 and re-measure.
  2. **Pre-soak sanity step (asymmetric TOST equivalence per D10 lowFidelity).**
     Run the simulator over the prior 60 days (or extended 90–120 days if needed
     per calibration-window extension allowance) with:
     - Strategy v0 (zero-edge baseline).
     - Small panel of diverse zero-edge policies (random direction, alternating,
       spread-only entries).
     Compute the **90% CI on residual expectancy in risk units**:
     `residual_R = residual_expectancy / per_trade_risk_budget`.
     Tolerance band, asymmetric (per D10):
     - `ε_upper = 0.05 R` (strict on optimistic bias).
     - `ε_lower = −0.15 R` (looser on pessimistic bias).
     **Pass criterion:** the 90% CI on `residual_R` must lie within `[ε_lower, ε_upper]`.
     If outside the band, the runbook documents the decision: extend the calibration
     window or accept the soak as exploratory only with operator sign-off.
     **Power check:** calibration sample must produce at least 200 simulated fills,
     otherwise test is inconclusive and window is extended.
  3. **Soak sample-size pre-flight.** Compute:
     - Per-trade variance attributable to missed-fill + slippage rolls (N=1000 runs).
     - **Also report `Var(E[v1] − E[v2])` across the same N=1000 paired runs.**
     - Derive the minimum detectable effect size at n=80 with α=0.05 from the
       paired-difference variance.
     If the MDE exceeds the historical between-version expectancy gap on backtest,
     the soak is statistically underpowered. Trade floor must be raised or the soak
     is acknowledged as exploratory.

- **W4.5 — Soak runbook dry-run.** Operator executes the runbook's daily check
  + halt + drain + rollback + key-rotation procedures against a test fixture
  before the soak proper starts. Catches doc drift before it bites in an
  incident.

- **W4.6 — PAPER sub-account creation & key fingerprint.** Operator creates a
  dedicated zero-balance Binance USDT-M Futures sub-account, generates the
  PAPER key with `enableReading + enableFutures` only, IP-restricts it to the
  soak-host IP, sets a non-null trading-authority expiry, and records the key
  fingerprint (first 4 + last 4 chars of the public key) in the operator log.
  See ADR 0032 §D8 (Fallback Profile) for the full sub-account invariant spec.
  **Operator runbook mandatory step:** Verify the sub-account key's IP allow-list
  via Binance UI (Sub Accounts → sub-account → API Management → Edit → IP
  Restriction). Binance no longer exposes a self-readable IP-list endpoint; the
  engine's predicate only verifies `ipRestrict: true` (whitelist set or not), not
  which IPs. Manual verification closes the gap.

## TESTNET pre-M11b drill (complementary, required gate)

PAPER validates strategy / risk / operational behaviour on live market data,
but **never** exercises Binance's order-placement contract — order acceptance,
rejection, partial fills, cancel semantics, protective-order behaviour at the
matching engine. Those still need **Binance Futures testnet** to drill.

TESTNET is therefore a separate **required gate** before M11b, run after
PAPER soak success. Scope:
- Place / cancel / open / close / protective-order lifecycle on Binance
  testnet; assert every state transition matches the engine's state
  machine.
- Reconciliation against exchange state — `PaperReconciliationAdapter`
  is not exercised; the live `ExchangeAccountStateSource` path is.
- Rate-limit policy under harmless burst load (W1.4 token bucket against
  testnet REST + WS).

PAPER and TESTNET are complementary:
- **PAPER**: live-market operational + statistical soak.
- **TESTNET**: exchange execution-contract drill.

M11b begins only when **both** have passed. Soak runbook records this as
two independent green checks; ADR 0032 codifies the requirement.

---

## Soak exit criteria → M11b

**Note (2026-05-27):** the cloud go-live milestone was renumbered M11b → M15. References to "M11b" in this document refer to the same milestone, now at `docs/plans/M15-cloud-go-live.md`.

The soak is the gate, not a deadline. M11b is entered only when **all** of the
following hold:

- **Duration: 45-day minimum, 60-day target.** Stop at 45 only if every other
  criterion is comfortably met; otherwise run to 60.

- **Minimum trade count: ≥80 closed trades.** Below this floor, statistical
  comparison is uninformative and the soak extends (not fails). Justification:
  with `max_trades_per_day: 3`, `halt_after_consecutive_losses: 2`, and
  exhaustion-confirmation gating, the M9 10h smoke saw 0 fills on 14
  candidates; ≥80 trades is the documented relaxation of M8's ≥200-trade
  floor for this specific soak-window evaluation.

  **Closed-trade counting (D10):** Only trades closing via `sl`, `tp`, or
  `intra_bar_stop` count toward the 80-trade floor. `force_close` exits
  (M7 end-of-window), operator drains, and reconciliation-forced closes are
  **excluded from the count** but surfaced in a separate evaluator panel for
  visibility into excluded PnL. Additionally, a simulator decision with
  `missed: true` does **not** consume the restricted profile's
  `max_trades_per_day: 3` slot.

  **Fat-tailed-returns escape clause.** Per-trade crypto PnL is not Gaussian
  — M8 ADR-0018 records skew + kurtosis precisely because the tails are fat.
  A "2-sigma" argument understates the real floor. The escape rule:
  - If the 95% bootstrap CI on v1's expectancy is **inconclusive at 80
    trades**, the soak extends to 60 days regardless of the duration
    criterion.
  - If still inconclusive at 60 days, the soak does **not** pass — it
    routes to M8 strategy iteration, not M11b. M11b requires the CI to
    exclude zero from above; an inconclusive result is a "no" for go-live,
    not a "maybe."

- **Reduced evaluation gate (soak-specific, documented).** M8's full
  12-criterion all-of promotion gate cannot run because v0 has no per-event
  outcome distribution. The soak-specific reduced gate evaluates v1 (executed)
  against shadow v2/v3 (W4.2):
  
  **Primary criterion: Active version beats shadow v2/v3** on the paired
  common-random-numbers CI (D17):
  - **Two paired cohorts (D17):**
    1. **Trade-vs-trade CRN cohort.** Both versions traded same event;
       same simulator roll. Isolates fill-noise differences and pure
       decision-edge conditional on willingness to trade.
    2. **Full same-event cohort with skip-handling.** All events where at
       least one version traded. For events where one trades and one skips,
       the skipping version's contribution is `pnl = 0`.
  - **The comparison must pass on BOTH cohorts** (D17 mirrored from ADR 0019
    criterion 12). If trade-vs-trade cohort says v1 wins but full cohort says
    v2 wins because selectivity dominates, criterion is **inconclusive.**
  - **lowFidelity behaviour (D10 / lowFidelity section):** M7's fill simulator
    currently sets `lowFidelity: true` on every fill. So **every v1 PAPER fill
    is `lowFidelity`** for the duration of M11a. The "two rankings — full-set
    + `lowFidelity`-excluded" rule becomes unsatisfiable; the `lowFidelity`-excluded
    subset is empty for v1. **Explicit downgrade:** if either side of the shadow
    comparison has an empty `lowFidelity`-excluded subset, the "active version
    beats shadow v2/v3" criterion is **automatically marked inconclusive** and
    the soak gate downgrades to "v1's own expectancy CI excludes zero" alone
    (same fail-safe as W4.2's missing-contracts downgrade).
  - **Joint-test acknowledgement.** "v1's expectancy CI excludes zero" in
    PAPER is a joint test of `(strategy edge + M7 fill model bias)`, not of
    strategy edge alone. M11b's go-live decision must treat the PAPER CI as
    a **necessary but not sufficient** condition.
  - **M11b gate hardening when all PAPER fills are `lowFidelity`** (D10 § "M11b
    gate hardening"): A positive PAPER CI under an all-`lowFidelity` simulator
    is not strong enough on its own. If soak closes with every fill flagged
    `lowFidelity`, M11a's outcome is "operational soak passed, trading edge
    still provisional." Entering M11b then requires **one** of:
    1. The M7 depth-aware extension lands, the soak is rerun, and the
       `lowFidelity`-excluded ranking is non-empty + the comparison passes
       on both rankings.
    2. A **tightly capped live micro-probe** milestone (separately planned):
       $100–$200 of real capital, one position max, one to two weeks,
       explicit stop condition (drawdown ≥ 5%, ≥1 reconciliation drift, ≥1
       unhandled rejection). M11b proper begins only after the micro-probe
       completes without triggering its stop.
    3. An **architect-approved waiver** documented in ADR 0032, stating in
       writing that the first real-money period is still validation, not
       scale-up, and naming the operator who accepted the residual risk.
  
  **Secondary criteria (all must also pass):**
  - **Net positive expectancy** on v1's executed trades (alone, excluding
    shadow comparison) with bootstrap 95% CI excluding zero.
  - **Stop / protective-order behaviour matches the M6 model** (compare
    `stop_gap_pct` + `protective_order_type` distributions to backtest).
  - **No unresolved reconciliation drift events** — defined as zero
    `IReconciliationDriftDetectedEvent` without a paired
    `IReconciliationResolvedEvent` within TTL, and zero `UNRESOLVED_TTL`
    outcomes.
  - **No unresolved crash-recovery incidents** — every drill in W4.3 passed.
  - **Successful drill in the last 30 days** — recency requirement.
  - **Auth rotation exercised**: at least one bootstrap-secret rotation +
    one JWT-signing-secret rotation completed during the soak with no
    operator-visible downtime, and `revoked_jti` stayed bounded.

- **Realized slippage recorded and recalibrated.** This is **not** a pass/fail
  criterion because M7's tier model was tuned on testnet's synthetic books;
  demo trading uses live order books with paper fills, so divergence ≠ broken
  strategy. Instead: realised slippage is recorded against the M7 model and a
  divergence outside ±50% triggers a tier-model recalibration task (folded
  into the M8 deferred depth-aware extension), not a soak failure.

- **No operator-visible halt-spam.** The soak should not require daily manual
  intervention beyond the documented daily check.

### Soak abort thresholds (stop-now triggers)

Independent of the exit criteria — hitting any of these aborts the soak and
routes to M8 strategy iteration, not extension:

- Paper-account drawdown ≥ 15%.
- Any unrecovered crash-recovery incident (drill or live).
- ≥ 3 unresolved `IReconciliationDriftDetectedEvent` in any 7-day window.
- Any `EXCHANGE_NOT_IN_DB` reconciliation event the bot did not raise.
- Any boot-time key-permission assertion failure that required operator
  override (i.e., the assertion was disabled to keep trading — never do this;
  abort the soak instead).

If exit criteria fail without an abort trigger firing, the next step is **not**
M11b — it is iterating on the strategy under M8's walk-forward / promotion
workflow, still on demo, still at $0 infra. M11b only buys hosting; it does not
improve the edge.

## Definition of done

The stack runs on a single trusted local machine against Binance live market
data (PAPER mode), with:

- W0 shared contracts landed (`ExchangeEnvironmentEnum` with TESTNET/PAPER/LIVE,
  key-permission port with mode-aware allowlist, `ILiveModeProfile`, two-token
  live-mode boot, `IAccountStateSource` + `IExecutionClient` ports, shadow
  contracts, `IBootStateSource` dispatch for crash recovery);
- key-permission assertion enforces mode-aware **allowlist** per D8 (PAPER rejects
  `enableFutures: true` on primary key; Fallback Profile with dedicated sub-account
  permitted); non-empty IP allow-list and non-expired trading authority required
  for both PAPER and LIVE;
- WS resilience verified under simulated drop, rate-limit guard policy
  implemented, PAPER mode live-market subscription complete;
- auth rotation items landed and **exercised** during the soak;
- M6 pre-go-live blockers (2.2.3 / 2.2.5 / 2.2.7) fixed and verified by W4.3
  drills;
- no `0.0.0.0` bindings; engine on an internal docker network;
- nightly encrypted-at-source backups + offsite + weekly restore-test passing;
- retention enforced per D16 + D17 (`decisions` / `account_snapshots` / Telegram
  log soak_duration + 30 days; `audit_events` archived; `boot_mode_history` +
  `boot_mode_chain_rotations` retain forever);
- `RUNBOOK.md` covering daily check, incidents, key rotation, bootstrap-secret
  rotation, soak abort triggers, PAPER→TESTNET→LIVE transition, pre-soak sanity
  step, TESTNET drill procedure;
- restricted v1 profile committed via `ILiveModeProfile`; shadow v0/v2/v3
  recording into `shadow_decisions` with simulated-fill records produced by
  the M7 `FillSimulatorCore` (via `StreamingFillAdapter` for PAPER); per-version
  comparison report generated (two cohorts — trade-vs-trade CRN + full
  same-event; two `lowFidelity` rankings per cohort per D17);
- **TESTNET pre-M11b drill** complete (order lifecycle + reconciliation +
  rate-limit policy under burst load — all green, separate gate);
- soak completed with all reduced-gate exit criteria met **or** the soak
  routed back to M8 because criteria failed without abort, **or** an abort
  trigger fired and the soak was halted;
- soak outcome bucket recorded explicitly per D10 lowFidelity section
  (operational + edge confirmed, OR operational only + edge provisional
  + one of three M11b entry paths named).

Only on full pass of PAPER soak **and** TESTNET drill does M11b begin.
