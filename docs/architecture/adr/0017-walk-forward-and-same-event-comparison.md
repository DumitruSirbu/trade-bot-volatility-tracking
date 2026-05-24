# ADR 0017 — Walk-forward splits & same-event multi-version comparison (M8)

**Status:** Accepted (M8 design wave)
**Date:** 2026-05-24
**Milestone:** M8
**Depends on:** ADR 0003 (strategy), ADR 0015 (backtest module), ADR 0016 (lineage).
**Related:** `docs/plans/M8-versioning-comparison.md` (tasks: walk-forward, compare-by-event_id, regime-robustness).

## 1. Context

M7 ships `BacktestRunnerService.run(config) → IBacktestReport` over a single
date range and a single version. M8 must add two orthogonal things:

1. **Walk-forward / out-of-sample evaluation.** A winner must hold up on held-out
   data, not just the window it was tuned on.
2. **Same-event multi-version comparison.** v0/v1/v2/v3 + no-trade are evaluated
   on the **same `event_id` under the same market path**, so the comparison is
   robust to differing entry/exit timing across versions (per M8 brief).

Both must compose with the existing `IBacktestReport` rather than fork it.

## 2. Decision

### 2.1 Walk-forward split protocol

A **comparison run** takes a single date range `[from, to)` and a split policy and
produces one `IBacktestReport` per `(version, split-window, in-sample|oos)` cell.

**Split policy** (`IWalkForwardSplitPolicy`):

```text
{
  trainBars:      number   // e.g. 60 days
  validationBars: number   // e.g. 14 days
  oosBars:        number   // e.g. 14 days
  stepBars:       number   // e.g. 14 days  (rolling step; oosBars by default = no overlap)
  mode:           'rolling' | 'expanding'
}
```

- **Rolling:** each fold is a fixed-length `(train, validation, oos)` triple
  advanced by `stepBars`. The default.
- **Expanding:** `train` grows from the start of the range; `validation` and
  `oos` slide.

`WalkForwardPlanner.plan(range, policy)` is **pure and deterministic** — given
a range + policy it returns the same `IWalkForwardFold[]` every call.
`IWalkForwardFold` is persisted on the comparison run row so a re-run reproduces
the same folds.

```text
IWalkForwardFold {
  foldIndex:        number
  trainFromMs:      number  trainToMs:      number
  validationFromMs: number  validationToMs: number
  oosFromMs:        number  oosToMs:        number
}
```

**Parameter selection.** M8 does *not* introduce automated hyperparameter
search. Params are taken from `strategy_versions.params` as-is; validation is
used only to **reject** candidates whose validation metrics drop materially
versus train (overfit detector). OOS is the bar a candidate must clear to be
promotion-eligible (ADR 0019).

### 2.2 Same-event multi-version comparison

A comparison run accepts a **set of candidate versions** (`v0,v1,v2,v3 + any
draft rows`) and replays them over **one shared event tape**:

1. `BacktestRunnerService` runs once with a **special "event recording" mode**
   that loads candles, reconstructs indicator state, and emits the
   `IVolatilityDetectedEvent` stream — but does **not** route to any strategy.
   The stream is keyed by `event_id` (stable per trigger, M3 contract) and
   persisted in-memory as the run's `event tape`.
2. For each candidate version, `BacktestRunnerService` replays **the same tape**.
   The strategy + risk gate + fill simulator decide per-event whether the
   version trades or skips. The market path between events is identical across
   versions (same candles, same ticks, same funding).
3. Each version's outcome per `event_id` is recorded as one row in the run's
   **per-event outcome table** (§2.3).

**Critical:** event detection is upstream of the strategy and uses the same
trigger predicate the live `MarketDataModule` runs (ADR 0015 §4.2). The event
set is therefore version-agnostic. Different versions may **route** the same
event differently (open/skip/wait), but the event itself fires identically.

### 2.3 Per-event outcome table (in-memory; persisted as comparison report artefact)

```text
IComparisonEventOutcome {
  eventId:              string           // M3 stable trigger id
  symbol:               string
  triggerTs:            number
  regime:               RegimeLabelEnum  // ADX-labelled at trigger time
  flowType:             FlowTypeEnum
  outcomesByVersion:    Map<versionId, {
    action:             'open' | 'skip' | 'missed'   // missed = limit not filled within cancel timeout
    netPnl?:            MoneyValue                   // decimal; null if skip
    holdMs?:            number
    rPerUnitRisk?:      number                       // expectancy unit: netPnl / post-clamp risk-budget-spent (decimal-derived ratio; see ADR 0018 §2.1)
    exitReason?:        ExitReasonEnum
    lowFidelity?:       boolean
  }>
}
```

`rPerUnitRisk` per trade is the unit of analysis for the bootstrap (ADR 0018).
For `skip` and `missed`, `rPerUnitRisk = 0`. Decimal-derived; the ratio is the
only `number` exposed at the boundary and is computed from decimal arithmetic
upstream.

### 2.4 Composition with `IBacktestReport`

`IComparisonReport` composes M7 reports — it does not replace them.

```text
IComparisonReport {
  runId:               string
  rangeFromMs:         number   rangeToMs: number
  splitPolicy:         IWalkForwardSplitPolicy
  folds:               IWalkForwardFold[]
  versions:            { versionId; name; version; direction; paramsHash }[]
  perFoldReports:      Map<(versionId, foldIndex, 'train'|'validation'|'oos'), IBacktestReport>
  eventOutcomes:       IComparisonEventOutcome[]            // tape-wide; one row per (event_id)
  pairwiseStats:       IPairwiseBootstrapResult[]           // ADR 0018
  regimeBreakdown:     Map<(versionId, RegimeLabelEnum), IRegimeMetrics>
  promotionDecisions:  Map<versionId, IPromotionGateOutcome>  // ADR 0019
  lowFidelityTradeCount: number
}
```

`IBacktestReport` is the leaf. The comparison harness calls
`BacktestRunnerService.run` once per `(version, fold, in-sample|oos)` cell and
keys the result. Re-using `BacktestRunnerService` keeps the live-vs-backtest
equivalence claim intact — the comparison harness is a **driver**, not a new
engine.

### 2.5 Regime classifier reuse — no new code

`computeRegimeLabel(adx, diPlus, diMinus)` already lives in
`apps/engine/src/market-data/indicator/computeRegimeLabel.ts` and is consumed by
the live strategies. The backtest reuses it via `SymbolMarketState`
(ADR 0015 §4.2). M8 **imports the same function** and stamps each event with
its regime at trigger time. No parallel classifier exists. If a future
adjustment is needed, the change happens in one file and propagates to live +
backtest + comparison atomically.

### 2.6 Comparison-run anchor (persistence)

`comparison_reports` is a new table:

```text
comparison_reports
  id            bigserial pk
  run_label     text                                    -- operator-supplied
  from_ms       bigint   to_ms bigint
  split_policy  jsonb                                   -- IWalkForwardSplitPolicy
  folds         jsonb                                   -- IWalkForwardFold[]
  version_ids   integer[]                               -- FK refs to strategy_versions
  summary       jsonb                                   -- aggregated metrics; full report on disk
  artefact_uri  text                                    -- file path for full JSON IComparisonReport
  created_at    timestamptz default now()
```

`strategy_versions.promotion_report_id` (ADR 0016) FKs this table. The full
`IComparisonReport` JSON is written to disk (or S3 in M11); only the summary
lives in Postgres to keep the row size bounded.

## 3. Consequences

**Positive**
- One event tape, many versions: comparison is by `event_id`, not by
  fragile timestamp-paired trades.
- Walk-forward folds are pure functions of `(range, policy)` — runs reproduce.
- Composition over fork: `IBacktestReport` continues to be the leaf; the
  comparison harness is one layer up.
- Regime classifier is single-sourced.

**Negative**
- The event-recording pass replays candles twice (once to extract the tape,
  once per version to evaluate). The redundancy is acceptable for M8's
  comparison cadence (offline, hours-scale runs) and keeps the runner simple.
  An optimisation that fans out N evaluators on a single pass is deferred.
- `comparison_reports.artefact_uri` introduces a file-system dependency. For
  M8 this is local disk; M11 will swap for S3.

## 4. Alternatives considered

1. **No walk-forward; single in-sample range.** Rejected — the M8 brief
   explicitly requires train/validation/OOS, and the promotion gate (ADR 0019)
   uses OOS profit factor as a pass condition.
2. **Train/test split by random sampling within the range.** Rejected — breaks
   temporal causality. The hold-out must be chronological.
3. **Per-version event tapes.** Rejected — defeats the purpose of "same-event
   comparison." A version's `skip` is only meaningful relative to peers
   evaluating the same event.
4. **Persist every per-event outcome row in Postgres.** Deferred — at M8 cadence
   the JSON artefact is sufficient. A future migration can hoist the table when
   query patterns demand it.
5. **Hyperparameter grid search inside the harness.** Rejected for M8 — out of
   scope per the brief. M13's agentic loop is the place for search.

## 5. Open questions

- **`event_id` continuity across versions when v3's router suppresses a trigger
  upstream.** Decision: the event tape is built from the **upstream detector
  output** (M1 trigger predicate), which is version-agnostic. Suppression is a
  *strategy* decision and is recorded as `action='skip'` for that version. So
  every version sees every event; what differs is the decision.
- **Block size for the bootstrap** (deferred to ADR 0018).
