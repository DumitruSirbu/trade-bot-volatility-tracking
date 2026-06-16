import { IMarketSnapshot, PositionSideEnum } from '@bot/shared';

import { EXIT_GEOMETRY_ONE, PCT_DIVISOR } from '../const';
import { Money, MoneyValue } from '../../common/utils/money';
import { IProposedExit } from '../../strategy/interface';

// M38 D1/D2 (ADR 0045) — pure exit-geometry helpers shared by the live arm seam
// (ExecutionService) and, for the rebase only, the backtest seam (BacktestOrchestrator).
// No I/O, no clock, decimal-only via Money — parity is preserved by calling the SAME helper
// at both seams.

// Inputs to evaluateFillDrift. Grouped into a context object so the function stays inside the
// ≤2-argument convention. `entrySnapshot`/`maxDriftPct` are optional — when either is absent
// the magnitude leg is skipped (the guard ships disabled; the wrong-side-of-SL check is always on).
export interface IFillDriftContext {
    clampedExit: IProposedExit;
    avgFillPrice: MoneyValue;
    side: PositionSideEnum;
    entrySnapshot?: IMarketSnapshot;
    maxDriftPct?: number;
}

// Rebase the momentum TP anchor from the signal-time reference price to the actual fill
// price. The ATR distance is unchanged — only the anchor moves (+ for LONG, − for SHORT).
// Caller must guarantee tpRebaseEligible=true and atrDistance !== null.
export function rebaseMomentumTakeProfit(clampedExit: IProposedExit, avgFillPrice: MoneyValue, side: PositionSideEnum): MoneyValue {
    const distance = new Money(clampedExit.atrDistance!);
    const fill = new Money(avgFillPrice);

    return side === PositionSideEnum.LONG ? fill.plus(distance) : fill.minus(distance);
}

// Evaluate whether a confirmed fill should be rejected at fill acceptance.
//   - Always checks wrong-side-of-own-SL (hard structural check — always on, keyed on the
//     position's own clampedExit.stopLossPrice, not literally VWAP).
//   - Optionally checks magnitude drift against maxDriftPct (skipped when entrySnapshot or
//     maxDriftPct is absent — ships disabled).
// The drift value is logged by the caller on every evaluation regardless of pass/reject.
export function evaluateFillDrift(ctx: IFillDriftContext): { shouldReject: boolean; reason?: string; driftPct?: number } {
    const fill = new Money(ctx.avgFillPrice);
    const sl = new Money(ctx.clampedExit.stopLossPrice);

    // Operative reject: fill on the wrong side of its own structural SL. LONG with the fill
    // at or below the SL, SHORT with the fill at or above the SL, is a doomed position.
    const isWrongSideOfStop = ctx.side === PositionSideEnum.LONG ? fill.lessThanOrEqualTo(sl) : fill.greaterThanOrEqualTo(sl);

    if (isWrongSideOfStop) {
        return { shouldReject: true, reason: 'wrong_side_of_sl' };
    }

    // Far-tail magnitude guard — off by default; runs only when both the entry snapshot and a
    // configured cap are present. referencePrice op-order EXACTLY mirrors entryHelpers.ts:44-46.
    if (ctx.entrySnapshot !== undefined && ctx.maxDriftPct !== undefined) {
        const vwap = new Money(ctx.entrySnapshot.vwap_session);
        const deviationFactor = EXIT_GEOMETRY_ONE.plus(new Money(ctx.entrySnapshot.vwap_deviation_pct).dividedBy(PCT_DIVISOR));
        const referencePrice = vwap.times(deviationFactor);
        const driftPct = fill.minus(referencePrice).abs().dividedBy(referencePrice).times(100);
        const driftPctNum = parseFloat(driftPct.toFixed(6));

        if (driftPctNum > ctx.maxDriftPct) {
            return { shouldReject: true, reason: 'drift_over_cap', driftPct: driftPctNum };
        }

        return { shouldReject: false, driftPct: driftPctNum };
    }

    return { shouldReject: false };
}
