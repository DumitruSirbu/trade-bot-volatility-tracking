import { PositionSideEnum, RegimeLabelEnum, SkipReasonEnum, StopTypeEnum } from '@bot/shared';

import { Money } from '../../common/utils/money';
import { MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER, MS_PER_MINUTE, REASON_MOMENTUM_FOLLOW } from '../const';
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

// TP = entry ± atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER (wider — momentum runs further).
// SL = VWAP (a reversion back to VWAP invalidates the momentum thesis). time-stop =
// nowMs + time_stop_minutes.
function buildMomentumExit(input: IStrategyInput, tradeSide: PositionSideEnum, nowMs: number) {
    const { event, params } = input;

    const referencePrice = reconstructReferencePrice(event);
    const atrTarget = new Money(event.atr14).times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);
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
