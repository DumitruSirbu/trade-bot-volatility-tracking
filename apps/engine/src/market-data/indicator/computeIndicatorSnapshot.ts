import {
    ACTIVE_VWAP_ANCHOR_TYPE,
    ADX_PERIOD,
    ATR_PERIOD,
    BOLLINGER_PERIOD,
    BOLLINGER_STDDEV_MULTIPLIER,
    RSI_PERIOD,
    SIGMA_DEVIATION_BARS,
    VOLUME_AVG_BARS,
    VWAP_ROLLING_24H_BARS,
    VWAP_ROLLING_BARS,
} from '../const';
import { ICandle, IIndicatorSnapshot, IIndicatorSnapshotInput } from '../interface';
import { computeAdx } from './computeAdx';
import { computeAtr } from './computeAtr';
import { computeBollinger } from './computeBollinger';
import { computeAverageVolume, computeDeviationDistanceInSigma, computeDeviationPct, computeDeviationSigma, computeVolumeRatio } from './computeDeviation';
import { computeRsi } from './computeRsi';
import { computeVwap } from './computeVwap';

// Builds the full per-symbol indicator snapshot from CLOSED bars only (ADR §4).
// The active VWAP anchor (20-bar in M1) drives the deviation that the trigger
// reads; the other anchors (session, 24h, event-anchored) are computed alongside
// for the payload and for M7's anchor comparison. `eventAnchoredVwap` is supplied
// by the caller (it spans an event boundary not derivable from a fixed window).
export function computeIndicatorSnapshot(input: IIndicatorSnapshotInput): IIndicatorSnapshot {
    const { symbol, closedBars, sessionBars, eventAnchoredVwap } = input;
    const latest = closedBars[closedBars.length - 1];
    const close = latest.close;

    const vwap20bar = computeVwap(lastN(closedBars, VWAP_ROLLING_BARS));
    const vwap24h = computeVwap(lastN(closedBars, VWAP_ROLLING_24H_BARS));
    const vwapSession = computeVwap(sessionBars.length > 0 ? sessionBars : closedBars);

    const vwapDeviationPct = computeDeviationPct(close, vwap20bar);
    const sigma = computeDeviationSigma(lastN(closedBars, SIGMA_DEVIATION_BARS), vwap20bar);
    const vwapDeviationSigma = computeDeviationDistanceInSigma(vwapDeviationPct, sigma);

    const volume20barAvg = computeAverageVolume(lastN(closedBars, VOLUME_AVG_BARS));
    const volumeRatio = computeVolumeRatio(latest.volume, volume20barAvg);

    const atr14 = computeAtr(closedBars, ATR_PERIOD);
    const adx = computeAdx(closedBars, ADX_PERIOD);
    const rsi14 = computeRsi(closedBars, RSI_PERIOD);
    const bollinger = computeBollinger(closedBars, BOLLINGER_PERIOD, BOLLINGER_STDDEV_MULTIPLIER);

    const fiveMinMovePct = computeFiveMinMovePct(closedBars);

    return {
        symbol,
        closedBarOpenTimeMs: latest.openTimeMs,
        vwapSession,
        vwap20bar,
        vwap24h,
        vwapEventAnchored: eventAnchoredVwap,
        activeVwapAnchorType: ACTIVE_VWAP_ANCHOR_TYPE,
        vwapDeviationPct,
        vwapDeviationSigma,
        volumeRatio,
        volume20barAvg,
        atr14,
        adx14: adx.adx,
        adxDiPlus: adx.diPlus,
        adxDiMinus: adx.diMinus,
        rsi14,
        bollingerUpper: bollinger.upper,
        bollingerLower: bollinger.lower,
        bollingerPctB: bollinger.percentB,
        close,
        fiveMinMovePct,
    };
}

// % change of the latest closed bar's close vs the prior closed bar's close (a
// bar-aligned 5-min move). The idiosyncrasy filter compares this against BTC's move
// over the SAME bar-to-bar horizon (see computeBtcBarMovePct) so numerator and
// denominator share one definition — and so the value is reproducible in backtest.
function computeFiveMinMovePct(closedBars: ICandle[]): number {
    if (closedBars.length < 2) {
        return 0;
    }

    const previous = closedBars[closedBars.length - 2].close;
    const latest = closedBars[closedBars.length - 1].close;

    return computeDeviationPct(latest, previous);
}

function lastN<T>(items: T[], count: number): T[] {
    return items.slice(Math.max(0, items.length - count));
}
