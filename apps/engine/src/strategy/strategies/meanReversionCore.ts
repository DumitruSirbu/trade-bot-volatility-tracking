import { DeviationSideEnum, IStrategyParams, IVolatilityDetectedEvent, PositionSideEnum, RegimeLabelEnum, SkipReasonEnum, StopTypeEnum } from '@bot/shared';

import {
    BAND_REENTRY_LOWER_PCT_B,
    BAND_REENTRY_UPPER_PCT_B,
    MS_PER_MINUTE,
    OI_NOT_RISING_THRESHOLD_PCT,
    OI_RISING_THRESHOLD_PCT,
    REASON_MEAN_REVERSION_FADE,
    TAKE_PROFIT_VWAP_SIGMA_OFFSET,
    VOLUME_DECELERATION_RATIO,
} from '../const';
import { Money, MoneyValue } from '../../common/utils/money';
import { ISignal, IStrategyInput } from '../interface';
import {
    buildOpenSignal,
    buildSkipSignal,
    computeStructuralStop,
    reconstructReferencePrice,
    resolveDeviationWickPrice,
    resolveFadeSide,
    resolveSignalType,
} from '../utils';

const PCT_DIVISOR = new Money(100);

// Pure mean-reversion (fade) decision core, shared by v1 and v3's forced_exhaustion route
// (ADR 0003 §4; M3 brief v1). Returns one ISignal. No I/O, no clock — nowMs comes from
// input. Reads NO risk-layer params (those are M4). Reads the orchestrator-stamped
// flow_type (input.event.flowType) and signal_score (input.snapshot.signal_score).
export function evaluateMeanReversion(input: IStrategyInput): ISignal {
    const { event, snapshot, nowMs } = input;

    const signalType = resolveSignalType(event);
    const tradeSide = resolveFadeSide(event);
    const signalScore = snapshot.signal_score;
    const flowType = event.flowType;

    const skip = (skipReason: SkipReasonEnum): ISignal => {
        return buildSkipSignal({ signalType, skipReason, signalScore, flowType });
    };

    if (isRegimeSuppressed(event.regimeLabel, tradeSide)) {
        return skip(SkipReasonEnum.REGIME_SUPPRESSED);
    }

    if (isIdiosyncraticTrap(input)) {
        return skip(SkipReasonEnum.IDIOSYNCRATIC_TRAP);
    }

    if (!isExhaustionConfirmed(input)) {
        return skip(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
    }

    // M47 Task 3: compute tpDist FIRST, then the R:R SL cap (slCap = tpDist / min_rr) and the
    // ATR-relative noise floor — the cap cannot be known until tpDist exists. The geometry
    // context is threaded into both the degeneracy check and the exit builder so the decimal
    // math is computed once.
    const geometry = resolveMeanReversionGeometry(input);

    if (isDegenerateReversionGeometry(event, tradeSide, geometry)) {
        return skip(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    }

    return buildOpenSignal({
        signalType,
        tradeSide,
        signalScore,
        flowType,
        reason: REASON_MEAN_REVERSION_FADE,
        proposedExit: buildMeanReversionExit(input, tradeSide, nowMs, geometry),
    });
}

// M47 Task 3 geometry context: the half-retrace TP distance, the R:R-derived SL cap
// (slCap = tpDist / min_rr — the max allowed stop distance), and the noise floor below which
// a stop would be a hair-trigger. Computed once in evaluateMeanReversion and threaded through
// the degeneracy check and the exit builder (clean-code: one named object, not a flat arg list).
interface IMeanReversionGeometryContext {
    readonly slCapDistance: MoneyValue;
    readonly slFloorDistance: MoneyValue;
}

function resolveMeanReversionGeometry(input: IStrategyInput): IMeanReversionGeometryContext {
    const { event, params } = input;
    const referencePrice = reconstructReferencePrice(event);
    const takeProfitPrice = computeMeanReversionTakeProfit(input);

    const tpDist = takeProfitPrice.minus(referencePrice).abs();
    const slCapDistance = tpDist.dividedBy(params.min_rr);
    const slFloorDistance = resolveSlFloorDistance(referencePrice, event.atr14, params);

    return { slCapDistance, slFloorDistance };
}

// Noise floor for the mean-reversion stop: the LARGER of an ATR-relative bound (the binding
// constraint for most signals) and a percent-of-entry sanity bound (for zero/near-zero ATR).
// entry_pct_floor is a percent-NUMBER (0.3 = 0.3%), so divide by 100 before applying to entry.
function resolveSlFloorDistance(referencePrice: MoneyValue, atr14: string, params: IStrategyParams): MoneyValue {
    const atrFloor = new Money(atr14).times(params.atr_floor_multiplier);
    const pctFloor = referencePrice.times(new Money(params.entry_pct_floor).dividedBy(PCT_DIVISOR));

    return Money.max(atrFloor, pctFloor);
}

// Suppress a fade that leans against the prevailing trend: a short in an uptrend or a long
// in a downtrend. Ranging/transitioning regimes do not suppress reversion.
function isRegimeSuppressed(regimeLabel: RegimeLabelEnum, tradeSide: PositionSideEnum): boolean {
    if (regimeLabel === RegimeLabelEnum.TRENDING_UP && tradeSide === PositionSideEnum.SHORT) {
        return true;
    }

    if (regimeLabel === RegimeLabelEnum.TRENDING_DOWN && tradeSide === PositionSideEnum.LONG) {
        return true;
    }

    return false;
}

// Idiosyncratic-altcoin trap (ADR 0003 §4): idiosyncratic + rising OI + rising volume is
// SUSPICIOUS for reversion — likely catalyst/informed flow. v1 never fades it.
function isIdiosyncraticTrap(input: IStrategyInput): boolean {
    const { event, params } = input;

    return (
        event.idiosyncrasyScore >= params.idiosyncrasy_min_score &&
        event.openInterestChange5mPct > OI_RISING_THRESHOLD_PCT &&
        event.volumeRatio >= params.volume_ratio_min
    );
}

// MANDATORY exhaustion confirmation (M3 brief v1): never enter on the first close that is
// still extended outside the band. Enter only if ANY confirmation holds. Three of the four
// brief conditions are derivable from the closed-bar event; the prior-candle-extreme break
// is NOT on the wire (the event carries no prior-candle high/low) and is an accepted M3
// carry-over. Confirmations implemented:
//   1. close back inside the band (bollinger %B retreated a full band-margin past the edge)
//   2. volume deceleration (volume_ratio fell back to the trigger floor)
//   3. OI stopped rising / started falling over the 5m window
function isExhaustionConfirmed(input: IStrategyInput): boolean {
    const { event } = input;

    return closedBackInsideBand(event.side, event.bollingerPctB) || isVolumeDecelerating(event.volumeRatio) || isOiNotRising(event.openInterestChange5mPct);
}

// A genuine re-entry, not merely "%B within [0,1]". After a pump (deviation ABOVE), the
// close must have retreated below BAND_REENTRY_UPPER_PCT_B (a still-pinned %B >= 0.8 is NOT
// confirmation). After a dump (BELOW), the close must have risen above
// BAND_REENTRY_LOWER_PCT_B. A fresh, still-extended spike therefore fails this gate.
function closedBackInsideBand(deviationSide: DeviationSideEnum, bollingerPctB: number): boolean {
    if (deviationSide === DeviationSideEnum.ABOVE) {
        return bollingerPctB < BAND_REENTRY_UPPER_PCT_B;
    }

    return bollingerPctB > BAND_REENTRY_LOWER_PCT_B;
}

function isVolumeDecelerating(volumeRatio: number): boolean {
    return volumeRatio <= VOLUME_DECELERATION_RATIO;
}

function isOiNotRising(openInterestChange5mPct: number): boolean {
    return openInterestChange5mPct <= OI_NOT_RISING_THRESHOLD_PCT;
}

// TP = VWAP pulled in by TAKE_PROFIT_VWAP_SIGMA_OFFSET × the deviation band for
// conservatism (M3 brief: VWAP ± 0.5σ). SL = structural stop (just beyond the wick, hard
// capped). time-stop = nowMs + time_stop_minutes.
function buildMeanReversionExit(input: IStrategyInput, tradeSide: PositionSideEnum, nowMs: number, geometry: IMeanReversionGeometryContext) {
    const { event, params } = input;

    const takeProfitPrice = computeMeanReversionTakeProfit(input);
    // M47 Task 3: the structural stop is now additionally bounded by slCap (= tpDist / min_rr),
    // tightening the stop toward entry whenever the wick-based stop would invert R:R below the
    // core target. The existing hard cap remains the outer (widest-allowed) bound.
    const stopLossPrice = computeStructuralStop(
        tradeSide,
        reconstructReferencePrice(event),
        resolveDeviationWickPrice(event),
        params.structural_stop_wick_buffer_pct,
        params.structural_stop_hard_cap_pct,
        geometry.slCapDistance,
    );

    return {
        takeProfitPrice,
        stopLossPrice,
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: nowMs + params.time_stop_minutes * MS_PER_MINUTE,
        // M38 D1 (ADR 0045): mean-reversion TP is VWAP-anchored (not reference+ATR), so it is
        // NOT rebase-eligible — re-anchoring it to the fill ± ATR would corrupt it. The seam
        // discriminator enforces this; no ATR distance is carried.
        tpRebaseEligible: false,
        atrDistance: null,
    };
}

// Degenerate VWAP geometry, two cases:
//   1. Wrong-side VWAP: VWAP sits on (or past) the SAME side of entry as the deviation, so the
//      TP target — drawn from entry toward VWAP — lands on the wrong side of entry and the
//      position can be "taken profit" at a loss. SHORT needs vwap < referencePrice; LONG needs
//      vwap > referencePrice.
//   2. M47 Task 3 noise-floor: the R:R SL cap (slCap = tpDist / min_rr) falls BELOW the noise
//      floor (max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry)), which would
//      place the stop inside market noise — a hair-trigger that normal volatility trips at once.
// Skip rather than ship a doomed or noise-tight exit.
function isDegenerateReversionGeometry(event: IVolatilityDetectedEvent, tradeSide: PositionSideEnum, geometry: IMeanReversionGeometryContext): boolean {
    const vwap = new Money(event.vwapSession);
    const referencePrice = reconstructReferencePrice(event);

    if (geometry.slCapDistance.lessThan(geometry.slFloorDistance)) {
        return true;
    }

    if (tradeSide === PositionSideEnum.LONG) {
        return vwap.lessThanOrEqualTo(referencePrice);
    }

    return vwap.greaterThanOrEqualTo(referencePrice);
}

// TP target sits between the deviated price and VWAP, offset by half the deviation toward
// VWAP for conservatism: target = vwap + (price - vwap) × OFFSET. Pure decimal math.
function computeMeanReversionTakeProfit(input: IStrategyInput) {
    // Caller guarantees vwapSession is on the deviated side of entry (non-degenerate geometry check in evaluateMeanReversion).
    const { event } = input;

    const vwap = new Money(event.vwapSession);
    const referencePrice = reconstructReferencePrice(event);
    const offset = new Money(TAKE_PROFIT_VWAP_SIGMA_OFFSET);

    return vwap.plus(referencePrice.minus(vwap).times(offset));
}
