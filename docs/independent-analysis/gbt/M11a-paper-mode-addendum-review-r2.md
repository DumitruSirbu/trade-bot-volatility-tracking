# Independent Review R2 — M11a Paper-Mode Addendum

## Executive Summary

Draft v5 is a strong improvement over the earlier paper-mode addendum. The main architectural corrections from the first review are now present: PAPER is explicitly not exchange demo trading, account-state access gets a dedicated port, `BacktestRunnerService` look-ahead risk is addressed by a shared fill core plus historical/streaming adapters, seed persistence is corrected, transition ordering is specified, low-fidelity PAPER output no longer silently opens M11b, and a TESTNET execution drill is restored as a separate gate.

I would approve the **direction** of the architecture. I would not yet treat the document as a safe dispatch contract, because several old sections still contradict the newer decisions. In this repo, plans and ADRs are executable instructions for subagents; stale wording is not harmless.

My recommendation is: **one plan-cleanup pass before implementation dispatch.** Most issues below are consistency fixes, not architectural rewrites.

## Resolution Check

| Prior finding | Status | Notes |
|---------------|--------|-------|
| Boot-mode transition ordering | Mostly resolved | D6 now defines executable boot ordering, transition rows, no-mutation aborts, and tests. R1.5 still has stale mismatch-abort wording. |
| Seed persistence contradiction | Resolved | D3 now derives seed material statelessly and persists only non-secret metadata plus an idempotency ledger. |
| Nullity probe blind spots | Mostly resolved | D13 checks open orders and positions, has capability preflight, and prefers a dedicated PAPER sub-account. Endpoint-access verification remains a real external blocker. |
| `IExecutionClient` split insufficient | Resolved in D14 | `IAccountStateSource` is the right port. D2 still says balance/position reads stay on `IExchangeClient`, which conflicts. |
| `BacktestRunnerService` live look-ahead | Resolved in D15 | Core/adapters design is correct. Top-level design still says PAPER reuses `BacktestRunnerService` live. |
| Paper/live table ambiguity | Resolved in D16 | PAPER-only tables and atomic writes are now specified. D12/R3/DoD still mention `IPositionRepository` / position-repo. |
| Funding sign/bounds inconsistency | Resolved | D4 now states account-PnL sign convention and "apply + audit + alert" for cap breaches. |
| Shadow randomness contradiction | Resolved and strengthened | D17 now separates active execution seeds from offline CRN comparison and adds a truth table. |
| Low-fidelity gate too weak | Resolved enough | All-low-fidelity outcome is "operational only, edge provisional" with explicit M11b branches. |
| TOST circularity | Resolved enough | Risk-unit asymmetric bands and power floor are better; quant should still review the chosen tolerances. |
| Paper retention floors | Resolved | D16 adds retention floors, including idempotency ledger in v5. |
| HMAC overclaim | Resolved | D6 now calls it tamper-evidence and anchors tips outside the DB. |
| R2 too broad | Resolved | R2a-R2d split is mandatory with mini-QA. |
| TESTNET execution contract | Resolved | TESTNET pre-M11b drill is required. |

## Must-Fix Before Dispatch

### R2-H1 — Top-level PAPER design still claims `BacktestRunnerService` live reuse

The design summary still says orders are routed to `PaperFillSimulator` that "reuses M7 `BacktestRunnerService` fill logic on live event-time." D15 later says that is exactly the correctness bug: `BacktestRunnerService` is historical replay and can see future bar paths.

Required edit:

- Replace that top-level bullet with: `PaperFillSimulator` uses `FillSimulatorCore` through `StreamingFillAdapter`; M7 backtests use the same core through `HistoricalFillAdapter`.
- Avoid the phrase "reuses BacktestRunnerService" anywhere in PAPER runtime sections.

### R2-H2 — D2 conflicts with D14 on account-state reads

D2 still says `fetchPosition` and `fetchBalance` stay on `IExchangeClient`. D14 says account-state reads move behind `IAccountStateSource`, with only two PAPER exceptions: `KeyPermissionAssertionService` and `PaperExchangeNullityProbe`.

This is a real contract conflict. If an implementer follows D2 literally, PAPER can still hit live signed account-state methods outside the intended port.

Required edit:

- Rewrite D2 as order-command-only: `IExecutionClient` owns place/cancel/order-status semantics.
- State that account-state reads are owned by `IAccountStateSource` per D14.
- If `IExchangeClient` remains the concrete ccxt adapter, make clear it is not injected into the PAPER decision loop for account state.

### R2-H3 — R1.5 still says mode mismatch aborts

R1.5 says the engine verifies chain integrity and aborts if the last `exchange_env` differs from current `EXCHANGE_ENV`. D6 now allows authorized transitions after token verification and appends transition + boot + rotation rows in one transaction.

Required edit:

- Replace R1.5 text with a direct reference to D6's boot sequence.
- Explicitly say unauthorized mismatch aborts with no mutation; authorized mismatch appends exactly the transition row, boot row, and rotation row in one transaction.

### R2-H4 — D12/R3/DoD still reference `IPositionRepository`

D16 says PAPER is fully separate from live position tables and reconciles in-memory `PaperAccountStateService` against persisted `paper_account_state` rows. But stale references remain:

- D12 says drift is between `PaperAccountStateService` and `IPositionRepository`.
- R3.1 says paper-state vs position-repo drift.
- Definition of done says reconcile `PaperAccountStateService` against `IPositionRepository`.

Required edit:

- Replace all PAPER reconciliation references to `IPositionRepository` / position-repo with `paper_account_state` / paper-history projections.
- Keep live `IPositionRepository` references only for TESTNET/LIVE paths.

### R2-H5 — Definition of done still has old nullity and MTM language

The DoD still says:

- `PaperExchangeNullityProbe` asserts `fetchOpenOrders` empty.
- MTM runs on every WS tick.

D13 now requires both `fetchOpenOrders` and `fetchPositions`. D5/D16 now say MTM is throttled and unrealized PnL is derived, not persisted.

Required edit:

- Update DoD to require the two-call nullity probe and its capability preflight.
- Update DoD to say drawdown abort evaluates within D5's throttle window, with derived unrealized PnL per D16.

### R2-H6 — R3.1 test wording still contains old assumptions

The tests list has several stale or imprecise lines:

- "PaperFillSimulator deterministic across SIGKILL replay" should mention idempotency lookup keyed by `(event_id, order_intent_id, version_namespace)`, not replaying "last 5 decisions" as the primary mechanism.
- "PaperReconciliationAdapter drift between paper-state and position-repo" should be paper-table drift.
- "M7 backtest equivalence byte-for-byte" was corrected in D15 to numerical equivalence, but some task wording still risks byte-for-byte expectations.

Required edit:

- Align R3.1 test names with D3, D15, and D16 exactly.
- Use "numerical equivalence with pinned tolerances" for fill-core extraction tests.

## Remaining Design Risks

### R2-M1 — Endpoint accessibility can still break the safety model

D8 correctly says endpoint accessibility must be verified. If Binance requires futures permission for the nullity probe endpoints, the plan has to choose between:

- keeping a non-tradeable read-only PAPER key and losing the probe, or
- allowing `enableFutures=true` on a dedicated zero-balance sub-account.

The latter is probably acceptable, but it weakens the clean "PAPER rejects tradeable keys" invariant.

Recommendation:

- Promote endpoint-accessibility verification to an explicit R0 blocker.
- Define the fallback profile now: dedicated sub-account, zero balance, zero positions, no transfer permissions, IP allow-list, trading authority bounded, full nullity probe, startup abort if balance becomes non-zero.

### R2-M2 — `FillSimulatorCore` placement needs an ownership decision

D15 / R2c.1 says `FillSimulatorCore` is extracted to `@bot/shared`. That package is supposed to hold shared contracts/enums/schemas. A fill simulator core may depend on engine money helpers, execution constants, and domain behavior.

Recommendation:

- Decide before implementation whether `FillSimulatorCore` belongs in `packages/shared` or in an engine-internal pure module used by both Backtest and Paper.
- If it goes into shared, keep it pure and dependency-light: no TypeORM entities, no Nest providers, no engine imports.
- If it stays engine-internal, put only the interfaces/result schemas in shared.

### R2-M3 — CRN paired sample excludes one-trades-one-skips events

v5 D17 says if one version trades and one skips, the pair is excluded from the paired sample. That solves CRN roll pairing, but it also removes exactly the events where strategies differ in selectivity. Since "skip" is first-class in this bot, excluding one-trades-one-skips events can bias the active-vs-shadow comparison toward only events where both versions were already willing to trade.

This is a new quantitative concern.

Recommendation:

- Quant reviewer should explicitly bless the exclusion rule.
- Consider reporting two series:
  - trade-vs-trade CRN series for fill-noise comparison;
  - full same-event series where skip has `r = 0`, using independent/no-fill roll handling.
- Do not let "active version beats shadow" depend only on the trade-vs-trade subset without an explicit caveat.

### R2-M4 — Base M11a plan remains superseded but still dangerous

The base `M11a-local-soak.md` still contains older DEMO language, `{enableReading, enableFutures}` key assertions, demo-state crash drill wording, and M7 `BacktestRunnerService` fill-simulator wording.

Recommendation:

- Before dispatching agents, either merge this addendum into `M11a-local-soak.md` or add a prominent supersession banner in the base plan.
- Subagent prompts should cite this addendum as the source of truth until the merge is done.

## Updated Go / No-Go

**Go** for the PAPER architecture after a cleanup pass.

The earlier no-go on R2 is lifted because v5 has the right structural split and fixes the core design gaps. The remaining no-go condition is narrower: **do not dispatch implementation from this document until stale contradictory text is removed.**

## Minimal Cleanup Checklist

1. Replace top-level `BacktestRunnerService` reuse wording with D15 core/adapters wording.
2. Rewrite D2 so account-state reads belong to `IAccountStateSource` per D14.
3. Replace R1.5 mismatch-abort wording with D6 authorized-transition sequence.
4. Replace all PAPER `IPositionRepository` / position-repo reconciliation references with paper-table reconciliation.
5. Update DoD for two-call nullity probe, throttled MTM, and derived unrealized PnL.
6. Align R3.1 tests with D3/D15/D16 wording, especially idempotency and numerical equivalence.
7. Promote endpoint-accessibility verification to a formal R0 blocker.
8. Decide whether `FillSimulatorCore` belongs in `packages/shared` or engine-internal pure code.
9. Ask quant review to bless or revise D17's exclusion of one-trades-one-skips events from paired CRN samples.
10. Merge or supersede `M11a-local-soak.md` before any implementation dispatch.
# Analysis of M11a-paper-mode-addendum.md (Draft v4)

## 1. Executive Summary
The Draft v4 of the `M11a-paper-mode-addendum.md` is an exceptionally robust and defensively engineered plan. It successfully incorporates all major findings from the previous review rounds (v3), closing critical blind spots and refining the statistical and architectural rigor of the PAPER mode. 

The addition of new architectural decisions (D14, D15, D16, D17) demonstrates a profound understanding of the subtle complexities involved in building a live-time paper simulator that must remain perfectly coherent with a historical backtester. The plan is now mature and ready for implementation.

## 2. Resolution of Previous Findings

### 2.1. D13: PaperExchangeNullityProbe Blind Spots
*   **Previous Concern:** The probe only checked `fetchOpenOrders()`, missing immediately-filled orders (Market/IOC) and raw `ccxt` leaks that didn't use the engine's client ID prefix.
*   **Resolution:** **Excellent.** The probe now checks **both** `fetchOpenOrders()` and `fetchPositions()`. Furthermore, it strongly recommends using a dedicated PAPER sub-account, allowing for an assertion of *absolute nullity* (zero orders, zero positions) without relying on brittle prefix filtering. The addition of a boot-time capability preflight ensures the probe cannot silently fail.

### 2.2. D5: Mark-to-Market Cadence on Every WS Tick
*   **Previous Concern:** Recomputing MTM and drawdown on every WS tick could saturate the Node.js event loop during high volatility.
*   **Resolution:** **Excellent.** The introduction of a throttle rule (max once per 100ms, or immediately on a >1 tick size move) perfectly balances event loop protection with the latency sensitivity required for drawdown aborts. The R3.1 event-loop-lag boundary test is a strong regression guard.

### 2.3. D6 & D7: Threat Model of HMAC Chains
*   **Previous Concern:** Cryptographic HMAC chaining adds complexity but doesn't protect against an attacker with host shell access. Legitimate DB restores would break the chain.
*   **Resolution:** **Good.** The plan now explicitly acknowledges the threat model ("tamper-evidence, not tamper-proofing"). It provides pragmatic operational mitigations, such as appending the chain tip hash to encrypted offsite backups and operator logs, and introduces a `CHAIN_RESTORE` row to handle legitimate DB restores gracefully.

### 2.4. Pre-soak Sanity Step (TOST) and Pessimistic Bias
*   **Previous Concern:** A symmetric TOST band would reject a pessimistically-biased simulator, which is actually safer for a conservative bot. The tolerance calculation was also circular.
*   **Resolution:** **Excellent.** The TOST procedure has been completely overhauled. It now uses **asymmetric bands** (`ε_upper = +0.05R`, `ε_lower = -0.15R`), strictly punishing optimistic bias while allowing a wider margin for safe pessimistic bias. The circularity was removed by defining the tolerance in terms of the per-trade risk budget.

### 2.5. D8: PAPER Allowlist and `enableFutures`
*   **Previous Concern:** Binance might require `enableFutures === true` to access necessary `fapi` endpoints (like funding rates or exchange info), which would cause the strict PAPER allowlist to crash the bot on boot.
*   **Resolution:** **Good.** An explicit "Endpoint-accessibility verification" pre-flight step has been added before R1 starts. If Binance restricts these endpoints, there is a clear fallback plan to amend D8 while enforcing the use of a dedicated sub-account with the D13 probe.

## 3. Analysis of New Additions (v4)

### 3.1. D14: `IAccountStateSource` Port
*   **Analysis:** Splitting `IExecutionClient` was insufficient because existing callers (reconciliation, snapshots, funding) still hit `IExchangeClient`'s account-state methods directly. Introducing `IAccountStateSource` and strictly binding callers to it prevents PAPER mode from accidentally leaking into live exchange state reads. The module-graph test (R3.1) to enforce this isolation is a brilliant addition.

### 3.2. D15: `FillSimulatorCore` Extraction
*   **Analysis:** Recognizing that M7's `BacktestRunnerService` is a historical replay engine (which sees the future of a bar) while PAPER is a live event-time engine is a critical correctness catch. Extracting the pure `FillSimulatorCore` and wrapping it in `HistoricalFillAdapter` and `StreamingFillAdapter` ensures that both modes use the exact same underlying logic without violating causality in live trading.

### 3.3. D17: Shadow Randomness
*   **Analysis:** Resolving the contradiction between independent rolls and Common Random Numbers (CRN) adds significant statistical rigor. Using independent rolls for active PAPER execution ensures realistic counterfactuals, while using a pre-registered CRN tape for offline comparison maximizes variance reduction and cancels out simulator bias.

## 4. Remaining Risks & Recommendations

While the plan is exceptionally solid, a few minor operational risks remain:

1.  **Binance API Rate Limits (D13):** The nullity probe runs `fetchOpenOrders` and `fetchPositions` once per minute. If the bot's symbol universe expands significantly, this could consume a large portion of the IP/UID rate limit weight. 
    *   *Recommendation:* Ensure the W1.4 token-bucket policy strictly accounts for this fan-out, and consider batching or using weight-efficient endpoints if the symbol count grows.
2.  **Implementation Complexity of `StreamingFillAdapter` (D15):** Implementing a streaming adapter that correctly schedules future-tick callbacks for intra-bar SL/TP without introducing memory leaks, race conditions, or event-loop blocking is non-trivial.
    *   *Recommendation:* Pay special attention to the cleanup of scheduled callbacks (e.g., `clearTimeout` or clearing internal queues) when a position is closed or an order is canceled, to prevent memory leaks during long-running soaks.

## 5. Conclusion
Draft v4 of the `M11a-paper-mode-addendum.md` is a masterclass in defensive engineering and quantitative rigor. The plan is fully approved for implementation. The wave structure (R0-R4) with mandatory splits (R2a-R2d) is well-calibrated to manage the complexity of the rollout.