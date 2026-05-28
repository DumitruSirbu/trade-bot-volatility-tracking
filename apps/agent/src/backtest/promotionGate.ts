// M13 W4 — operator-facing promotion-gate evaluator.
//
// Applies ADR 0019's 12-criterion checklist to the draft's IBacktestReport,
// comparing against the active baseline where the criterion calls for it. The
// agent NEVER enforces promotion — `passes` is purely informational; the loop
// always persists the draft regardless. The gate exists so the operator can
// scan one column in the weekly report and decide whether to run the engine
// `strategy promote` CLI (which has its own enforcing PromotionGateService).
//
// Criteria whose source fields are not present on the current shared
// `IBacktestReport` shape are surfaced with `measured: 'NOT_AVAILABLE'` and
// `passed: false` so a half-evaluated gate cannot silently pass. The inline
// comment on each such criterion points to the missing field; the gate
// upgrades automatically once the engine wires the field through.

// eslint-disable-next-line no-restricted-imports -- agent-internal `src/mcp/` directory; ADR 0035 §2.3 layer B targets WORKSPACE reaches (apps/mcp / packages/analysis), not the agent's own subdirectories.
import type { BacktestReportParsed } from '../mcp/schemas.js';

import { bootstrapCiPassesZero } from './comparisonStats.js';

// ---------------------------------------------------------------------------
// Operator-policy thresholds (mirror `promotionGateConsts.ts` from M8 / ADR
// 0019 §2.4). The engine-side gate is the source of truth; these are the
// agent's read-only mirror for advisory rendering only.
// ---------------------------------------------------------------------------

export const MIN_PROFIT_FACTOR = 1.25;
// M13 W6 fix wave 2 (#3): MUST mirror
// `apps/engine/src/promotion/const/promotionGateConsts.ts MAX_DD_TOLERANCE_PCT`.
// The engine-side constant is the enforcing source of truth (PromotionGateService
// rejects when |maxDrawdownPct| > this value); the agent's advisory PASS must
// match the engine's REJECT bar or the operator sees contradictory verdicts.
// A loose mirror (e.g. 20 when the engine is at 15) would silently flag PASS
// for drafts the engine would reject — never widen this without first updating
// the engine-side constant + ADR 0019.
export const MAX_DD_TOLERANCE_PCT = 15;
export const WORST_DAY_LOSS_TOLERANCE_PCT = 5;
export const MIN_TRADE_COUNT = 200;
// Mirrors `apps/engine/src/promotion/const/promotionGateConsts.ts MAX_SYMBOL_CONCENTRATION_PCT`.
// The advisory criterion 10 reads the same threshold as the enforcing engine
// gate so PASS/FAIL verdicts agree.
export const MAX_SYMBOL_CONCENTRATION_PCT = 40;
export const LOW_FIDELITY_RATIO_FLOOR = 0.5; // edge survives if non-low-fidelity trades are at least half

export const NOT_AVAILABLE = 'NOT_AVAILABLE';

export interface ICriterionResult {
    readonly index: number;
    readonly name: string;
    readonly threshold: string;
    readonly measured: string;
    readonly passed: boolean;
}

export interface IPromotionGateEvaluation {
    readonly passes: boolean;
    readonly criteria: readonly ICriterionResult[];
}

export function evaluatePromotionGate(draft: BacktestReportParsed, active: BacktestReportParsed): IPromotionGateEvaluation {
    const criteria: ICriterionResult[] = [
        evalCriterion1NetPositiveExpectancy(draft),
        evalCriterion2ProfitFactor(draft),
        evalCriterion3MaxDrawdown(draft),
        evalCriterion4WorstDayLoss(draft),
        evalCriterion5StatSignificance(draft),
        evalCriterion6SampleSufficiency(draft),
        evalCriterion7SlippageStress(),
        evalCriterion8DropBest5Pct(),
        evalCriterion9StressWindows(),
        evalCriterion10SymbolConcentration(draft),
        evalCriterion10WeeklyConcentration(),
        evalCriterion11RegimeTargeting(draft, active),
        evalCriterion12LowFidelityDependence(draft),
    ];
    const passes = criteria.every((c) => c.passed);
    return { passes, criteria };
}

// 1. Net positive expectancy on OOS. The agent runs a single in-sample window
//    today (walk-forward OOS folds are NOT exposed on IBacktestReport); we
//    approximate with the whole-window net PnL.
function evalCriterion1NetPositiveExpectancy(draft: BacktestReportParsed): ICriterionResult {
    const net = Number(draft.netPnlUsdt);
    return {
        index: 1,
        name: 'In-sample net PnL > 0 (OOS-per-fold pending engine extension)',
        threshold: 'netPnlUsdt > 0',
        measured: draft.netPnlUsdt,
        passed: Number.isFinite(net) && net > 0,
    };
}

// 2. Profit factor on OOS ≥ 1.25.
function evalCriterion2ProfitFactor(draft: BacktestReportParsed): ICriterionResult {
    const pf = Number(draft.profitFactor);
    const isInfinitePf = draft.profitFactor === 'Infinity';
    return {
        index: 2,
        name: 'Profit factor',
        threshold: `profitFactor >= ${MIN_PROFIT_FACTOR}`,
        measured: draft.profitFactor,
        passed: isInfinitePf || (Number.isFinite(pf) && pf >= MIN_PROFIT_FACTOR),
    };
}

// 3. Max drawdown within tolerance.
function evalCriterion3MaxDrawdown(draft: BacktestReportParsed): ICriterionResult {
    const dd = Math.abs(Number(draft.maxDrawdownPct));
    return {
        index: 3,
        name: 'Max drawdown within tolerance',
        threshold: `|maxDrawdownPct| <= ${MAX_DD_TOLERANCE_PCT}`,
        measured: draft.maxDrawdownPct,
        passed: Number.isFinite(dd) && dd <= MAX_DD_TOLERANCE_PCT,
    };
}

// 4. Worst single-day loss survivable — read from `equityCurve.dailyReturnPct`.
function evalCriterion4WorstDayLoss(draft: BacktestReportParsed): ICriterionResult {
    if (draft.equityCurve.length === 0) {
        return {
            index: 4,
            name: 'Worst single-day loss survivable',
            threshold: `worstDayPct >= -${WORST_DAY_LOSS_TOLERANCE_PCT}`,
            measured: NOT_AVAILABLE,
            passed: false,
        };
    }
    let worst = Number.POSITIVE_INFINITY;
    for (const point of draft.equityCurve) {
        const r = Number(point.dailyReturnPct);
        if (Number.isFinite(r) && r < worst) {
            worst = r;
        }
    }
    const worstStr = Number.isFinite(worst) ? worst.toFixed(4) : NOT_AVAILABLE;
    return {
        index: 4,
        name: 'Worst single-day loss survivable',
        threshold: `worstDayPct >= -${WORST_DAY_LOSS_TOLERANCE_PCT}`,
        measured: worstStr,
        passed: Number.isFinite(worst) && worst >= -WORST_DAY_LOSS_TOLERANCE_PCT,
    };
}

// 5. Statistical significance — paired bootstrap CI vs active. Source field
//    NOT present on IBacktestReport today (engine wires it via
//    IPerformanceByVersionView, not the run report). Marked NOT_AVAILABLE
//    when missing.
function evalCriterion5StatSignificance(draft: BacktestReportParsed): ICriterionResult {
    const hasCi = draft.bootstrap?.ci !== undefined;
    if (!hasCi) {
        return {
            index: 5,
            name: 'Statistical significance (bootstrap CI excludes zero)',
            threshold: 'CI on (draft - active) expectancy excludes zero',
            measured: NOT_AVAILABLE,
            passed: false,
        };
    }
    const passes = bootstrapCiPassesZero(draft);
    return {
        index: 5,
        name: 'Statistical significance (bootstrap CI excludes zero)',
        threshold: 'CI on (draft - active) expectancy excludes zero',
        measured: passes ? 'CI_EXCLUDES_ZERO' : 'CI_OVERLAPS_ZERO',
        passed: passes,
    };
}

// 6. Sample sufficiency — ≥ 200 trades. (Per-regime ≥ 100 + shadow ≥ 30 days
//    are not exposed; the trade-count check alone is the bar we can measure.)
function evalCriterion6SampleSufficiency(draft: BacktestReportParsed): ICriterionResult {
    return {
        index: 6,
        name: 'Total-trade-count sub-gate (regime + shadow sub-gates pending)',
        threshold: `tradeCount >= ${MIN_TRADE_COUNT}`,
        measured: String(draft.tradeCount),
        passed: draft.tradeCount >= MIN_TRADE_COUNT,
    };
}

// 7. Robustness — slippage stress. Engine M7 robustness re-runs are not
//    exposed on IBacktestReport. Once the engine wires `robustness.slippageStress`
//    through, this criterion upgrades.
function evalCriterion7SlippageStress(): ICriterionResult {
    return {
        index: 7,
        name: 'Robustness — slippage stress',
        threshold: 'criteria 1+2 hold under doubled-slippage re-run',
        measured: NOT_AVAILABLE,
        passed: false,
    };
}

// 8. Robustness — drop-best-5%. Same source as 7; not exposed today.
function evalCriterion8DropBest5Pct(): ICriterionResult {
    return {
        index: 8,
        name: 'Robustness — drop-best-5%',
        threshold: 'criteria 1+2 hold after removing top 5% trades',
        measured: NOT_AVAILABLE,
        passed: false,
    };
}

// 9. Robustness — stress windows. Same source; not exposed today.
function evalCriterion9StressWindows(): ICriterionResult {
    return {
        index: 9,
        name: 'Robustness — stress windows',
        threshold: 'expectancy >= 0 over union of stress windows',
        measured: NOT_AVAILABLE,
        passed: false,
    };
}

// 10a. Concentration — per-symbol. `IBacktestReport.perSymbol` is exposed: we
//      compute max symbol share of trades and fail when > 40%. The per-ISO-week
//      sub-gate (10b) remains NOT_AVAILABLE until the engine surfaces a
//      per-week breakdown.
function evalCriterion10SymbolConcentration(draft: BacktestReportParsed): ICriterionResult {
    if (draft.tradeCount <= 0 || draft.perSymbol.length === 0) {
        return {
            index: 10,
            name: 'Concentration: max single-symbol share <= 40% of trades',
            threshold: `maxSymbolSharePct <= ${MAX_SYMBOL_CONCENTRATION_PCT}`,
            measured: NOT_AVAILABLE,
            passed: false,
        };
    }
    let maxTrades = 0;
    for (const row of draft.perSymbol) {
        if (row.tradeCount > maxTrades) {
            maxTrades = row.tradeCount;
        }
    }
    const sharePct = (maxTrades / draft.tradeCount) * 100;
    return {
        index: 10,
        name: 'Concentration: max single-symbol share <= 40% of trades',
        threshold: `maxSymbolSharePct <= ${MAX_SYMBOL_CONCENTRATION_PCT}`,
        measured: sharePct.toFixed(2),
        passed: sharePct <= MAX_SYMBOL_CONCENTRATION_PCT,
    };
}

// 10b. Concentration — per ISO week. IBacktestReport has no per-week breakdown
//      today; this sub-gate stays NOT_AVAILABLE until the engine adds it.
function evalCriterion10WeeklyConcentration(): ICriterionResult {
    return {
        index: 10,
        name: 'Concentration: weekly distribution',
        threshold: 'maxWeekSharePct <= 30',
        measured: NOT_AVAILABLE,
        passed: false,
    };
}

// 11. Regime targeting — candidate beats current active on the regime(s) it
//     targets. The regime-target map (per StrategyDirectionEnum) lives in the
//     engine's `promotionGateConsts.ts`; the agent does not have a copy. Until
//     the engine surfaces the per-regime delta verdict, this is NOT_AVAILABLE.
function evalCriterion11RegimeTargeting(draft: BacktestReportParsed, active: BacktestReportParsed): ICriterionResult {
    void draft;
    void active;
    return {
        index: 11,
        name: 'Regime targeting (beats active on target regimes)',
        threshold: 'per-regime delta positive on target regimes',
        measured: NOT_AVAILABLE,
        passed: false,
    };
}

// 12. Low-fidelity dependence — edge survives excluding lowFidelity trades.
//     We can compute the ratio from `lowFidelityTradeCount / tradeCount`; if
//     the proportion is small enough we treat the edge as not dependent on
//     low-fidelity fills. A full re-run with `lowFidelity=true` trades
//     excluded would need engine-side support; this is an advisory proxy.
function evalCriterion12LowFidelityDependence(draft: BacktestReportParsed): ICriterionResult {
    if (draft.tradeCount === 0) {
        return {
            index: 12,
            name: 'Low-fidelity sample-share proxy (ADR criterion 12 pending)',
            threshold: `non-low-fidelity ratio >= ${LOW_FIDELITY_RATIO_FLOOR}`,
            measured: NOT_AVAILABLE,
            passed: false,
        };
    }
    const ratio = (draft.tradeCount - draft.lowFidelityTradeCount) / draft.tradeCount;
    return {
        index: 12,
        name: 'Low-fidelity dependence',
        threshold: `non-low-fidelity ratio >= ${LOW_FIDELITY_RATIO_FLOOR}`,
        measured: ratio.toFixed(4),
        passed: ratio >= LOW_FIDELITY_RATIO_FLOOR,
    };
}
