import { CoinTierEnum, FlowTypeEnum, IStrategyParams, PositionSideEnum, RegimeLabelEnum, SkipReasonEnum, StopTypeEnum } from '@bot/shared';

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
    const atrTarget = resolveTakeProfitDistance(tradeSide, referencePrice, event.atr14, event.coinTier, params);
    const takeProfitPrice = tradeSide === PositionSideEnum.LONG ? referencePrice.plus(atrTarget) : referencePrice.minus(atrTarget);

    return {
        takeProfitPrice,
        // SL sits at VWAP — a structural price level, not an ATR-distance stop.
        stopLossPrice: new Money(event.vwapSession),
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: nowMs + params.time_stop_minutes * MS_PER_MINUTE,
        // M38 D1 (ADR 0045): momentum TP is reference+ATR, so it is rebase-eligible — the
        // execution layer re-anchors it from the signal-time reference to the actual fill
        // price. atrDistance carries the SAME atrTarget computed above (consumed verbatim
        // at the arm/backtest seams; never re-derived).
        tpRebaseEligible: true,
        atrDistance: atrTarget,
    };
}

// The single composite distance threaded verbatim into both takeProfitPrice and atrDistance
// (the M38 rebase invariant — ADR 0045 §D1.2: computed once, never re-derived at the seams).
// SHORT keeps the symmetric 2.0× ATR leg; LONG floors the leg at the cost-aware anchor.
function resolveTakeProfitDistance(
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
    const slippagePct =
        coinTier === CoinTierEnum.TIER_1 ? params.slippage_tier1_pct : coinTier === CoinTierEnum.TIER_2 ? params.slippage_tier2_pct : params.slippage_tier3_pct;

    return new Money(slippagePct).dividedBy(new Money(100));
}
