# M11a — Paper-mode addendum (DEMO → PAPER course correction)

**Status:** Draft v3 — folds round-2 review findings (architect, logic, quant,
security; zero blockers, four highs, ~15 mediums) on top of v2's locked
decisions. Replaces the `DEMO` mode introduced in W0.1 / W1.1.

**Depends on:** the rest of M11a as previously planned and partially
implemented (W0 shared contracts + W1 engine wave both landed; the rename in
this addendum is a course correction, not a restart).

**Replaces in M11a §W1.1:** the `DEMO = Binance demo trading` design, which
was based on the false premise that Binance USDT-M Futures has an
API-accessible paper-trading host separate from testnet.

## Why this addendum

W1 reviewer cycle (round 1) surfaced a blocker: ccxt's `enableDemoTrading(true)`
swaps `urls.api` to a `urls.demo` block that contains only `fapi/dapi/v1/
public/private` keys — no `sapi*` keys. `KeyPermissionAssertionService` calls
`sapiGetAccountApiRestrictions` + `sapiGetAccountApiRestrictionsIpRestriction`,
so a DEMO boot throws `fetch_error` and the engine exits.

Investigation against the current Binance developer docs and the Binance dev
forum confirmed: `demo-fapi.binance.com` and `testnet.binancefuture.com` are
aliases for the same testnet environment. No separate paper-trading endpoint
exists for USDT-M Futures. ccxt's `enableDemoTrading()` is a rename of
testnet for Futures, not a separate mode.

## The `PAPER` design

Rename `DEMO` → `PAPER` and make it an **engine-local paper-trading mode**:

- WebSocket connects to **live** `fapi.binance.com` for market data + funding
  (real prices, real depth, real spread, real OI, real funding rates).
- Orders are intercepted before reaching ccxt and routed to a local
  `PaperFillSimulator` (reuses M7 `BacktestRunnerService` fill logic on live
  event-time).
- Account state (positions, balances, margin) is simulated locally in a new
  `PaperAccountStateService`; never reads or writes a real Binance account.
- Reconciliation in PAPER mode runs against the local simulated state plus a
  periodic null-probe against the exchange (catches engine-internal drift
  **and** the worst-case "did we accidentally leak an order" failure mode).
- Key-permission assertion is **mode-aware** and **stricter** in PAPER than in
  LIVE.

## Locked decisions (folded from reviewer round 1)

The previous draft left several "Open Questions" — they are now decisions
written into the plan so R0 dispatches against a frozen contract.

### D1 — `paper_account_state` is a dedicated table

Reject the `mode` discriminator on `positions` alternative. Reasons:
- PAPER retention follows a different policy from live positions.
- Crash recovery's phase-1 reader is simpler with a dedicated table.
- No risk of a PAPER position accidentally being read by a LIVE-mode read API
  query.
- `paper_account_state` writes are restricted to the engine DB role; the
  read-API role gets `SELECT` only.

### D2 — `IExecutionClient` surface (frozen)

Split out of `IExchangeClient`. Methods:
- `placeOrder(intent: IOrderIntent): Promise<IOrder>`
- `cancelOrder(symbol: string, id: string): Promise<void>`
- `cancelAllOrdersForSymbol(symbol: string): Promise<void>`
- `fetchOrderStatus(symbol: string, id: string): Promise<IOrder>`
- `fetchOpenOrders(symbol?: string): Promise<IOrder[]>`

**`fetchPosition` and `fetchBalance` stay on `IExchangeClient`** (the
market-data + read surface), because those are also called by the
reconciliation poller against the live exchange in LIVE/TESTNET. In PAPER
mode the reconciliation adapter swaps `PaperAccountStateService` in as the
account-state source — it does not call `IExchangeClient.fetchPosition` —
but the interface boundary stays clean.

Compile-time split: `PaperExecutionClient` does **not** import the
`RateLimitPolicyService` module, so an accidental rate-limit call from PAPER
is a build-time error, not a runtime assertion.

### D3 — PaperFillSimulator determinism

Per-order PRNG seed schema:
```
order_seed = HMAC-SHA256(boot_seed, decision.event_id || symbol || order_intent_id)
```
- `boot_seed` is **derived** at boot via `HKDF(bootstrap_secret, info='paper_simulator_seed v1')`,
  not generated and stored in plaintext (security round 2 M1). Reuses the
  HKDF primitive already established in W1.7 + D6. The derivation is
  deterministic given the bootstrap secret, so the soak's seed is
  reproducible across restarts without writing it to disk. The
  `paper_account_state_meta` table stores only the **RNG cursor**
  (`last_consumed_event_id`), not the seed itself.
- Reusing the existing M7 `BacktestRunnerService` seed strategy verbatim is
  required — soak fills must be replayable identically by an offline M7 run
  against the same decision tape. The ADR 0032 cites M7's seed locking.
- Persist `(boot_seed, last_consumed_event_id)` alongside `paper_account_state`
  so a SIGKILL replay produces identical fills (within-run determinism). The
  R3.1 drill asserts a SIGKILL/restart replays the last 5 decisions to the
  exact same `simulated_fill` rows.
- Cross-version independence: v1 PAPER uses its own `order_intent_id`
  namespace; v2/v3 shadow use theirs; the same market event therefore does
  not receive correlated rolls across versions, so paired-bootstrap CIs are
  not biased toward zero.
- Simulator config is sourced **only** from the M7 `BacktestRunnerService`
  configuration that is in version control. R3.1 asserts the simulator
  refuses to start if its config file hash differs from the M7 commit-pinned
  hash. This is defence against a malicious operator tuning missed-fill
  probability to flatter v1.

### D4 — Funding ordering and math

`PaperFundingAccrualService` applies live funding rates to
`PaperAccountStateService` positions at the **Binance-published funding
timestamp**, not local processing time:
```
funding_paid = position_notional × funding_rate × side_sign
side_sign(LONG)  = -1   // longs pay when rate > 0
side_sign(SHORT) = +1   // shorts receive when rate > 0
```
`position_notional` is mark-to-market at the funding timestamp using the
live mark price (not entry price). A position is funded iff
`position.openedAt ≤ funding.ts ≤ position.closedAt` — local clock is
irrelevant.

R3.1 paired test: `side_sign(LONG) × funding_paid(rate > 0) > 0` (long pays);
`side_sign(SHORT) × funding_paid(rate > 0) < 0` (short receives).

Funding-rate ingest passes the same M1 validator chain (rate sanity bounds,
monotonic timestamps, signed-source check). The Binance cap `|rate| ≤ 0.0075`
(per-funding-window absolute cap, cite Binance source in ADR 0032 so a
schedule change does not silently desync) is enforced as a **warning, not a
hard reject** (quant round 2 M1): when exceeded, apply the rate, write an
audit row, and emit a CRITICAL Telegram alert. A simulator that silently
zeroes funding during a stress regime would flatter expectancy at exactly
the moment funding cost matters most for shorts.

Funding / PnL ordering inside a tick batch is pinned (logic round 2 M1):
`apply_funding → recompute_unrealised_pnl → evaluate_drawdown_abort`. R3.1
adds a test for a funding event coincident with an adverse mark.

### D5 — Mark-to-market cadence + drawdown denominator

PaperAccountStateService unrealised PnL is recomputed on **every WS price
tick for held symbols**, not only at decision boundaries. Restricted-profile
soak has `max_open_positions: 1`, so cost is trivial (if the profile ever
relaxes, the per-tick MTM cost must be re-validated — quant round 2 L2).

**Drawdown denominator pinned to running peak equity** (quant round 2 H1).
The drawdown abort threshold (15%) compares against `peak_equity`, not
starting equity:
```
drawdown(t) = (peak_equity(t) - equity(t)) / peak_equity(t)
peak_equity(t) = max(equity(τ)) for τ ∈ [soak_start, t]
```
With D11's $500 starting equity and 0.25% risk per trade, peak-equity
denominator means the abort fires on a true regime break, not on a routine
losing streak from a high-water mark. Re-evaluated on every WS tick.

### D6 — Mode-switch predicate + integrity

Predicate: **persisted last-known boot mode ≠ current `EXCHANGE_ENV`** →
abort with a clear error. Recorded in a new `boot_mode_history` table
written **at successful boot** (not at shutdown — crash-safety):

```
boot_mode_history (
  id            uuid PK,
  seq           BIGSERIAL NOT NULL UNIQUE,  -- monotonic ordering independent of clock
  booted_at     timestamptz NOT NULL DEFAULT now(),
  exchange_env  text NOT NULL,  -- 'testnet' | 'paper' | 'live'
  row_kind      text NOT NULL,  -- 'BOOT' | 'TRANSITION_TESTNET_TO_PAPER' | ...
  prev_row_hash bytea,          -- HMAC over prev row's signed payload (incl seq)
  this_row_hmac bytea NOT NULL  -- HMAC over this row's signed payload (incl seq)
)
```

`seq BIGSERIAL` is included in the signed payload (security round 2 M3) so
clock-skew cannot let an attacker insert a row appearing "earlier" than tip
by manipulating `booted_at`.

**HMAC subkey derivation** (security round 2 H2). The chain HMAC key is
**not** the raw bootstrap secret. Per-purpose subkeys via HKDF:
```
boot_mode_history_key  = HKDF(bootstrap_secret, info='boot_mode_history v1')
paper_state_audit_key  = HKDF(bootstrap_secret, info='paper_state_audit v1')
```
Same primitive as W1.7's `cursor v1` / `auth v1`. A leak of the
boot_mode_history key does not compromise paper_state_audit or login HMAC,
and vice versa.

**Bootstrap-secret rotation interaction (W1.8).** Rotation produces fresh
sub-keys for both chains. The pre-rotation chain tip is witnessed by
appending a typed `KEY_ROTATION_WITNESS` row referencing the old tip hash,
signed with the **new** sub-key. R3.1 includes a test that a rotation
followed by tampering with a pre-rotation row is detected via the witness.

Phase-1 crash recovery verifies the chain and refuses to proceed if it is
broken or if the last row's `exchange_env` differs from the current
`EXCHANGE_ENV`. Non-empty `paper_account_state` is a **secondary** defence
inside the mode-switch branch, not the primary predicate.

**Mid-soak chain break action** (security round 2 M4). A chain-integrity
failure detected during the soak (e.g. by the soak-exit-gate evaluator
verifying the chain before reading state) is CRITICAL: alert, halt new
decision routing, **invalidate the soak result**. Mid-soak chain breaks
never silently downgrade — they disqualify the run.

### D7 — Mode-transition matrix (append-only, never truncate the chain)

ADR 0032 includes the transition matrix; the operator must follow the
documented drain procedure for each transition. **Undocumented transitions
are rejected at boot**.

**Chain rotation primitive: append-only typed rows.** Three reviewers
(architect, logic, security) converged on the round-2 finding that "clear
and resign" creates a sanctioned escape hatch from D6's tamper-evidence
guarantee. Every legitimate transition is now recorded as an **append-only
typed row** (e.g. `TRANSITION_TESTNET_TO_PAPER`) that references the prior
tip's HMAC, signed under the appropriate sub-key. The chain is **never
truncated**. Rotation events themselves are persisted in a separate
`boot_mode_chain_rotations` table (also HMAC-chained) so a forensic auditor
can distinguish a sanctioned transition from a compromise.

```
boot_mode_chain_rotations (
  id              uuid PK,
  seq             BIGSERIAL NOT NULL UNIQUE,
  rotated_at      timestamptz NOT NULL DEFAULT now(),
  from_env        text NOT NULL,
  to_env          text NOT NULL,
  pre_tip_hash    bytea NOT NULL,           -- HMAC of the boot_mode_history tip before transition
  transition_token_hash bytea NOT NULL,     -- sha256 of the operator-provided transition token
  prev_row_hash   bytea,
  this_row_hmac   bytea NOT NULL
)
```

Each transition requires a **separate transition token** (analogous to
`LIVE_GO_AHEAD_TOKEN`): a file whose hash is baked into config and matched
at boot. The transition is single-use — once a `TRANSITION_*` row is
written, the same token cannot drive another transition without rotating.

| From | To | Procedure |
|------|----|-----------|
| TESTNET | PAPER | Confirm `paper_account_state` empty; operator provides `TESTNET_TO_PAPER_TOKEN_FILE` (hash baked at build); boot appends `TRANSITION_TESTNET_TO_PAPER` row + records rotation; proceeds. |
| TESTNET | LIVE | Operator provides both `TESTNET_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; standard LIVE allowlist applies; CRITICAL alert. |
| PAPER | TESTNET | Reject unless `paper_account_state` is empty; operator provides `PAPER_TO_TESTNET_TOKEN_FILE`; runbook documents the paper-position-cleanup step. |
| PAPER | LIVE | Reject unless `paper_account_state` empty; operator provides `PAPER_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; CRITICAL Telegram alert at boot. |
| LIVE | PAPER | Reject unless no open live positions; operator provides `LIVE_TO_PAPER_TOKEN_FILE` (separate from `LIVE_GO_AHEAD`); CRITICAL alert; never re-uses any prior token. |
| LIVE | TESTNET | Reject. Operationally: use a separate machine, **or** execute the documented destructive-wipe runbook step that records a `MACHINE_REPURPOSE_WIPE` row before re-init (logic round 2 H2 + security round 2 L1). |

### D8 — PAPER allowlist (full enumeration)

The PAPER allowlist is the full snapshot predicate, just with
`enableFutures` flipped:

```ts
isKeyPermissionSnapshotAcceptable(snapshot, nowMs, { mode: 'paper' | 'live' })
=> 
  snapshot.enableReading === true
  && snapshot.enableFutures === (mode === 'live' ? true : false)
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

The `mode` parameter is the shape of the predicate change (not a second
function variant). PAPER **rejects** `enableFutures: true` — a tradeable
key paired with PAPER mode is a hard error, not silent permission.
IP-restrict + allow-list + non-expired authority remain required (a
read-only key on unrestricted IP is still a credential-replay risk against
account-state endpoints).

### D9 — `LIVE_GO_AHEAD_TOKEN` is LIVE-only (decision, not open question)

PAPER does **not** require the go-ahead token. The read-only-only assertion
(D8) is PAPER's safety teeth. ADR 0028 records this explicitly so a future
reader does not re-introduce a PAPER token gate by analogy.

### D10 — Closed-trade counting (full enumeration)

Logic round 2 M3: enumerate the full `closeReason` set against the floor,
not only the excluded one. Quant round 2 M4: missed fills do not consume
the `max_trades_per_day` daily slot. Architect round 2 L1: excluded
`force_close` PnL is still reported in a separate soak-evaluator panel so
the operator sees what was discarded.

| `closeReason` | Counts toward ≥80-trade floor? | Notes |
|--------------|-------------------------------|-------|
| `sl` | ✅ Yes | Stop-loss intra-bar fill. |
| `tp` | ✅ Yes | Take-profit intra-bar fill. |
| `intra_bar_stop` | ✅ Yes | Generic intra-bar protective stop. |
| `force_close` | ❌ No (excluded) | M7 end-of-window. Surfaced in a separate evaluator panel for visibility. |
| Operator drain (halt + close) | ❌ No (excluded) | Operator-initiated close during incident or transition. |
| Reconciliation-forced close | ❌ No (excluded) | Engine-internal cleanup. |

Additionally:
- A simulator decision with `missed: true` does **not** consume the
  restricted profile's `max_trades_per_day: 3` slot (quant round 2 M4).
  Missed fills are observability only — they do not crowd out future
  decisions in the same risk-day.
- The soak evaluator emits a "excluded fills" report alongside the
  primary trade count so excluded-but-real PnL is auditable.

M11a §"Minimum trade count" gets a cross-reference in the same fold-in
pass.

### D11 — PAPER starting equity

PAPER starting equity defaults to **$500** to match the live restricted
profile's lower bound. Surfaced as `PAPER_STARTING_EQUITY_USDT` env var
(security round 2 L2 — keeps trust-posture-relevant magic numbers out of
code), validated by Zod schema with `$500` as the default. R3.1 includes
a boundary test that a 15% adverse mark from peak equity triggers the
abort within one WS tick (architect round 2 M2).

### D12 — Reconciliation in PAPER

PaperReconciliationAdapter inherits the **same triggers** as M6 W4b live
reconciliation (event-driven on position events; periodic poll at the same
cadence) — source swapped from exchange to PaperAccountStateService. Drift
event types are reused from `@bot/shared` (no new event shapes).

**Drift action in PAPER is more severe than in LIVE.** In LIVE, drift can
have an exchange-clock cause; in PAPER, there is no exchange to blame, so
any drift between `PaperAccountStateService` and `IPositionRepository` is
a production bug. Action: CRITICAL Telegram alert (not WARNING), audit
row, halt new decision routing, await operator intervention. The existing
M6 W4b drift handler gains a `mode`-aware severity rule.

### D13 — PaperExchangeNullityProbe (defence in depth)

Independent of `PaperExecutionClient`'s internal invariants, the
reconciliation cycle calls `ccxt.fetchOpenOrders()` (read-only, against the
live key, against the live exchange) and asserts it returns empty in PAPER.
This catches the worst-case bug — accidental order leak to the exchange —
independently of any in-engine routing assumption.

**Cadence + failure handling** (security round 2 M2; logic round 2 M2):
- Probe runs **once per minute**, not every reconciliation tick.
- The probe **filters by the engine's client-order-ID prefix** (or, if the
  operator chooses to use a dedicated PAPER-only key documented in the
  runbook, asserts the entire response is empty). Without the prefix
  filter, a stale order from a prior LIVE session or a manual UI order
  would trigger a CRITICAL on every reconciliation cycle — false-positive
  spam that defeats the alert.
- **Transport error → log and continue**, do **not** halt. A Binance
  outage halting the soak is not a defensible failure mode.
- Only a **non-empty engine-attributed response** triggers CRITICAL +
  halt + audit. The probe's W1.4 rate-limit cost (one read call/min) is
  budgeted explicitly in the token-bucket policy.

## lowFidelity behaviour in PAPER (load-bearing for the soak gate)

M7's fill simulator currently sets `lowFidelity: true` on every fill (no
depth-aware extension yet). So **every v1 PAPER fill is `lowFidelity`** for
the duration of M11a. This changes how ADR 0019 criterion 12 and ADR 0029
§2.4 apply:

- The "two rankings — full-set + `lowFidelity`-excluded" rule is
  unsatisfiable on PAPER fills as written. The `lowFidelity`-excluded subset
  is empty for v1; the "same winner on both rankings" check is undefined.

- **Explicit downgrade.** If either side of the shadow comparison has an
  empty `lowFidelity`-excluded subset, the "active version beats shadow
  v2/v3" criterion is **automatically marked inconclusive** and the soak
  gate downgrades to "v1's own expectancy CI excludes zero" alone (same
  fail-safe as W4.2's missing-contracts downgrade). M11a §"Reduced
  evaluation gate" picks up this branch in the same fold-in pass.

- **Joint-test acknowledgement.** "v1's expectancy CI excludes zero" in
  PAPER is a joint test of `(strategy edge + M7 fill model bias)`, not of
  strategy edge alone. M11b's go-live decision must treat the PAPER CI as
  a **necessary but not sufficient** condition.

- **Pre-soak sanity step (mandatory, TOST equivalence).** Logic round-2 H1
  + quant round-2 M2: a "fail to reject zero" null test trivially passes
  with small N — that is power against the null, not evidence of
  unbiasedness. Replace with the **Two One-Sided Tests (TOST) equivalence
  procedure**:
  - Run the M7 simulator over the prior 60 days of the same symbol
    universe with a known-zero-edge strategy (random entries respecting
    the restricted profile gates).
  - Compute the **90% CI on residual expectancy**.
  - Set tolerance band `ε = 25% of v1's backtested expectancy on the same
    window`.
  - **Pass criterion:** the 90% CI must lie entirely within `[−ε, +ε]`.
  - If the CI is wider than the band, the simulator has unknown bias
    relative to the soak's expected detection signal and the soak does
    not start. Documented as an operator decision in the runbook: extend
    the calibration window, or accept the soak as exploratory only.
  This step lands in M11a §W4.4 alongside the existing calibration day.

- **v1 vs v0 reframing.** v0 is exactly zero with zero variance, so "v1's
  CI excludes zero from above" is a one-sided test against a degenerate
  null. This is a sanity floor, **not** evidence of edge. The load-bearing
  criterion is v1 vs shadow v2/v3 in **paired** difference (same
  simulator, same noise, simulator bias cancels). The local-soak plan's
  exit criteria gets reworded accordingly.

## Soak sample-size pre-flight (mandatory)

If `Var(simulator_noise) ≫ E[v1] − E[v2]`, the bootstrap CI never excludes
zero regardless of strategy edge. Required pre-soak step:

1. Run M7 over the same symbol universe + 60-day window.
2. Compute per-trade variance attributable to missed-fill + slippage rolls
   by holding strategy decisions fixed and varying only the simulator seed
   across N=1000 runs.
3. **Also report `Var(E[v1] − E[v2])` across the same N=1000 paired runs**
   (both strategies decide on the same tape, both go through the
   simulator). This is the paired-difference variance the soak's bootstrap
   actually estimates — the isolated noise estimate from step 2 alone
   under-estimates the real floor when missed-fill is correlated with
   adverse selection (quant round 2 M3).
4. Derive the minimum detectable effect size at n=80 with α=0.05 from the
   paired-difference variance.
5. If the MDE exceeds the historical between-version expectancy gap on
   backtest, the soak is statistically underpowered before it starts. The
   trade floor must be raised (or the soak is acknowledged as
   exploratory).

This step lands in W4.4 (calibration day).

## Scope of work — wave structure

### Wave R0 — Rename + ADR updates (shared + architect)

**R0.1 — Shared rename.** `bot-shared-maintainer` renames
`ExchangeEnvironmentEnum.DEMO` → `PAPER`. Updates `exchangeEnvironmentSchema`
Zod validator. Adds the `mode: 'paper' | 'live'` parameter to
`isKeyPermissionSnapshotAcceptable` per D8. No structural change beyond the
rename + parameter addition.

**R0.2 — ADR 0028 update.** `bot-architect` updates
`0028-key-permission-assertion-port.md`:
- §2.3 removes the false *"Demo trading reaches `fapi.binance.com`"* claim;
  reflects the testnet-alias reality.
- §2.4 enumerates the PAPER allowlist exactly per D8 (full predicate, only
  `enableFutures` differs).
- PAPER calls live `/sapi`; only TESTNET skips. PAPER + LIVE share the
  IP-restrict + non-expired-authority checks.
- Records D9 (PAPER does not require `LIVE_GO_AHEAD_TOKEN`).

**R0.3 — ADR 0032 (new) — PAPER mode architecture.** `bot-architect` authors:
- `PaperModeModule` containing `PaperExecutionClient`,
  `PaperFillSimulator`, `PaperAccountStateService`,
  `PaperReconciliationAdapter`, `PaperExchangeNullityProbe`,
  `PaperFundingAccrualService`.
- D1–D13 reproduced verbatim as the architectural decisions of the ADR.
- Compile-time split (D2) called out — `PaperExecutionClient` must not
  import the rate-limit module.
- DB schema for `paper_account_state`, `paper_account_state_meta` (boot
  seed + RNG cursor), `paper_state_audit` (HMAC-chained mutation audit),
  `boot_mode_history` (D6).
- Cites M7's seed-locking ADR for the deterministic-PRNG rationale (D3).
- Transition matrix (D7) reproduced.

**R0.4 — ADR 0014 amendment** (new sub-task; architect, parallel to R0.3).
ADR 0014's phase-1 names the exchange as the source of truth. Amend phase 1
to read an `IBootStateSource` dispatched on `EXCHANGE_ENV` to
`ExchangeBootStateSource` (LIVE/TESTNET) or `PaperBootStateSource` (PAPER).
Other phases unchanged.

### Wave R1 — Strip the broken DEMO wiring (engine, ≤5 items)

**R1.1 — Strip `enableDemoTrading` and DEMO URL handling.**
`apps/engine/src/exchange/service/CcxtBinanceExchangeClient.ts` —
`selectEnvironmentUrls` drops the DEMO branch. TESTNET stays on
`setSandboxMode(true)`; PAPER uses the LIVE URL block (because market data
hits live `fapi.binance.com` in PAPER); LIVE unchanged. `enableDemoTrading`
call is removed entirely. **Add a sentinel test asserting
`enableDemoTrading` is never called in any environment** (regression guard
against silent resurrection).

**R1.2 — Update `LiveGoAheadVerifier` callers.** The two-token boot gate
stays for LIVE only. PAPER does not call it (D9).

**R1.3 — Update `.env.example`.** `EXCHANGE_ENV=` (no default) — comment
lists `testnet | paper | live`.

**R1.4 — Update `KeyPermissionAssertionService` for mode-aware allowlist.**
Three branches per updated ADR 0028:
- `TESTNET` → skip (audit `KEY_PERMISSION_ASSERTION_SKIPPED`, no exchange
  call).
- `PAPER` → call live `/sapi`, allowlist per D8 with `mode='paper'`.
- `LIVE` → call live `/sapi`, allowlist per D8 with `mode='live'` (existing
  behaviour).
Failure path unchanged: Telegram CRITICAL + audit row + `process.exit(1)`.

**R1.5 — Boot mode history HMAC chain.** Add the `boot_mode_history`
migration + entity + repository. Engine writes a new HMAC-chained row at
every successful boot. Boot-time check: verify chain integrity; if broken
or if last row's `exchange_env` ≠ current `EXCHANGE_ENV`, abort with the
documented transition error.

### Wave R2 — PAPER mode core (engine, split if >5 items)

**R2.1 — `IExecutionClient` split.** Per D2: split execution surface out of
`IExchangeClient`. Existing `CcxtBinanceExchangeClient` implements both.
New `PaperExecutionClient` implements execution only. NestJS module-level
provider keyed on `exchangeEnv`. Compile-time guarantee: `PaperModeModule`
does not import `RateLimitPolicyService`.

**R2.2 — `PaperExecutionClient`.** Returns simulated `IOrder` responses
with deterministic IDs. Routes every order intent to `PaperFillSimulator`.
Records the simulated fill via `PaperAccountStateService`.

**R2.3 — `PaperFillSimulator`.** Wraps M7 `BacktestRunnerService` fill
logic for live event-time per D3. PRNG seeded per D3. Config-hash check
against the M7 commit-pinned hash at boot.

**R2.4 — `PaperAccountStateService` + `paper_account_state_meta`.** Local
source of truth for paper positions, balances, margin, realised +
unrealised PnL. Mark-to-market per D5. Persists per D1 and D3. Provides
snapshots for: gate evaluation, reconciliation, crash recovery, soak gate.

**R2.5 — `paper_state_audit` HMAC-chained mutation audit.** Every mutation
to `paper_account_state` pairs with a `paper_state_audit` row (typed
action, prior+new HMAC, monotonic seq). Soak-exit-gate queries verify the
audit chain before reading state (D6 + Security H3).

**R2.6 — `PaperReconciliationAdapter` + `PaperExchangeNullityProbe`.** Per
D12 + D13. Drift in PAPER is treated as a production bug (CRITICAL alert,
halt, audit). NullityProbe asserts `ccxt.fetchOpenOrders()` returns empty
every reconciliation tick.

**R2.7 — `PaperFundingAccrualService`.** Per D4. Reuses the live funding
WS stream; applies rates at Binance funding timestamps to paper positions.
Magnitude bound `|rate| ≤ 0.0075` enforced.

**R2.8 — Crash recovery integration.** Phase 1 in PAPER reads
`PaperBootStateSource` (per amended ADR 0014). On boot, verifies
`boot_mode_history` chain and rejects mode mismatch per D6. RNG cursor
restored from `paper_account_state_meta` so SIGKILL/restart replays
identical fills.

> R2 may be split into R2a (R2.1–R2.4) and R2b (R2.5–R2.8) if a single
> engine dispatch exceeds the `dev-qa-cycle.md` soft ≤5-file cap.

### Wave R3 — Tests + QA

**R3.1 — Adversarial coverage.** `bot-qa-engineer`:
- PAPER boot with `{enableReading, enableFutures}` key → assertion fails.
- PAPER boot with a TESTNET-fingerprinted last `boot_mode_history` row →
  aborts.
- PAPER boot with `EXCHANGE_ENV` unset → aborts (the W0.1 Zod schema
  already throws — regression guard).
- PAPER order placement never calls **any** execution method on ccxt
  (mock ccxt, assert zero calls on `createOrder`, `cancelOrder`,
  `cancelAllOrdersForSymbol`, `fetchOrderStatus`, plus the D2 surface —
  security round 2 L3). A missed mock must not silently let an execution
  call slip through.
- `enableDemoTrading` is never called in any environment (sentinel).
- PaperFillSimulator deterministic across SIGKILL replay: kill mid-trade,
  restart, last 5 decisions replay to identical `simulated_fill` rows.
- Funding accrual: `side_sign(LONG) × funding_paid(rate>0) > 0`; magnitude
  bound `|rate| ≤ 0.0075` enforced.
- Paper position closed at T−1ms before funding ts does not accrue.
- Mark-to-market: drawdown abort triggers intra-bar on a fast adverse
  move (no decision-boundary lag).
- `PaperReconciliationAdapter` drift between paper-state and position-repo
  emits CRITICAL (not WARNING) + halts.
- `PaperExchangeNullityProbe` failure (mocked non-empty `fetchOpenOrders`)
  triggers CRITICAL + halt.
- `boot_mode_history` HMAC chain: tampering with a row produces a chain
  verification failure on next boot.
- Pre-soak sanity step's TOST band rejects the start when the 90% CI on
  residual expectancy is not contained in `[−ε, +ε]`.
- Funding event coincident with adverse mark: ordering is
  apply_funding → recompute_unrealised → evaluate_abort; the abort
  decision incorporates the funding hit.
- $75 drawdown boundary test from peak equity fires the abort intra-bar.
- Funding `|rate| > 0.0075` writes audit row + CRITICAL alert, applies
  the rate (does not zero it).
- Soak fills replayable identically by an offline M7 run against the
  same decision tape (D3 cross-run determinism check; logic round 2 L1).
- `boot_mode_history` chain: tampering with a pre-rotation row after a
  bootstrap-secret rotation is detected via the `KEY_ROTATION_WITNESS`
  row (D6 rotation interaction).
- `seq` ordering protects against clock-skew row-insertion attacks.
- Mid-soak chain break → CRITICAL + halt + soak result invalidated.
- D7 transition: a single-use transition token cannot drive a second
  transition without rotating.

### Wave R4 — Reviewer round + scribe

**R4.1 — Reviewer round** on R0–R3 (security + logic + quant + clean-code;
devops if compose changes).

**R4.2 — Scribe.** Merge this addendum into `M11a-local-soak.md` (replace
W1.1 wording with the PAPER design; integrate D10 / lowFidelity / pre-soak
sanity into §"Reduced evaluation gate" + §"Minimum trade count" + §W4.4).
Delete this addendum file. **Preserve anchor IDs D1–D13** (logic round 2 L3)
in the merged content so existing cross-references survive. Update
`CLAUDE.md` status. Append a single work-log line referencing the merged
commit.

## Migration of work already landed

| Component | Status | Action |
|-----------|--------|--------|
| `ExchangeEnvironmentEnum` | Landed with `DEMO` | Rename `DEMO` → `PAPER` (R0.1) |
| `exchangeEnvironmentSchema` | Landed | Rename literal (R0.1) |
| `IKeyPermissionSnapshot` | Landed | Unchanged |
| `isKeyPermissionSnapshotAcceptable` | Landed (LIVE allowlist) | Add `mode` param per D8 (R0.1) |
| `AuthFailureReasonEnum.BAD_SIGNATURE` | Landed | Unchanged |
| `ILiveModeProfile` | Landed | Unchanged |
| `IShadowDecision` / `ISimulatedFill` / `IVirtualPositionLedger` | Landed | Reused by PAPER + shadow alike |
| `IExchangeNotInDbDriftEvent` | Landed | Reused for PAPER reconciliation drift |
| ADR 0028 | Landed | Update §2.3 + §2.4 per R0.2 |
| ADR 0029 | Landed | Unchanged |
| ADR 0030 | Landed | Unchanged. PAPER never reaches it. Compile-time split (D2) enforces. |
| ADR 0031 | Landed | Unchanged |
| ADR 0014 | Landed (M6) | Phase-1 amendment per R0.4 |
| `CcxtBinanceExchangeClient.selectEnvironmentUrls` | Landed with DEMO branch | Strip DEMO; PAPER uses LIVE URLs (R1.1) |
| `LiveGoAheadVerifier` | Landed | Unchanged (LIVE-only per D9) |
| `KeyPermissionAssertionService` | Landed (TESTNET/DEMO/LIVE branches) | Rewrite branches per R1.4 |
| `RateLimitPolicyService` | Landed | Unchanged. Compile-time split (D2). |
| `LoginRateLimiter` / `DerivedKeyService` / `RevokedJtiPruneScheduler` | Landed | Unchanged |
| W1 QA adversarial tests | Landed | Tests asserting `DEMO`-specific behaviour rewritten for `PAPER`; tests asserting `enableDemoTrading()` is called → deleted + replaced with sentinel asserting never-called. |

## Risks

- **Scope creep.** R0–R3 add ~8 new engine modules + 1 ADR + 4 new tables
  + 1 ADR amendment + contract changes. Realistic effort: comparable to
  or slightly larger than the original W1. R2 may need an R2a / R2b
  split to honour the ≤5-file soft cap.
- **PaperFillSimulator inherits M7's `lowFidelity` flag.** Mitigated by
  the lowFidelity-empty-subset downgrade + pre-soak sanity step + joint-
  test acknowledgement.
- **State surface grows.** Three new tables + HMAC-chained audits. Crash
  recovery's phase 1 dispatches on env. Mitigation: ADR 0014 amendment
  + R3.1 SIGKILL drill.
- **Mode-switch silent data loss.** Mitigated by D6 HMAC chain + D7
  transition matrix + R1.5 boot integrity check.
- **One-time rename churn.** Renaming DEMO → PAPER touches ~10 files. Low
  technical risk. Single shared-maintainer dispatch (R0.1), single engine
  dispatch (R1).

## Definition of done

The PAPER mode is complete when:

- `ExchangeEnvironmentEnum` is `{TESTNET, PAPER, LIVE}`.
- ADR 0028 reflects the corrected understanding + PAPER allowlist (D8).
- ADR 0032 locks PAPER mode architecture with D1–D13 inline.
- ADR 0014 phase-1 amended for `IBootStateSource` dispatch.
- A PAPER boot:
  - rejects any key with capability flags beyond `enableReading` (CRITICAL
    alert + audit + exit);
  - verifies `boot_mode_history` HMAC chain + matches `EXCHANGE_ENV`;
  - subscribes to **live** market data;
  - never calls `ccxt.createOrder` / `cancelOrder` / order-placement
    methods (sentinel test enforces);
  - simulates fills deterministically via `PaperFillSimulator` (HMAC seed
    schema, M7 config-hash-pinned);
  - reconciles `PaperAccountStateService` against `IPositionRepository`
    (drift = CRITICAL halt) + `PaperExchangeNullityProbe` asserts
    `fetchOpenOrders` empty;
  - applies live funding rates with correct side-sign + mark-to-market
    notional + magnitude bound;
  - mark-to-markets unrealised PnL on every WS tick; drawdown abort fires
    intra-bar;
  - recovers from a SIGKILL mid-trade with byte-identical replay of the
    last decisions;
  - refuses to silently switch to TESTNET or LIVE if any condition in D7
    fails.
- Pre-soak sanity step (residual expectancy on zero-edge strategy) passes
  before the soak counts.
- Adversarial QA (R3.1) covering each path passes.
- Reviewer round (R4.1) green (zero blockers, zero highs).
- Scribe (R4.2) merged this addendum into `M11a-local-soak.md` + deleted
  this file.

Only on full pass does the soak enter the proper W4 start (calibration
day + drill + restricted-profile commit).
