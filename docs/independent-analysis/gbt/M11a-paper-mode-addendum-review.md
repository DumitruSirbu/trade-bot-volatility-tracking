# Independent Review — M11a Paper-Mode Addendum

## Executive Verdict

The addendum makes the correct headline course correction: Binance USDT-M Futures does not give this project a separate API-accessible demo venue with live books and paper fills, so the plan must stop treating `DEMO` as a third exchange environment.

The proposed `PAPER` mode is directionally reasonable, but it is not yet merge-ready as an implementation plan. It replaces one false exchange assumption with a large local simulator subsystem, and several parts of that subsystem conflict with each other or with existing M6/M7/M8 contracts.

My assessment:

| Area | Grade | Assessment |
|------|-------|------------|
| Correction from `DEMO` to `PAPER` | A- | Necessary and well justified. |
| Trading-safety posture | B | Safer than fake demo trading, but not equivalent to an exchange paper venue. |
| Implementation scoping | C | R2 is too broad; it should be mandatory-split, not optional. |
| State model | C | Dedicated paper state is sensible, but its relationship to `positions`, `transactions`, `risk_state`, and `account_snapshots` is underspecified. |
| Statistical gate | C- | The low-fidelity downgrade and independent simulator noise can make the soak underpowered or falsely comforting. |
| Security/tamper evidence | B- | Good instincts, but the HMAC chains are over-sold unless anchored outside the same DB + same host secret boundary. |

Bottom line: accept the `DEMO` → `PAPER` direction, but do not implement R2 until the plan fixes the contradictions below. Otherwise M11a risks becoming a high-complexity simulator whose outputs look precise but do not safely justify M11b.

## High-Risk Findings

### H1 — Boot-mode transition logic is internally contradictory

The addendum says `boot_mode_history` aborts when the persisted last-known boot mode differs from the current `EXCHANGE_ENV`. It also says legitimate transitions such as `TESTNET → PAPER` are recorded as append-only transition rows during boot.

That ordering cannot work unless the transition exception is explicitly defined. If the check runs first, the transition is rejected. If the row is appended first, the app mutates the chain before it has fully verified whether the transition is authorized.

Required change:

- Define the exact boot order: load config, verify chain, detect mode mismatch, verify transition token, append `TRANSITION_*` row in a transaction, append current `BOOT` row, then continue startup.
- Make R1.5 test both paths: unauthorized mode mismatch aborts without appending anything; authorized transition appends exactly one transition row and one boot row.
- Clarify whether `row_kind.exchange_env` on transition rows stores the source, destination, or both. The current table has one `exchange_env` in `boot_mode_history` but transition rows conceptually need two states.

### H2 — Paper simulator seed handling contradicts itself and may persist sensitive material

D3 says `boot_seed` is derived at boot via HKDF and not stored in plaintext, and that `paper_account_state_meta` stores only the RNG cursor. A later bullet says to persist `(boot_seed, last_consumed_event_id)` alongside `paper_account_state`.

That is a direct contradiction. It also matters operationally: if the seed is derived from the bootstrap secret, storing it creates another long-lived secret equivalent for the paper simulator stream.

Required change:

- Persist only non-secret metadata: seed version, HKDF info label version, simulator config hash, and replay cursor.
- Derive `order_seed = HMAC(HKDF(bootstrap_secret, info), event_id || symbol || order_intent_id)` statelessly whenever needed.
- Replace `last_consumed_event_id` with an idempotency ledger keyed by `order_intent_id` or `(event_id, order_intent_id, version_namespace)`. One event can produce multiple order intents across active and shadow versions; event-level cursoring is too coarse.

### H3 — The nullity probe may be blind under the proposed PAPER key policy

D8 requires PAPER keys to have `enableReading=true` and `enableFutures=false`. D13 then proposes calling live `fetchOpenOrders()` once per minute to detect accidental exchange order leakage.

This may fail in exactly the mode where the probe is needed. Depending on Binance permission semantics, a key without futures capability may be unable to call futures open-order/private endpoints. The addendum then says transport errors are logged and ignored. If permission/auth failures are treated like transport errors, the leak detector silently becomes decorative.

Required change:

- During PAPER boot, perform a nullity-probe capability preflight. If the key cannot call the required read-only open-orders endpoint, PAPER must either abort or disable the probe with an explicit "probe unavailable, soak cannot count for M11b" flag.
- Separate failure classes:
  - Network / 5xx / timeout: log and continue for a bounded window.
  - 401 / 403 / permission / malformed credential: CRITICAL and abort PAPER startup.
  - Non-empty engine-attributed order response: CRITICAL halt.
- Prefer a dedicated PAPER observer key if Binance supports read-only futures order visibility without trade permission. If not, the plan should admit the probe cannot provide the stated guarantee.

### H4 — Splitting `IExecutionClient` is not enough to prevent live signed calls in PAPER

D2 splits order placement out of `IExchangeClient`, but `fetchBalance`, `fetchPositions`, `fetchOpenOrders`, and `fetchFundingHistory` stay on `IExchangeClient`. Existing services already call those methods:

- `AccountSnapshotWriter` calls `fetchBalance`.
- `ReconciliationService` calls `fetchPositions` and `fetchOpenOrders`.
- Funding/reconciliation paths call funding-history surfaces.

The addendum says the reconciliation adapter swaps in `PaperAccountStateService`, but it does not prove every existing account-state reader is replaced or disabled in PAPER. A compile-time split for orders does not protect the rest of the signed-account surface.

Required change:

- Introduce an explicit account-state port, for example `IAccountStateSource`, with `ExchangeAccountStateSource` for TESTNET/LIVE and `PaperAccountStateSource` for PAPER.
- Bind `AccountSnapshotWriter`, reconciliation phase 1, funding cashflow readers, and read-API account projections to that port, not directly to `IExchangeClient`.
- Add a PAPER module-graph test that fails if any provider reachable from the live loop can inject an exchange account/order method directly, except the intentionally whitelisted key-permission assertion and nullity probe.

### H5 — Reusing `BacktestRunnerService` for live event-time fills risks look-ahead

The addendum says `PaperFillSimulator` reuses M7 `BacktestRunnerService` fill logic on live event-time. The existing M7 fill model was built for historical replay and expects pre-resolved inputs such as ticks for a bar, book snapshots, bar highs/lows, and a closed replay window.

For PAPER, the simulator is running while the market is still unfolding. If it waits for future ticks before deciding whether an IOC missed, SL hit, or TP hit, it is not simulating live execution. If it decides immediately without the future path, it is not the same algorithm as the M7 replay path.

Required change:

- Do not wrap the whole `BacktestRunnerService` in PAPER.
- Extract a pure shared fill library with two adapters:
  - historical adapter: receives complete tick/book paths for backtest;
  - streaming adapter: receives only data observed up to the current event-time and schedules future checks through the live tick stream.
- Add a causality test: at time `t`, PAPER fill/exit decisions cannot read ticks or book snapshots with timestamp greater than `t`.

### H6 — Paper state, live position tables, and metrics are not coherently specified

D1 chooses a dedicated `paper_account_state` table to avoid polluting live `positions`. D12 says paper reconciliation compares `PaperAccountStateService` to `IPositionRepository`. W4 exit criteria still depend on metrics historically derived from `positions`, `transactions`, `risk_state`, and `account_snapshots`.

The plan needs to choose whether PAPER is:

1. fully separate from live position tables, with separate paper-specific metrics; or
2. dual-written into canonical position/transaction tables with a mode discriminator and strict read filters.

The addendum rejects option 2 but still relies on pieces of it.

Required change:

- Define the source of truth for each PAPER datum:
  - open paper position state;
  - closed paper trade PnL;
  - fees/funding/slippage;
  - risk-day trade count;
  - account equity curve;
  - read-API dashboard display;
  - soak-exit evaluator input.
- If `paper_account_state` and `positions` are both written, mandate one database transaction for every paper fill/account mutation. Drift caused by a crash between those writes should be structurally impossible, not merely detected later.
- If only paper tables are written, update the exit evaluator and dashboard/read API plan to read those tables explicitly.

### H7 — Funding-rate behavior is inconsistent across the addendum

D4 says a funding rate exceeding `|rate| <= 0.0075` is a warning, not a hard reject, and should still be applied. R2.7 and R3.1 later say the magnitude bound is "enforced", which reads like rejection or clamping.

There is also a test wording issue: the formula treats funding as account PnL (`LONG` at positive rate is negative PnL), but the test uses `side_sign × funding_paid > 0`, which obscures the actual assertion.

Required change:

- Replace "bound enforced" with "bound audited and alerted; raw rate still applied".
- Pin the sign convention in account terms:
  - positive funding PnL increases paper equity;
  - for `rate > 0`, long funding PnL must be `< 0`;
  - for `rate > 0`, short funding PnL must be `> 0`.
- Clarify the data source. Binance mark-price streams expose next funding metadata, while funding history/rates are often REST-pulled. Do not call it a "funding WS stream" unless the exact stream/event is named.

### H8 — Shadow comparison randomness conflicts with paired testing

D3 says v1 PAPER and v2/v3 shadow use independent order-intent namespaces so they do not receive correlated simulator rolls. The low-fidelity section then says v1 versus shadow v2/v3 is load-bearing because the same simulator and same noise let simulator bias cancel.

Those two ideas pull in opposite directions. For a paired comparison, common random numbers per event/version-pair can reduce variance and make the strategy difference easier to detect. Independent rolls increase noise and make the already-small soak sample less powerful.

Required change:

- Separate two concerns:
  - active PAPER execution should have deterministic, idempotent order seeds;
  - offline same-event strategy comparison should use a pre-registered variance-reduction scheme, likely common random numbers keyed by `(event_id, simulator_component, pair_id)`.
- Report both paired common-random-number CI and independent-noise robustness CI if the team is worried about over-correlation.
- Do not claim "same noise cancels" while deliberately making the noise independent.

## Medium-Risk Findings

### M1 — The low-fidelity downgrade makes the M11b gate too weak

The addendum correctly admits that every PAPER fill is `lowFidelity` until the depth-aware extension lands. It then downgrades the active-vs-shadow criterion to "v1's own expectancy CI excludes zero" when the low-fidelity-excluded subset is empty.

That is safer than pretending the criterion passed, but it is not enough to justify moving to M11b. A positive PAPER CI under an all-low-fidelity simulator is a joint test of strategy plus simulator assumptions. The document says this is necessary but not sufficient; the exit criteria should enforce that wording.

Recommended change:

- If all fills are low-fidelity, M11a can only close as "operational soak passed, trading edge still provisional".
- M11b should require either:
  - depth-aware extension landed and rerun; or
  - a tightly capped live micro-probe milestone with an explicit stop condition; or
  - an architect-approved waiver stating the first real-money period is still validation, not scale-up.

### M2 — TOST tolerance is circular and can become unusable

The pre-soak TOST sets `epsilon = 25% of v1's backtested expectancy`. If v1 expectancy is near zero, negative, or unstable across regimes, the tolerance becomes meaningless or impossible to satisfy. It also makes the simulator-bias tolerance depend on the very edge the simulator is supposed to validate.

Recommended change:

- Define epsilon in risk units, for example `0.05R` or a small percentage of per-trade risk budget, with a secondary cap relative to historical expectancy.
- Require v1's backtested expectancy on the calibration window to be positive before the TOST is evaluated.
- Run the zero-edge strategy across multiple random policies, not one arbitrary random-entry process.

### M3 — `paper_account_state` retention and audit policy need more detail

D1 says paper retention differs from live positions, but the plan does not specify retention floors for paper tables. Since the soak evaluator depends on paper state, pruning paper rows too early is as dangerous as pruning `decisions`.

Recommended change:

- Add paper tables to W3.10 retention:
  - `paper_account_state`: retain soak duration + 30 days;
  - `paper_state_audit`: archive, not prune, for the soak window;
  - `paper_account_state_meta`: retain at least through M11b decision.

### M4 — HMAC chains are useful, but not as strong as implied

The HMAC-chain design catches accidental corruption and some DB-only tampering. It does not protect against an attacker who can modify the DB and read the bootstrap secret or derived HMAC keys on the same host. It also adds considerable implementation complexity.

Recommended change:

- Phrase this as tamper-evidence, not tamper-proofing.
- Anchor chain tips outside the mutable database: append tip hashes to encrypted offsite backups, a local append-only log, or a daily operator-signed work-log entry.
- Consider reducing scope to the mode-transition chain first; add paper-state mutation chaining only if it remains necessary after the state model is clarified.

### M5 — R2 is too large for the project's own QA discipline

R2 includes an execution client split, a simulator, paper account state, audit chain, reconciliation adapter, nullity probe, funding accrual, and crash recovery integration. That is not "split if >5 items"; it is already larger than the dev-qa-cycle cap.

Recommended change:

- Make the split mandatory:
  - R2a: execution-client split + no-ccxt-order sentinel tests.
  - R2b: paper account state + atomic persistence + account-state port.
  - R2c: streaming fill simulator + funding + mark-to-market.
  - R2d: reconciliation/nullity probe + crash recovery.
- Run QA after each sub-wave before moving to the next. This is state-machine work; batching it invites regressions.

### M6 — PAPER no longer validates exchange order lifecycle

Local PAPER validates strategy/risk/ops against live market data. It does not validate Binance order placement, exchange rejections, partial fills, cancel semantics, or protective-order behavior. The old testnet path still matters for order-lifecycle readiness.

Recommended change:

- Keep `TESTNET` as a separate required drill before M11b:
  - place/cancel/open/close/protective-order lifecycle on Binance testnet;
  - reconciliation against exchange state;
  - rate-limit policy under harmless bursts.
- Treat PAPER and TESTNET as complementary:
  - PAPER: live-market operational/statistical soak;
  - TESTNET: exchange execution contract drill.

### M7 — The `fetchOpenOrders` prefix filter does not catch all accidental leaks

Filtering by the engine's client-order-ID prefix reduces false positives, but it also narrows the leak detector. A bug that bypasses the normal client-order-ID builder could leak an order without the expected prefix.

Recommended change:

- If using a dedicated PAPER-only key/account, require the full open-order set to be empty.
- If sharing an account is unavoidable, keep the prefix filter but add a separate boot invariant: PAPER refuses any key capable of trading, and any operator override invalidates the soak.

## What The Addendum Gets Right

- The `DEMO` correction is necessary. Keeping ccxt `enableDemoTrading()` would preserve a false safety story.
- PAPER rejecting `enableFutures=true` is the right safety default.
- A dedicated paper-state table is directionally better than mixing local simulator rows into live position tables, as long as the metrics/read paths are updated consistently.
- Per-tick mark-to-market for held symbols is correct under the restricted one-position profile.
- Treating PAPER drift as CRITICAL is right. With no exchange in the loop, paper-state drift is an engine bug.
- The addendum correctly recognizes that all-low-fidelity fills weaken the statistical interpretation.

## Suggested Plan Changes Before Implementation

1. Add a short "PAPER is not exchange demo trading" invariant near the top:
   PAPER validates strategy/risk/ops on live market data, but not live exchange execution semantics.

2. Replace R2 with mandatory sub-waves and mini-reviews. Do not allow one engine dispatch to touch all paper-mode surfaces.

3. Add an account-state port before paper implementation. The implementation should make it hard to accidentally call live account/order methods in PAPER.

4. Extract a shared fill-simulation core before building `PaperFillSimulator`. The current backtest runner is not a streaming execution simulator.

5. Rewrite the boot-mode transition section as an executable sequence, with exactly when rows are verified and appended.

6. Resolve the seed-storage contradiction. Derived seed material should not be persisted.

7. Make the nullity probe capability a boot-time gate. A probe that cannot read the endpoint must not silently count as protection.

8. Strengthen the M11b gate wording: all-low-fidelity PAPER expectancy is not enough to justify real-money go-live by itself.

## Proposed Revised Definition Of Done Additions

Add these to the addendum's definition of done:

- PAPER boot proves, via tests and module graph inspection, that no provider reachable from the live loop can call ccxt order methods.
- PAPER account snapshots, paper PnL, and soak-exit metrics read one explicitly named paper source of truth.
- Every paper account mutation and corresponding position/metric projection is atomic or replay-idempotent.
- `PaperFillSimulator` has a causality test proving it cannot read future ticks/book data.
- Nullity probe permission/auth failures abort PAPER startup; only transient transport failures are tolerated.
- Authorized mode transitions append transition rows in a tested, transactional order; unauthorized transitions append nothing.
- TESTNET exchange-order lifecycle drill remains a separate pre-M11b requirement.

## Go / No-Go Recommendation

Go for the conceptual replacement of `DEMO` with `PAPER`.

No-go for implementing R2 as currently written. The plan needs a short R0/R1 correction pass first, then a mandatory split of paper-mode state, simulator, and reconciliation work. The most important principle is to keep M11a honest: PAPER can be an excellent local soak harness, but it must not be allowed to masquerade as proof that real exchange execution and real fill quality are solved.
