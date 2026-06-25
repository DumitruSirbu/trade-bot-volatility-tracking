import {
    CoinTierEnum,
    FlowTypeEnum,
    IStrategyParams,
    IVolatilityDetectedEvent,
    PositionSideEnum,
    RegimeLabelEnum,
    SkipReasonEnum,
    StopTypeEnum,
} from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils/money';
import {
    MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER,
    MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT,
    MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER,
    MOMENTUM_TAKER_FEE_RATE,
    MS_PER_MINUTE,
    REASON_MOMENTUM_FOLLOW,
} from '../const';
import { ISignal, IStrategyInput } from '../interface';
import { buildOpenSignal, buildSkipSignal, reconstructReferencePrice, resolveFollowSide, resolveSignalType } from '../utils';

// Pure momentum (follow) decision core, shared by v2 and v3's trend_initiation route
// (M3 brief v2). Returns one ISignal. No I/O, no clock — nowMs comes from input. Reads NO
// risk-layer params. Reads orchestrator-stamped flow_type + signal_score.
export function evaluateMomentum(input: IStrategyInput): ISignal {
    const { event, snapshot, nowMs } = input;

    const signalType = resolveSignalType(event);
    const tradeSide = resolveFollowSide(event);
    const signalScore = snapshot.signal_score;
    const flowType = event.flowType;

    // Route catalyst_risk before any regime evaluation (mirrors v3) so a catalyst_risk
    // event in a ranging regime is attributed to FLOW_ROUTED_SKIP, not REGIME_SUPPRESSED —
    // keeping M8 skip-reason attribution and the post-deploy verification honest.

    if (event.flowType === FlowTypeEnum.CATALYST_RISK) {
        return buildSkipSignal({ signalType, skipReason: SkipReasonEnum.FLOW_ROUTED_SKIP, signalScore, flowType });
    }

    // Momentum fails in range-bound markets: suppress open when regime is ranging.

    if (event.regimeLabel === RegimeLabelEnum.RANGING) {
        return buildSkipSignal({ signalType, skipReason: SkipReasonEnum.REGIME_SUPPRESSED, signalScore, flowType });
    }

    // M47 Task 2 (BLOCKER 5): refuse degenerate geometry at the core — a zero SL distance
    // (VWAP == reference) or a TP the rrFloor cap could not lift to the core min_rr target.
    // The loose gate is a backstop, not the binding constraint for Invariant 1.

    if (isDegenerateMomentumGeometry(input, tradeSide)) {
        return buildSkipSignal({ signalType, skipReason: SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY, signalScore, flowType });
    }

    return buildOpenSignal({
        signalType,
        tradeSide,
        signalScore,
        flowType,
        reason: REASON_MOMENTUM_FOLLOW,
        proposedExit: buildMomentumExit(input, tradeSide, nowMs),
    });
}

// SHORT TP = entry − atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER (2.0×, unchanged).
// LONG TP = entry + max(atr14 × MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, costFloor + margin)
// (M43 D2) — the LONG VWAP structural stop sits the full session-deviation distance below
// entry, so a wider, cost-floor-anchored target is needed to lift long-side RR.
// SL = VWAP (a reversion back to VWAP invalidates the momentum thesis). time-stop =
// nowMs + time_stop_minutes.
function buildMomentumExit(input: IStrategyInput, tradeSide: PositionSideEnum, nowMs: number) {
    const { event, params } = input;

    const referencePrice = reconstructReferencePrice(event);
    const atrTarget = resolveTakeProfitDistance(tradeSide, referencePrice, event, params);
    const takeProfitPrice = tradeSide === PositionSideEnum.LONG ? referencePrice.plus(atrTarget) : referencePrice.minus(atrTarget);

    return {
        takeProfitPrice,
        // SL sits at VWAP — a structural price level, not an ATR-distance stop.
        stopLossPrice: new Money(event.vwapSession),
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: nowMs + params.time_stop_minutes * MS_PER_MINUTE,
        // M47 Task 0 (ADR 0045 amendment, Option B — MANDATORY): the momentum TP must NOT be
        // rebased at fill time. Both legs stay frozen at their signal-time price levels (TP at
        // reference ± atrTarget, SL at VWAP), so the signal-time R:R geometry the risk gate
        // approved survives the fill unchanged. Option A (rebase both legs) was REJECTED: the
        // gate validates pre-fill geometry on intent.proposedExit and cannot see a post-fill
        // rebase, so a single-leg (TP-only) rebase voids the gate's guarantee the instant a fill
        // lands off-reference. atrDistance is still carried (it equals the coupled tpDist) — the
        // sweep tool reconstructs the reference from it; only the fill-time rebase consumption is
        // removed (the seams at ExecutionService/BacktestOrchestrator already gate on this flag).
        tpRebaseEligible: false,
        atrDistance: atrTarget,
    };
}

// The single composite distance threaded verbatim into both takeProfitPrice and atrDistance
// (the M38 rebase invariant — ADR 0045 §D1.2: computed once, never re-derived at the seams).
// SHORT keeps the symmetric 2.0× ATR leg; LONG floors the leg at the cost-aware anchor; M47
// Task 2 folds a capped rrFloor into the max() on BOTH sides so the TP is widened (never the
// VWAP SL tightened) whenever the ATR/cost legs would otherwise shape R:R below min_rr.
function resolveTakeProfitDistance(
    tradeSide: PositionSideEnum,
    referencePrice: MoneyValue,
    event: IVolatilityDetectedEvent,
    params: IStrategyParams,
): MoneyValue {
    const baseLeg = resolveBaseTakeProfitLeg(tradeSide, referencePrice, event.atr14, event.coinTier, params);
    const rrFloor = resolveRrFloor(referencePrice, event, params);

    return Money.max(baseLeg, rrFloor);
}

// The pre-M47 take-profit leg: SHORT = atr14 × 2.0; LONG = max(atr14 × 3.5, cost floor + margin).
function resolveBaseTakeProfitLeg(
    tradeSide: PositionSideEnum,
    referencePrice: MoneyValue,
    atr14: string,
    coinTier: CoinTierEnum,
    params: IStrategyParams,
): MoneyValue {
    if (tradeSide === PositionSideEnum.LONG) {
        const atrLeg = new Money(atr14).times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);
        const costFloorLeg = resolveLongCostFloorLeg(referencePrice, coinTier, params);

        return atrLeg.greaterThan(costFloorLeg) ? atrLeg : costFloorLeg;
    }

    return new Money(atr14).times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);
}

// M47 Task 2: couples the TP distance to the SL distance. rrFloorRaw = slDist × min_rr lifts
// the TP to meet the core R:R target; the cap (max_tp_dist_factor × atr14, BLOCKER 5) keeps an
// extreme-spike TP from running to a negative/unreachable price. slDist is the momentum stop
// distance |reference − vwapSession| — the VWAP stop is never tightened, only the TP widened.
function resolveRrFloor(referencePrice: MoneyValue, event: IVolatilityDetectedEvent, params: IStrategyParams): MoneyValue {
    const slDist = resolveMomentumStopDistance(referencePrice, event);
    const rrFloorRaw = slDist.times(params.min_rr);
    const cap = new Money(event.atr14).times(params.max_tp_dist_factor);

    return Money.min(rrFloorRaw, cap);
}

function resolveMomentumStopDistance(referencePrice: MoneyValue, event: IVolatilityDetectedEvent): MoneyValue {
    return referencePrice.minus(new Money(event.vwapSession)).abs();
}

// M47 Task 2 (BLOCKER 5): refuse a momentum signal whose geometry cannot reach the core
// min_rr target. Three degenerate cases: (1) slDist == 0 (VWAP == reference — the stop sits at
// entry, R:R undefined), (2) the capped tpDist still yields tpDist / slDist < min_rr (the
// cap prevented the rrFloor from lifting the TP to the target), and (3) SHORT TP price ≤ 0
// (extreme-spike: 2×ATR ≥ reference — the TP would be placed at or below zero, unexecutable).
function isDegenerateMomentumGeometry(input: IStrategyInput, tradeSide: PositionSideEnum): boolean {
    const { event, params } = input;
    const referencePrice = reconstructReferencePrice(event);
    const slDist = resolveMomentumStopDistance(referencePrice, event);

    if (slDist.isZero()) {
        return true;
    }

    const tpDist = resolveTakeProfitDistance(tradeSide, referencePrice, event, params);

    if (tradeSide === PositionSideEnum.SHORT && referencePrice.minus(tpDist).lessThanOrEqualTo(0)) {
        return true;
    }

    return tpDist.dividedBy(slDist).lessThan(params.min_rr);
}

// Tier-aware round-trip cost distance plus the safety margin — the floor below which a LONG
// TP must never sit. Mirrors the risk gate's roundTripCostDistance
// (entry × (2 × fee + 2 × slippageFraction)) so the anchor clears the tp_below_cost gate.
function resolveLongCostFloorLeg(referencePrice: MoneyValue, coinTier: CoinTierEnum, params: IStrategyParams): MoneyValue {
    const feeLeg = new Money(MOMENTUM_TAKER_FEE_RATE).times(new Money(2));
    const slippageLeg = resolveTierSlippageFraction(coinTier, params).times(new Money(2));
    const roundTripCostDistance = referencePrice.times(feeLeg.plus(slippageLeg));
    const margin = referencePrice.times(MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT);

    return roundTripCostDistance.plus(margin);
}

// Per-tier slippage as a price fraction. Params carry slippage as percent points (0.15 =
// 0.15%), so divide by 100 — matching the risk gate's slippageFraction derivation.
function resolveTierSlippageFraction(coinTier: CoinTierEnum, params: IStrategyParams): MoneyValue {
    let slippagePct: number;

    if (coinTier === CoinTierEnum.TIER_1) {
        slippagePct = params.slippage_tier1_pct;
    } else if (coinTier === CoinTierEnum.TIER_2) {
        slippagePct = params.slippage_tier2_pct;
    } else {
        slippagePct = params.slippage_tier3_pct;
    }

    return new Money(slippagePct).dividedBy(new Money(100));
}
