# M11a — Paper-mode addendum (DEMO → PAPER course correction)

**Status:** Draft for review — replaces the `DEMO` mode introduced in W0.1 / W1.1
with a self-contained `PAPER` mode after W1 reviewer cycle uncovered that
Binance USDT-M Futures has no API-accessible paper-trading host distinct from
testnet.

**Depends on:** the rest of M11a as previously planned and partially
implemented (W0 shared contracts + W1 engine wave both landed; the rename in
this addendum is a course correction, not a restart).

**Replaces in M11a §W1.1:** the `DEMO = Binance demo trading` design, which was
based on a false premise.

## Why this addendum

W1 reviewer cycle (round 1) surfaced a blocker:

- ccxt's `enableDemoTrading(true)` swaps `urls.api` to a `urls.demo` block that
  contains only `fapi/dapi/v1/public/private` keys — **no `sapi*` keys**.
- `KeyPermissionAssertionService` calls `sapiGetAccountApiRestrictions` +
  `sapiGetAccountApiRestrictionsIpRestriction` (both `/sapi`), so a `DEMO`
  boot throws `fetch_error` and `failHard()` exits the process.
- ADR 0028 §2.3 asserted *"Demo trading reaches `fapi.binance.com` (live order
  books, paper fills)"* — directly contradicting what ccxt actually does.

Investigation against the current Binance developer docs and the official
Binance dev forum confirmed:

- Binance USDT-M Futures developer docs list **exactly one** non-production
  REST host: `https://demo-fapi.binance.com`.
- `demo-fapi.binance.com` and `testnet.binancefuture.com` are aliases for the
  same testnet environment.
- Binance staff response on `dev.binance.vision`: *"Please use the testnet to
  test your API integration."* No separate paper-trading endpoint exists.
- ccxt's `enableDemoTrading()` for Futures is a rename of testnet, not a
  separate mode.

The original `DEMO` premise — *paper fills against the live production order
book* — is not achievable through Binance's API for USDT-M Futures.

## The `PAPER` design

Rename `DEMO` → `PAPER` and make it an **engine-local paper-trading mode**:

- WebSocket connects to **live** `fapi.binance.com` for market data + funding
  (real prices, real depth, real spread, real OI, real funding rates).
- Orders are intercepted before reaching ccxt and routed to a local
  `PaperFillSimulator` (reuses M7 `BacktestRunnerService` fill logic on live
  event-time).
- Account state (positions, balances, margin) is simulated locally in a new
  `PaperAccountStateService`; never reads or writes a real Binance account.
- Reconciliation in PAPER mode runs against the local simulated state (catches
  engine-internal drift) rather than the exchange (which has no PAPER state to
  diverge against).
- Key-permission assertion is **mode-aware** and **stricter** in PAPER than in
  LIVE: PAPER requires a `{enableReading: true}` read-only key and **rejects**
  `enableFutures: true`. This is defence in depth — accidentally booting PAPER
  with a tradeable key is a hard error, not a silent permission to trade.

This design has three properties the misnamed `DEMO` mode could never have:

1. **Real liquidity, real depth.** The soak measures v1 against live order
   books, not a fake testnet matching engine.
2. **No exchange-side fund risk.** No order ever reaches Binance from a PAPER
   boot. Even with a misconfigured tradeable key, the engine refuses to boot.
3. **Reuses the W0 shadow infrastructure.** The `IVirtualPositionLedger`
   interface (W0.6, ADR 0029) already specifies an own-state per-version
   ledger. PAPER's `PaperAccountStateService` is structurally the same shape
   as a shadow version's virtual ledger — just promoted to "the active
   version" for fill recording.

## Trade-offs (informational, not blocking)

- **Fills are `lowFidelity: true` until M7's depth-aware extension lands.** The
  fill simulator uses tier-based slippage + missed-fill rules — better than
  testnet's fake matching engine, but not as precise as a real exchange.
- The existing soak exit criteria already handle `lowFidelity` correctly: the
  M8 ADR-0019 criterion 12 two-rankings rule (full-set + `lowFidelity`-excluded;
  same winner required, else inconclusive) mirrors over from shadow comparison
  to PAPER's own fills. No new statistical contract needed.
- Same-state-of-the-world for v1 PAPER + v2/v3 shadow: all four versions see
  the live tape; v1 executes into PaperFillSimulator + writes `decisions`; v2/v3
  shadow into their own ledgers + write `shadow_decisions`.

## Scope of work — wave structure

### Wave R0 — Rename + ADR updates (shared + architect)

**R0.1 — Shared rename.** `bot-shared-maintainer` renames
`ExchangeEnvironmentEnum.DEMO` → `PAPER`. Updates `exchangeEnvironmentSchema`
Zod validator. No structural change beyond the rename.

**R0.2 — ADR 0028 update.** `bot-architect` updates `0028-key-permission-assertion-port.md`:
- §2.3 removes the false *"Demo trading reaches `fapi.binance.com`"* claim.
- Adds a new §2.X: PAPER mode allowlist is `{enableReading: true}` ONLY;
  `enableFutures: true` is **rejected** in PAPER (a tradeable key in paper mode
  must fail closed).
- Updates the per-field provider table footnote: TESTNET and PAPER both skip
  the assertion because both reach the testnet `/sapi` surface only — but with
  different rationale (TESTNET: nothing to protect; PAPER: read-only-only key
  enforced separately).

Actually correction: PAPER **does not** skip the assertion. PAPER calls the
**LIVE** `/sapi` host with the user-provided key (because we want the engine to
refuse to boot with a non-read-only key). Only TESTNET skips. Lock this in
the ADR update.

**R0.3 — ADR 0032 (new) — PAPER mode architecture.** `bot-architect` authors:
- Module surface: `PaperModeModule` containing `PaperOrderClient`,
  `PaperFillSimulator`, `PaperAccountStateService`, `PaperReconciliationAdapter`.
- Interface contract: `IExecutionClient` (smaller than `IExchangeClient`, just
  order-placement methods — `placeOrder`, `cancelOrder`, `fetchOrderStatus`,
  `fetchOpenOrders`). Two impls: `CcxtExecutionClient` (existing ccxt path),
  `PaperExecutionClient` (new).
- Env dispatch: `PAPER` → `PaperExecutionClient`; `TESTNET`/`LIVE` →
  `CcxtExecutionClient`. Market-data calls (`subscribePriceUpdate`,
  `subscribeOrderBook`, funding rates) stay on `IExchangeClient` (ccxt) for
  all envs — PAPER consumes live market data.
- `PaperFillSimulator` contract: takes a decision + live market snapshot +
  PaperAccountStateService snapshot, returns an `ISimulatedFill` (the type
  already exists in shared per W0.5). Reuses M7 `BacktestRunnerService` fill
  logic.
- `PaperAccountStateService` contract: persists state to a new
  `paper_account_state` table (or reuses `positions` with a `mode` discriminator
  — the ADR picks one and documents why).
- Crash-recovery interaction with M6 ADR-0014: phase 1 reads
  `PaperAccountStateService` snapshot in PAPER (not exchange); other phases
  unchanged.
- Funding interaction: live funding rates apply to PaperAccountStateService
  positions at the same risk-day boundary as live.
- Reconciliation interaction: PAPER mode reconciles
  `PaperAccountStateService` against `IPositionRepository` (catches
  engine-internal drift) instead of the exchange. Reuses the existing M6 W4b
  drift detection event types.
- W0.5 / W0.6 shadow-mode interaction: v1 writes `decisions` (with executed=
  true); shadow versions write `shadow_decisions`; no overlap.

### Wave R1 — Strip the broken DEMO wiring (engine)

**R1.1 — Strip `enableDemoTrading` and DEMO URL handling.**
`apps/engine/src/exchange/service/CcxtBinanceExchangeClient.ts` —
`selectEnvironmentUrls` drops the DEMO branch. TESTNET stays on
`setSandboxMode(true)`; PAPER uses the LIVE URL block (because market data
hits live `fapi.binance.com` in PAPER); LIVE unchanged. `enableDemoTrading`
call is removed entirely.

**R1.2 — Update `LiveGoAheadVerifier` callers.** The two-token boot gate stays
for LIVE only. PAPER does not need a go-ahead token because the key-permission
assertion in PAPER (read-only-only) is the safety gate.

**R1.3 — Update `.env.example`.** `EXCHANGE_ENV=` (no default) — comment now
lists `testnet | paper | live`.

**R1.4 — Update `KeyPermissionAssertionService` for mode-aware allowlist.**
Three branches per updated ADR 0028:
- `TESTNET` → skip (audit `KEY_PERMISSION_ASSERTION_SKIPPED`, no exchange call).
- `PAPER` → call live `/sapi`, allowlist exactly `{enableReading: true}` (every
  other capability flag must be false, including `enableFutures`).
- `LIVE` → call live `/sapi`, allowlist `{enableReading: true, enableFutures:
  true}` (existing).

Failure path in PAPER: same Telegram CRITICAL + audit row + `process.exit(1)`
as LIVE. The allowlist predicate in `packages/shared/` gains a second variant
or an explicit `enforce: 'paper' | 'live'` parameter.

### Wave R2 — PAPER mode core (engine)

**R2.1 — `IExecutionClient` interface + env-dispatched binding.** Split
`IExchangeClient` into market-data + execution surfaces. Existing
`CcxtBinanceExchangeClient` implements both; new `PaperExecutionClient`
implements execution only. NestJS module-level provider keyed on
`exchangeEnv` picks the right implementation.

**R2.2 — `PaperOrderClient` / `PaperExecutionClient`.** Reads orders, returns
simulated `IOrder` responses with deterministic IDs (so existing order-tracking
state machines work unchanged). Routes every order intent to
`PaperFillSimulator`. Records the simulated fill in `decisions.fills` (or
wherever real fills are recorded today — entity discovered by the engine
agent).

**R2.3 — `PaperFillSimulator`.** Wraps M7 `BacktestRunnerService` fill logic
for live event-time. Inputs: decision + live market snapshot + paper account
state. Outputs: `ISimulatedFill`. Honours tier slippage, latency, missed-fill,
intra-bar SL/TP (the same rules ADR 0029 §2.3 locked for shadow mode — same
fill logic, different consumer).

**R2.4 — `PaperAccountStateService`.** Source of truth for paper positions,
balances, margin, realised + unrealised PnL. Persists to a new table or to
`positions` with a `mode` discriminator (ADR 0032 R0.3 picks). Provides
snapshots for: gate evaluation (slot count, halt state), reconciliation,
crash recovery.

**R2.5 — `PaperReconciliationAdapter`.** Wires the existing M6 W4b
reconciliation pipeline to compare `PaperAccountStateService` against
`IPositionRepository` instead of the exchange. Drift events use the same
event types (already in shared); the soak runbook reads them by typed name.

**R2.6 — Funding integration.** Existing funding service reads live rates from
the exchange (unchanged). In PAPER mode, a new `PaperFundingAccrualService`
applies live rates to `PaperAccountStateService` positions at risk-day boundary.

**R2.7 — Crash recovery integration.** M6 ADR-0014 ten-phase pipeline: phase 1
in PAPER reads the latest `PaperAccountStateService` snapshot from Postgres.
Other phases unchanged. The `MODE` env is persisted in a boot-audit row so
crash recovery refuses to switch modes between boots (a TESTNET reboot of a
PAPER soak would silently drop the paper account state — must refuse).

### Wave R3 — Tests + QA

**R3.1 — Adversarial coverage.** `bot-qa-engineer`:
- PAPER boot with a `{enableReading, enableFutures}` key → assertion fails.
- PAPER order placement never calls ccxt.createOrder (mock ccxt, assert zero
  calls).
- PaperFillSimulator deterministic given the same market snapshot + account
  state.
- Funding accrual applies live rate at the right boundary.
- Reconciliation drift between `PaperAccountStateService` and
  `IPositionRepository` is detected and emits a typed drift event.
- Crash recovery: PAPER boot followed by SIGKILL mid-trade followed by restart
  reconstructs paper account state correctly.
- Mode-switch refusal: a TESTNET boot finding non-empty
  `paper_account_state` aborts with a clear error.

### Wave R4 — Reviewer round + scribe

**R4.1 — Reviewer round** on R0–R3 (security + logic + quant + clean-code +
devops if compose changes).

**R4.2 — Scribe updates.** Update `docs/plans/M11a-local-soak.md` to fold the
addendum back in (replace W1.1 wording, mark this addendum as merged); update
`CLAUDE.md` status; add a work-log entry.

## Migration of work already landed

The following pieces of M11a W0/W1 stay as-is or get a small surgical edit:

| Component | Status | Action |
|-----------|--------|--------|
| `ExchangeEnvironmentEnum` | Landed with `DEMO` | Rename `DEMO` → `PAPER` (R0.1) |
| `exchangeEnvironmentSchema` | Landed | Rename literal (R0.1) |
| `IKeyPermissionSnapshot` | Landed | Unchanged |
| `isKeyPermissionSnapshotAcceptable` | Landed (LIVE allowlist) | Gain a `paper` variant or `mode` arg (R1.4) |
| `AuthFailureReasonEnum.BAD_SIGNATURE` | Landed | Unchanged |
| `ILiveModeProfile` | Landed | Unchanged |
| `IShadowDecision` / `ISimulatedFill` / `IVirtualPositionLedger` | Landed | Reused by PAPER + shadow alike |
| `IExchangeNotInDbDriftEvent` | Landed | Reused for PAPER reconciliation drift |
| ADR 0028 | Landed | Update §2.3 + add PAPER allowlist (R0.2) |
| ADR 0029 | Landed | Unchanged (shadow infra is reused) |
| ADR 0030 | Landed | Unchanged (rate limit applies in LIVE only; PAPER never calls ccxt for orders) |
| ADR 0031 | Landed | Unchanged |
| `CcxtBinanceExchangeClient.selectEnvironmentUrls` | Landed with DEMO branch | Strip DEMO; rebrand PAPER to use LIVE URLs (R1.1) |
| `LiveGoAheadVerifier` | Landed | Unchanged (still LIVE-only) |
| `KeyPermissionAssertionService` | Landed (TESTNET/DEMO/LIVE branches) | Rewrite branches per R1.4 |
| `RateLimitPolicyService` | Landed | Unchanged. PAPER never reaches it because orders short-circuit to PaperExecutionClient. Add an assertion that the policy is **not** invoked from PaperExecutionClient (catches accidental routing). |
| `LoginRateLimiter` / `DerivedKeyService` / `RevokedJtiPruneScheduler` | Landed | Unchanged |
| W1 QA adversarial tests | Landed | Tests that assert DEMO-specific behaviour are updated to assert PAPER; tests asserting `enableDemoTrading()` is called are deleted. |

## Open questions (architect must adjudicate in R0.3)

1. **`paper_account_state` table vs `mode` discriminator on `positions`.** Both
   work; the ADR picks one and rejects the other with rationale. Suggested:
   new table, because (a) lets PAPER state retention follow a different
   policy than live positions, (b) crash recovery's phase-1 reader is
   simpler with a dedicated table, (c) no risk of a PAPER position
   accidentally being read by a LIVE-mode read API query.
2. **`IExecutionClient` granularity.** Suggested methods: `placeOrder`,
   `cancelOrder`, `cancelAllOrdersForSymbol`, `fetchOrderStatus`,
   `fetchOpenOrders`. Confirm against the existing
   `apps/engine/src/exchange/interface/IExchangeClient.ts` surface — pull only
   the order-touching methods, leave market-data + reads on the existing
   interface.
3. **PaperFillSimulator determinism.** Random-roll for missed-fill / partial-
   fill must use a seeded PRNG (or none) so soak runs are reproducible. Pin
   the seed strategy in the ADR.
4. **Funding rate timestamp source.** Live funding events arrive on a ccxt
   stream; PaperFundingAccrualService applies them to PaperAccountStateService.
   Document the ordering guarantee: a paper position closed before the funding
   timestamp does not accrue funding (same as live).
5. **Two-token boot gate scope.** Original `LIVE_GO_AHEAD_TOKEN` was LIVE-only.
   Confirm in the ADR that PAPER does **not** require it (the read-only-only
   assertion is the safety teeth in PAPER).

## Risks

- **Scope creep.** This addendum adds ~6 new engine modules + 1 new ADR +
  contract changes. Realistic effort: comparable to or slightly larger than
  the original W1.
- **PaperFillSimulator inherits M7's `lowFidelity` flag.** The depth-aware
  extension is deferred to a future M8 follow-up; until it lands, the soak's
  v1 expectancy CI is `lowFidelity`. Mitigation: the M8 ADR-0019 criterion 12
  two-rankings rule applies — the soak gate already handles this. The exit
  criterion is still informative.
- **State surface grows.** PaperAccountStateService persistence is a new
  failure mode for crash recovery. Mitigation: the M6 ADR-0014 ten-phase
  pipeline is the existing pattern — PAPER plugs in at phase 1; later phases
  are reused.
- **Mode-switch silent data loss.** A TESTNET reboot of a PAPER soak silently
  drops paper account state. Mitigation: the boot-audit row + mode-switch
  refusal in R2.7.
- **One-time rename churn.** Renaming DEMO → PAPER touches ~10 files. Low
  technical risk but cosmetic noise. Mitigation: single shared-maintainer
  dispatch (R0.1), single engine dispatch (R1).

## Definition of done

The PAPER mode is complete when:

- `ExchangeEnvironmentEnum` is `{TESTNET, PAPER, LIVE}`.
- ADR 0028 reflects the corrected demo-mode understanding + PAPER's
  read-only-only allowlist.
- ADR 0032 locks the PAPER mode architecture.
- A PAPER boot:
  - rejects a key with any flag beyond `enableReading` (CRITICAL alert + audit
    row + process exit);
  - subscribes to **live** market data;
  - never calls `ccxt.createOrder` / `cancelOrder` / any order-placement path;
  - simulates fills via `PaperFillSimulator`;
  - reconciles `PaperAccountStateService` against `IPositionRepository`;
  - applies live funding rates to paper positions at risk-day boundary;
  - recovers from a SIGKILL mid-trade with consistent paper state;
  - refuses to silently switch to TESTNET or LIVE if `paper_account_state` is
    non-empty.
- Adversarial QA covering each of the above paths passes.
- Reviewer round green (zero blockers, zero highs).
- Plan + work-log updated by scribe.

Only on full pass does the soak enter the proper W4 start (calibration day +
drill + restricted-profile commit).
