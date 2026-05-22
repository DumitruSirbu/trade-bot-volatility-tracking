import { DeviationSideEnum, IClosedBarTriggerInput, ITriggerParams, ITriggerResult } from '@bot/shared';

// THE shared live/backtest trigger (ADR §3). One function, owned by the engine,
// imported by both the live MarketDataModule and the M7 BacktestModule so triggers
// cannot diverge between live and replay.
//
// PURE and DETERMINISTIC: no Date.now(), no Math.random(), no I/O. Every input
// arrives in the snapshot; identical inputs always yield identical output.
//
// DIRECTION-AGNOSTIC: this is an event detector, not a trade-direction decision.
// `side` is the deviation direction of the event (price above vs below VWAP),
// derived from sign(vwapDeviationPct); the strategy decides trade direction later.
//
// Fires when ALL four conditions hold:
//   1. abs(vwapDeviationSigma) >= params.vwapSigmaTrigger
//   2. volumeRatio            >= params.volumeRatioMin
//   3. abs(vwapDeviationPct)  >= params.tierMinAbsMovePct
//   4. abs(vwapDeviationPct)  <= params.tierMaxAbsMovePct
//
// σ here is a NORMALIZED DISTANCE, not a probability — crypto returns are
// fat-tailed; bands are calibrated empirically, never by Gaussian intuition.
export function evaluateTrigger(input: IClosedBarTriggerInput, params: ITriggerParams): ITriggerResult {
    const absSigma = Math.abs(input.vwapDeviationSigma);
    const absMovePct = Math.abs(input.vwapDeviationPct);

    const sigmaConditionMet = absSigma >= params.vwapSigmaTrigger;
    const volumeConditionMet = input.volumeRatio >= params.volumeRatioMin;
    const minMoveConditionMet = absMovePct >= params.tierMinAbsMovePct;
    const maxMoveConditionMet = absMovePct <= params.tierMaxAbsMovePct;

    const fired = sigmaConditionMet && volumeConditionMet && minMoveConditionMet && maxMoveConditionMet;

    return {
        fired,
        side: deriveSide(input.vwapDeviationPct),
        sigmaConditionMet,
        volumeConditionMet,
        minMoveConditionMet,
        maxMoveConditionMet,
    };
}

// Side is the sign of the deviation: price above VWAP = ABOVE, at-or-below = BELOW.
function deriveSide(vwapDeviationPct: number): DeviationSideEnum {
    if (vwapDeviationPct > 0) {
        return DeviationSideEnum.ABOVE;
    }

    return DeviationSideEnum.BELOW;
}
