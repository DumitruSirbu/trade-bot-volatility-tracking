import { IMarketSnapshot, IStrategyParams, PositionSideEnum } from '@bot/shared';

import { DEGENERATE_GEOMETRY_AT_FILL, DRIFT_OVER_CAP, EXIT_GEOMETRY_ONE, GEOMETRY_ZERO, PCT_DIVISOR, WRONG_SIDE_OF_SL } from '../const';
import { Money, MoneyValue } from '../../common/utils/money';
import { resolveSlFloorDistance } from '../../common/utils';
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
    // M48 (ADR 0045 §D2.9) — fill-anchored geometry-integrity leg inputs. Stamped on OPEN
    // approvals only (absent on close/reduce/flatten). When geometryParams is present the leg
    // runs fail-closed on entrySnapshot + atr_14.
    geometryParams?: Pick<IStrategyParams, 'min_rr' | 'atr_floor_multiplier' | 'entry_pct_floor'>;
    referencePrice?: MoneyValue;
    // M48 (ADR 0045 §D2.9) — the actual armed TP at fill time. For tpRebaseEligible fills the
    // executor rebases the TP anchor to the fill price; the R:R leg must use that resolved TP, not
    // the frozen signal-anchored clampedExit.takeProfitPrice. Absent for non-rebase fills (current
    // behavior: the leg falls back to the frozen TP, which is correct when no rebase occurred).
    resolvedTakeProfitPrice?: MoneyValue;
}

// File-private state for the fill-anchored geometry-integrity steps. Built once in
// evaluateFillGeometry after the side/fill/sl/tp are derived, then threaded through the ordering
// and signed-distance helpers so each stays inside the ≤2-argument convention.
interface IGeometryState {
    side: PositionSideEnum;
    fill: MoneyValue;
    sl: MoneyValue;
    tp: MoneyValue;
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
        return { shouldReject: true, reason: WRONG_SIDE_OF_SL };
    }

    // M48 (ADR 0045 §D2.9) — fill-anchored geometry-integrity leg. Runs AFTER the wrong-side-of-SL
    // leg and BEFORE the magnitude leg. Applies only when geometryParams is stamped (OPEN approvals);
    // absent on close/reduce/flatten, where the leg does not apply.
    if (ctx.geometryParams !== undefined) {
        const geometryRejection = evaluateFillGeometry(ctx);

        if (geometryRejection !== undefined) {
            return geometryRejection;
        }
    }

    const magnitudeResult = evaluateMagnitudeDrift(ctx);

    if (magnitudeResult !== undefined) {
        return magnitudeResult;
    }

    return { shouldReject: false };
}

// Far-tail magnitude guard — off by default; runs only when both the entry snapshot and a
// configured cap are present. Returns undefined when the leg is skipped (absent inputs), or the
// reject/pass result with the logged drift value when it runs. referencePrice op-order EXACTLY
// mirrors entryHelpers.ts:44-46.
function evaluateMagnitudeDrift(ctx: IFillDriftContext): { shouldReject: boolean; reason?: string; driftPct?: number } | undefined {
    if (ctx.entrySnapshot === undefined || ctx.maxDriftPct === undefined) {
        return undefined;
    }

    const fill = new Money(ctx.avgFillPrice);
    const vwap = new Money(ctx.entrySnapshot.vwap_session);
    const deviationFactor = EXIT_GEOMETRY_ONE.plus(new Money(ctx.entrySnapshot.vwap_deviation_pct).dividedBy(PCT_DIVISOR));
    const referencePrice = vwap.times(deviationFactor);
    const driftPct = fill.minus(referencePrice).abs().dividedBy(referencePrice).times(100);
    const driftPctNum = parseFloat(driftPct.toFixed(6));

    if (driftPctNum > ctx.maxDriftPct) {
        return { shouldReject: true, reason: DRIFT_OVER_CAP, driftPct: driftPctNum };
    }

    return { shouldReject: false, driftPct: driftPctNum };
}

// M48 (ADR 0045 §D2.9) — the fill-anchored geometry-integrity leg, extracted to keep
// evaluateFillDrift inside the function-length convention. Returns a rejection result on any
// degenerate geometry, or undefined to let the fill proceed. Called only when geometryParams is
// present (OPEN approvals). Decimal-only; all distances anchor to the fill price, while the slFloor
// PCT threshold anchors to the signal-calibrated referencePrice (Item 2 / reviewer HIGH).
function evaluateFillGeometry(ctx: IFillDriftContext): { shouldReject: true; reason: string } | undefined {
    // Step 0 — fail-closed input guard. The leg is UNCONDITIONAL once geometryParams is stamped: a
    // missing entrySnapshot or atr_14 (needed for slFloor) is a wiring bug, not a license to pass.
    if (ctx.referencePrice === undefined || ctx.entrySnapshot === undefined || ctx.entrySnapshot.atr_14 === undefined) {
        return { shouldReject: true, reason: DEGENERATE_GEOMETRY_AT_FILL };
    }

    const fill = new Money(ctx.avgFillPrice);
    const sl = new Money(ctx.clampedExit.stopLossPrice);
    // M48 — use the actual armed TP for tpRebaseEligible fills; fall back to the frozen
    // signal-anchored TP when no rebase occurred (current behavior for all cores).
    const tp = new Money(ctx.resolvedTakeProfitPrice ?? ctx.clampedExit.takeProfitPrice);
    const state: IGeometryState = { side: ctx.side, fill, sl, tp };

    if (isSlOrderingViolated(state)) {
        return { shouldReject: true, reason: DEGENERATE_GEOMETRY_AT_FILL };
    }

    const { slDist, tpDist } = resolveSignedDistances(state);

    if (isSlCollapsed(slDist)) {
        return { shouldReject: true, reason: DEGENERATE_GEOMETRY_AT_FILL };
    }

    if (isSlBelowFloor(slDist, ctx)) {
        return { shouldReject: true, reason: DEGENERATE_GEOMETRY_AT_FILL };
    }

    const ratio = tpDist.dividedBy(slDist);

    if (isRrInsufficient(ratio, ctx.geometryParams!.min_rr)) {
        return { shouldReject: true, reason: DEGENERATE_GEOMETRY_AT_FILL };
    }

    return undefined;
}

// Step 1 — side-correct ordering. Absolute-value distances would mask a wrong-side fill.
// SHORT requires SL > fill > TP; LONG requires TP > fill > SL. Returns true when violated.
function isSlOrderingViolated(state: IGeometryState): boolean {
    return state.side === PositionSideEnum.SHORT
        ? !(state.sl.greaterThan(state.fill) && state.fill.greaterThan(state.tp))
        : !(state.tp.greaterThan(state.fill) && state.fill.greaterThan(state.sl));
}

// Step 2 — signed distances (guaranteed positive by the ordering check), both anchored to the fill.
function resolveSignedDistances(state: IGeometryState): { slDist: MoneyValue; tpDist: MoneyValue } {
    const slDist = state.side === PositionSideEnum.SHORT ? state.sl.minus(state.fill) : state.fill.minus(state.sl);
    const tpDist = state.side === PositionSideEnum.SHORT ? state.fill.minus(state.tp) : state.tp.minus(state.fill);

    return { slDist, tpDist };
}

// Step 3 — collapsed-stop / div-by-zero guard (<=, not ==).
function isSlCollapsed(slDist: MoneyValue): boolean {
    return slDist.lessThanOrEqualTo(GEOMETRY_ZERO);
}

// Step 4 — noise floor. The slFloor PCT leg anchors to referencePrice, NOT the fill, so the
// threshold does not shift with slippage and the 212-collapse guard holds. referencePrice,
// entrySnapshot, and geometryParams are guaranteed present by the Step 0 guard.
function isSlBelowFloor(slDist: MoneyValue, ctx: IFillDriftContext): boolean {
    const slFloor = resolveSlFloorDistance(ctx.referencePrice!, { atr14: ctx.entrySnapshot!.atr_14, params: ctx.geometryParams! });

    return slDist.lessThan(slFloor);
}

// Step 5 — R:R ratio (defense-in-depth). Strict `<` — at exactly min_rr passes.
function isRrInsufficient(ratio: MoneyValue, minRr: number): boolean {
    return ratio.lessThan(new Money(minRr));
}
