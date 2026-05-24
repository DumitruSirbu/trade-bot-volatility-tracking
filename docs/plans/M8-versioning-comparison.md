# M8 — Strategy versioning & comparison

**Goal:** Compare strategy versions head-to-head on identical data and promote the
winner — the mechanism that answers "short the spike vs. follow it."

**Depends on:** M7 (backtesting).

## Tasks

- **Version lineage.** Use `parent_version_id` so a new version records its origin (copy-from-previous + tweak).
  - *Output:* lineage queryable; new versions link to parents.
- **Walk-forward / out-of-sample evaluation.** Compare versions on a train/validation/out-of-sample split (not a single in-sample range). A winner must hold up on held-out data.
  - *Output:* `compare_versions(a, b, range)` reports in-sample AND out-of-sample metrics.
- **Statistical significance + minimum sample (pinned method, raised bar).** Require **≥200 trades total per candidate** before any statistical claim; **≥100 trades in the target regime** for a regime-specific winner; and **≥30 calendar days of paper/live shadow** before any scaling. Use a **paired block bootstrap** (block size covering trade autocorrelation) on the per-trade **expectancy-per-unit-risk** difference series (not just raw return) — fixed n=10,000 resamples, **95% two-sided CI**. A winner must have a CI excluding zero; otherwise "inconclusive." Also report **skew, kurtosis, max single loss, expected shortfall, and longest losing streak**.
  - *Output:* the report states sample sizes against these thresholds, a bootstrap CI on expectancy per unit risk, and the tail-risk statistics; thin/insignificant results are flagged "inconclusive."

- **Compare by `event_id` (replaces paired timestamps).** Compare v0 / v1 / v2 / v3 + no-trade on the same `event_id` under the same market path. This replaces the fragile "identical trade timestamps" requirement, which breaks when versions enter and exit differently.
  - *Output:* per-`event_id` outcome distributions across all versions; comparison is robust to differing entry/exit timing.
- **Regime robustness with an objective classifier.** Label periods using the **same ADX(14) regime rule as the live strategy**: ADX < 20 = `ranging`, ADX > 25 = `trending_up`/`trending_down`, 20–25 = `transitioning`. Compute per-regime metrics for v0 (baseline), v1 (mean-reversion suppresses trending entries), v2 (momentum suppresses ranging entries), and v3 (router) separately. A winner must outperform on the regime(s) / flow types it targets.
  - *Output:* reproducible per-regime breakdown using the documented ADX classifier; regime breakdown matches the suppression logic in M3.
- **Promotion criteria.** A version is promotable only if it passes ALL of: net positive **expectancy** after fees + slippage + funding + missed fills; **profit factor ≥ 1.25 out-of-sample**; max drawdown within tolerance; worst 1-day loss survivable; and the edge survives the M7 robustness gates (doubled slippage, drop best 5%, stress windows, not concentrated in one symbol/week). **No daily-profit-target language applies** — success is risk-adjusted survival, not a profit quota. Mark the chosen version `active` and archive others; the live engine reads it.
  - *Output:* promoting changes live behavior via config/state; an inconclusive or robustness-failing candidate cannot be promoted.
- **Direction decision (v1 vs v2 vs v3 vs v0).** Run the no-trade baseline (v0), exhaustion-confirmed mean-reversion (v1), momentum (v2), and the hybrid router (v3) over the accumulated point-in-time dataset on the same `event_id`s. The comparison answers, per flow type / regime: fade, follow, or skip? Direction is never assumed — it is chosen from out-of-sample evidence + live shadow.
  - *Output:* a statistically-qualified recommendation for the initial live version (restricted v1) and the v3 end-state path, with per-regime / per-`flow_type` breakdown.

## Definition of done

A reproducible head-to-head report with out-of-sample + per-regime metrics and a
significance measure; only a statistically-qualified winner can be promoted to
`active`; the v1-vs-v2 comparison gives a data-backed, validated direction choice.

## Architecture (locked)

- **ADR 0016** — Strategy version lineage & promotion model (schema delta + state machine).
- **ADR 0017** — Walk-forward splits & same-event multi-version comparison
  (composition over `IBacktestReport`).
- **ADR 0018** — Statistical significance: paired circular block bootstrap on
  per-event expectancy-per-unit-risk; n=10000, 95% CI, gates at ≥200/100/30.
- **ADR 0019** — Promotion gate (12 all-of criteria; lives in the harness, not live).

The regime classifier (`computeRegimeLabel(adx, diPlus, diMinus)`) is reused
verbatim from `market-data/indicator/`; no parallel implementation.

## Carry-over reconciliation (from M7)

| M7 deferred item | Decision | Rationale |
|---|---|---|
| `force_close` exit reason enum | **Adopt in M8 W0** | Cheap mechanical edit on `ExitReasonEnum`; surfaces in `IComparisonEventOutcome` and removes the misleading `time_stop` placeholder. Routes through `bot-shared-maintainer`. |
| `OrderPolicyRouter` injection into `BacktestOrchestrator` | **Adopt in M8 W1** | Comparison runs across versions with different order policies need parametrised routing; hard-coded policy invalidates v0-vs-v3 comparisons because v3 changes routing by `flow_type`. |
| `eventAnchoredVwap` reconstruction from `decisions` table | **Defer past M8** | Live `decisions` writes are dry-run-only until live trading (M11). The replay-from-`decisions` path has no calibration data yet. Backtest's `SymbolMarketState`-recomputed value is the right source for M8. Re-evaluate during M11 once live `decisions` accumulate. |
| Depth-aware slippage extension (`DepthAwareSlippageExtension`) | **Defer to M9** | Pre-M5 `book_snapshots` coverage is sparse; M8's promotion gate already handles low-fidelity dependence (ADR 0019 criterion 12) by re-running metrics with `lowFidelity=true` trades excluded. Building the depth-aware path before depth data exists is premature. |
| M2 partition rollover task (pre-M8 deferred in CLAUDE.md) | **Adopt in M8 W0** | Bundle alongside `force_close` enum — both are small, mechanical, harness-blocking issues. |

## Implementation waves

≤5 files per wave where realistic; mechanical edits folded into bigger waves.

| Wave | Scope (one line) | Target agent | Depends on |
|---|---|---|---|
| **W0** | `ExitReasonEnum.force_close`; M2 partition rollover task; `bot-shared-maintainer` exports updates | `bot-shared-maintainer` | — |
| **W1** | `OrderPolicyRouter` parametrised injection into `BacktestOrchestrator` + paired test | `bot-engine-nestjs` | W0 |
| **W2** | Schema delta from ADR 0016: migration + `comparison_reports` table + `StrategyVersionEntity` audit columns | `bot-engine-nestjs` | W0 |
| **W3** | `WalkForwardPlanner` (pure), `IWalkForwardSplitPolicy`, fold-determinism tests | `bot-engine-nestjs` | W1 |
| **W4** | `ComparisonRunnerService` — drives `BacktestRunnerService` over `(version, fold, in-sample/oos)` cells; in-memory `eventTape` recording mode | `bot-engine-nestjs` | W2, W3 |
| **W5** | `IPairwiseBootstrapResult`, paired block bootstrap (ADR 0018), Politis–White block-length, seeded `mulberry32`, sample-size gates, tail-risk stats | `bot-engine-nestjs` | W4 |
| **W6** | `PromotionGateService` (ADR 0019 12 criteria), `promotionGateConsts.ts`, `PromotionService.promote` TX, `reactivate` path | `bot-engine-nestjs` | W2, W5 |
| **W7** | CLI: `pnpm engine strategy compare ...`, `pnpm engine strategy promote ...`, JSON artefact writer | `bot-engine-nestjs` | W6 |
| **W8** | Adversarial QA — fold-overlap edge cases, empty-tape, single-event tape, sample-gate boundaries, multiple-active race (TX should reject), inconclusive vs reject taxonomy | `bot-qa-engineer` | W7 |
| **R-waves** | Multi-reviewer (security/logic/clean-code/quant) then fix waves until 0 blocker / 0 high / majority medium resolved | reviewers + `bot-engine-nestjs` | W8 |
| **Close** | `bot-scribe`: outcome section, deferred items log, work-log entry | `bot-scribe` | R-waves |

## Open questions for the orchestrator

1. **Politis–White block-length library** — vendor or hand-roll? Screening for
   license + numerical correctness is W3's first action.
2. **Hash function for the bootstrap seed** — must be stable across Node
   versions. Candidates: `xxhash`, fnv-1a. Pick at W5.
3. **`MAX_DD_TOLERANCE_PCT` and `WORST_DAY_LOSS_TOLERANCE_PCT` starting values**
   — placeholders in W6; first concrete comparison run will inform calibration
   and a follow-up PR may tune them.
4. **Regime-target map (ADR 0019 criterion 11)** for v3 hybrid router — v3's
   flow-classifier targets multiple regimes; the gate map needs explicit
   entries (`v3 must beat baseline on at least 2 of {ranging, trending_up,
   trending_down}`?). To be locked at W6.
5. **Engine restart on promote** — currently documented as a runbook step. If
   M9 (observability) adds a hot-reload signal, ADR 0016 §2.4 is the place to
   revisit. M8 ships with the restart requirement.
6. **Same-event tape when v3's router *suppresses* via `flow_type` upstream of
   the strategy** — resolved in ADR 0017 §5: the tape is built from the
   upstream M1 trigger predicate, which is version-agnostic. v3's suppression
   surfaces as `action='skip'` for that event.

## Outcome

**Definition of done met.** Reproducible head-to-head report with out-of-sample + per-regime metrics and statistical significance gates. Only a statistically-qualified winner can be promoted to `active` via a 12-criterion all-of gate (ADR 0019). Direction decision (v0 baseline, v1 reversion, v2 momentum, v3 hybrid) now data-backed per regime / flow type.

**Implementation waves shipped (W0–W8 + R-Fix × 3):**
- **W0:** `ExitReasonEnum.FORCE_CLOSE` shared addition + engine swap; M2 partition-rollover paired test (service already existed).
- **W1:** `OrderPolicyRouter` parametrised injection (`IOrderPolicyRouter` DI token); v3 exercises real flow-typed routing in backtest; documented behavioral divergence vs. pre-change baseline.
- **W2:** Schema delta migration (audit columns, partial unique index `uq_strategy_versions_active_per_name`, `comparison_reports` table + FK); `ComparisonReportEntity` + repository.
- **W3:** Pure `WalkForwardPlanner` (rolling + expanding, deterministic, JSON-round-trip-stable folds); 14 unit tests.
- **W4:** Event tape recording/replay on `BacktestRunnerService`; `ComparisonRunnerService` driver; `ITapedEvent`, `IComparisonEventOutcome`, `IComparisonReport` placeholders.
- **W5a:** Pure stats primitives — `mulberry32`, `fnv1a32`, `politisWhite` (Politis-White §3.1, K=2), `circularBlockBootstrap` (n=10000, 95% CI), `computeTailRiskStats`, `computeRegimeBreakdown`; 35 tests.
- **W5b:** Shared `IBacktestTradeResult.riskBudgetSpent`; engine populates from clamped stop; `BootstrapStatsService` paired bootstrap; integrated into `ComparisonRunnerService` (pairwiseStats / regimeBreakdown / tailRiskByVersion / multipleComparisonNote).
- **W6:** `PromotionModule`, `PromotionGateService` (12 criteria; criteria 7 + 9 deferred to W6.1 with `severity: 'deferred'` → `inconclusiveReason: 'robustness_pending'`), `PromotionService.promote`/`reactivate` in SERIALIZABLE TX, `promotionGateConsts`, `IPromotionGateOutcome`, `PromotionRejectedException`.
- **W7:** CLI `pnpm engine strategy compare/promote/reactivate`. Compare resolves versions, drives `ComparisonRunnerService`, writes full report JSON to `BACKTEST_ARTEFACT_ROOT`, persists slim `comparison_reports` row. Promote rejects with structured failure table. Reactivate is operator-only rollback.
- **W8:** 59 adversarial tests across WalkForwardPlanner, bootstrap math, ComparisonRunner, PromotionGate, PromotionService TX, CLI surfaces. Found 0 production bugs; 2 cosmetic findings.

**Review & fix cycle: R-Fix #1–#3 (cycle ran until clean):**
- **R-Fix #1:** 1 blocker (PromotionService.requireReportPromotesVersion — load artefact, validate `decision === 'promote'` inside TX) + 4 highs (regime/shadow counter fall-through; ADR 0018 §2.1 wording to post-clamp semantics + comment refresh; `BacktestEventBuilder` import `computeRegimeLabel` from market-data; `aggregateOosCells` uses decimal arithmetic).
- **R-Fix #2:** 5 mediums (artefact path allow-list + `ArtefactPathOutsideRootException`; raw `Error` → domain exceptions; magic constants → `*Consts.ts` + `MS_PER_WEEK`; criterion-11 `observed` carries regime label; `politisWhite` ACF array extended to `2·K_N` with capped `selectBandwidthM` search).
- **R-Fix #3:** 5 mediums (`ConcurrentPromotionConflictException` wrapping PG `23505`/`40001` + paired concurrent-promote test; `parseFlagMap` extracted to `cliArgs.ts`; `@InjectDataSource` exception comment; `TODO M8 W6.1` anchored; skew/kurtosis documented as population/biased).
- **Final:** `PromotionService.readPromotionDecision` mirrors `loadReportArtefact`'s path containment check (defense-in-depth).
- **Final state:** 0 blockers, 0 highs, 11/12 mediums resolved (12th — CLI auth `STRATEGY_CLI_TOKEN` — deferred as accepted threat in operator-only context). 264 focused tests pass; 254+ adversarial + integration green; build clean.

**ADRs added:** 0016 (version lineage), 0017 (walk-forward splits), 0018 (paired bootstrap, §2.1 refreshed), 0019 (promotion gate, 12 criteria).

**Known approximations & deferred items (carry into M9):**
- Promotion gate criteria **7 (doubled-slippage)** and **9 (stress-windows)** deferred to **M8 W6.1** (robustness re-runs orchestration). Current gate emits `severity: 'deferred'` → `inconclusive` with `inconclusiveReason: 'robustness_pending'`; no candidate can be promoted on incomplete robustness evidence.
- `eventAnchoredVwap` reconstruction from `decisions` deferred past M8 (no live calibration data yet — M11 territory).
- Depth-aware slippage extension deferred to M9 (`book_snapshots` coverage too sparse pre-M5).
- CLI auth deferred — operator-only host context accepted as threat model; track in M11 go-live hardening.
- One remaining low: `politisWhite.ts` comment slightly overstates ACF extension mechanism (cosmetic doc precision, not numerical).
- `BacktestExecutionSink.findPositionForFill` symbol+side fallback safe for 3-slot model but could mismatch if invariant relaxes (flag for M11).

**Test totals (post-M8):** Backtest module 9 suites, Strategy module 8 suites (incl. CLI), Promotion module 3 suites; targeted run 20 suites / 264 tests all green; plus adversarial + integration suites (concurrent-promote, migration, repository) all green.

**Pre-M9 deferred items:**
- M8 W6.1 — robustness re-runs (criteria 7 + 9).
- M2 partition-rollover (carry if container volume freshly created).
- CLI auth model (M11 go-live hardening).
- `eventAnchoredVwap` reconstruction (M11).
- Depth-aware slippage extension (M9).
- `politisWhite.ts` comment precision (cosmetic; M9 cleanup).
