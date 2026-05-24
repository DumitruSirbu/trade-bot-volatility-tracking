# ADR 0019 — Promotion gate (M8)

**Status:** Accepted (M8 design wave)
**Date:** 2026-05-24
**Milestone:** M8
**Depends on:** ADR 0016 (lineage + promotion mechanism), ADR 0017 (walk-forward + same-event comparison), ADR 0018 (statistical significance).
**Related:** `docs/plans/M8-versioning-comparison.md` (Promotion criteria task).

## 1. Context

ADR 0016 says *how* a promotion changes state. ADR 0017 says *what* a
comparison run produces. ADR 0018 says *how the statistical claim is made*.
This ADR defines the **gate**: the all-of checklist a candidate must satisfy
before `PromotionService.promote(versionId, reportId, note)` is allowed to
flip a row to `active`.

The gate lives **in the harness, not in the live engine.** The live engine
reads `status = 'active'` and does not re-evaluate promotion criteria at
runtime. This is correct: the gate is a property of the comparison run, and
re-evaluating it on a hot loop would be wasted work.

## 2. Decision

### 2.1 Gate location

`PromotionGateService.evaluate(versionId, reportId) → IPromotionGateOutcome`
runs as part of the CLI `pnpm engine strategy promote --version-id=N --report-id=M --note="..."`.

`PromotionService.promote` calls `PromotionGateService.evaluate` first; a
`decision !== 'promote'` outcome rejects the promotion with the failed
criteria attached. **There is no `--force` flag.** Reversal of an
already-promoted version goes through `reactivate(archived_id)` against the
prior `active`; it does not bypass the gate going forward.

### 2.2 The all-of criteria

A candidate is promotable iff **every** condition holds, on the **OOS folds**
of the comparison report:

| # | Criterion | Source | Threshold |
|---|---|---|---|
| 1 | Net positive expectancy after fees + slippage + funding + missed fills | `IBacktestReport.expectancyR` per OOS fold | strictly > 0, every OOS fold |
| 2 | Profit factor on OOS | `IBacktestReport.profitFactor` per OOS fold | ≥ **1.25**, every OOS fold |
| 3 | Max drawdown on OOS | `IBacktestReport.maxDrawdownPct` | within `MAX_DD_TOLERANCE_PCT` (config; default operator-level, see §2.4) |
| 4 | Worst single-day loss is survivable | daily equity-curve series | absolute worst day ≤ `WORST_DAY_LOSS_TOLERANCE_PCT` of starting equity |
| 5 | Statistical significance | ADR 0018 paired bootstrap vs. the current `active` version of the same `name` | `winner === candidate`, CI excludes zero, **not `inconclusive`** |
| 6 | Sample sufficiency | ADR 0018 §2.5 | gates pass: ≥200 trades total, ≥100 in target regime, ≥30 days shadow |
| 7 | Robustness — slippage stress | M7 robustness gate: re-run with doubled slippage | criteria 1+2 still hold |
| 8 | Robustness — drop-best-5% | M7 robustness gate: remove top 5% of trades by net PnL | criteria 1+2 still hold |
| 9 | Robustness — stress windows | M7 stress-period set (FTX, LUNA, high-liq days, etc.) | net expectancy ≥ 0 across the union of stress windows |
| 10 | Robustness — concentration | trade distribution by symbol and by ISO week | no single symbol > 40% of trades, no single week > 30% of trades |
| 11 | Regime targeting | per-regime breakdown | candidate beats current `active` on the regime(s) / flow types it targets (e.g., v1 mean-reversion: `ranging` and `transitioning`; v2 momentum: `trending_*`) |
| 12 | Low-fidelity dependence | `IBacktestReport.lowFidelityTradeCount / totalTradeCount` | edge survives recomputing metrics with `lowFidelity=true` trades excluded (criteria 1+2 still hold) |

**No daily-profit-target language applies.** A version that passes 1–12 but
"only" yields 2%/month is promotable. A version that yields 30%/month but
fails any of 1–12 is not.

### 2.3 The outcome shape

```text
IPromotionGateOutcome {
  versionId:         number
  reportId:          number
  decision:          'promote' | 'reject' | 'inconclusive'
  passedCriteria:    number[]               // indices 1..12
  failedCriteria:    Array<{
    index:           number
    name:            string
    threshold:       string
    observed:        string
    severity:        'block' | 'inconclusive'
  }>
  evaluatedAt:       Date
}
```

- `promote` — all 12 pass.
- `reject` — at least one criterion is a `block` failure (1, 2, 3, 4, 7, 8, 9, 10, 11, 12).
- `inconclusive` — only criterion 5 or 6 (statistical / sample) is the cause;
  the candidate may pass on a future re-run with more data.

### 2.4 Where the thresholds live

`MAX_DD_TOLERANCE_PCT`, `WORST_DAY_LOSS_TOLERANCE_PCT`, the regime-target map
per version-`direction`, and the concentration thresholds (§2.2 criterion 10)
live in `apps/engine/src/promotion/const/promotionGateConsts.ts` (new in M8).
**Not** in `strategy_versions.params` — these are *operator-level* policy on
the bar to clear, not per-strategy config. A change to the bar happens via a
single PR with full review, not by editing a candidate's params row.

This is consistent with `docs/plans/00-overview.md` cross-cutting risk § "Sizing
inputs absent from params/config" — operator policy lives in module consts.

### 2.5 How promotion changes live behaviour

1. Operator runs comparison: `pnpm engine strategy compare --from=... --to=... --versions=v0,v1.0,v1.1,v2,v3 --split-policy=default`.
2. Harness writes `comparison_reports` row, returns `report_id`.
3. Operator inspects the report; picks a candidate.
4. Operator runs `pnpm engine strategy promote --version-id=N --report-id=M --note="..."`.
5. `PromotionGateService.evaluate` runs; if `decision === 'promote'`,
   `PromotionService.promote` runs the transaction (ADR 0016 §2.2).
6. **Engine restart** picks up the new `active` row at boot via
   `StrategyVersionRepository.findActive(name)`. The live engine **does not
   reload mid-session** (ADR 0016 §2.4).

The live engine has **no awareness** of the gate. Its only contract with M8 is
"read the row marked `active`." This keeps the live trade loop free of any
comparison/promotion logic.

## 3. Consequences

**Positive**
- Promotion is a single command with a single deterministic outcome.
- The live engine is unaffected by the M8 module — it reads one row.
- All thresholds are in one file (`promotionGateConsts.ts`); a future policy
  change is auditable.
- Reversal is symmetric: a regression is `reactivate(archived_id)`.

**Negative**
- 12 criteria is a lot — every gate report needs a clear renderer. M8 W4 owns
  the CLI output format.
- A passing candidate still requires an engine restart. Documented in the M8
  runbook.

## 4. Alternatives considered

1. **Soft gate (warn, allow override).** Rejected — overrides become the
   default under pressure. The whole point of the gate is "no promotion of
   a noise-driven candidate." If a real candidate is genuinely blocked by a
   threshold mis-calibration, the fix is to tune the threshold via PR (with
   review), not via a flag.
2. **Promotion criteria as `strategy_versions.params` JSONB.** Rejected — see §2.4.
3. **Gate inside the live engine.** Rejected — the live engine should not
   re-derive promotion decisions on the hot loop; that risks behavioural drift
   between "what was promoted" and "what live thinks is active."
4. **Bake the gate into the `comparison_reports` row and skip the separate
   `PromotionGateService`.** Tempting. Rejected because the gate evaluates
   against the **current** `active` baseline at promotion time, which may have
   changed since the report was generated. Evaluating fresh at promotion time
   prevents the "stale report promotes against an old baseline" footgun.
5. **Single composite score instead of 12 criteria.** Rejected — composite
   scores hide tail-risk failures. Risk-adjusted survival demands that each
   safety criterion be inspected independently.

## 5. Open questions

- **Concentration thresholds (40% per symbol, 30% per week)** — these are the
  starting values from the M7 robustness language. The exact numbers may need
  tightening once M8 produces the first concrete comparison report; the
  thresholds live in `promotionGateConsts.ts` so the change is one PR.
- **Regime-target map (criterion 11) source of truth.** Decision: a `const`
  in `promotionGateConsts.ts` keyed on `StrategyDirectionEnum`. v0 (baseline)
  is exempt — never promoted to live.
