import { VwapAnchorTypeEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// Per-symbol indicator state computed on each CLOSED 5-min bar (ADR §4). Price
// fields are decimal (MoneyValue); ratios/sigmas/oscillators are plain numbers
// (dimensionless, not money). Never read from the forming candle.
export interface IIndicatorSnapshot {
    symbol: string;
    closedBarOpenTimeMs: number;

    vwapSession: MoneyValue;
    vwap20bar: MoneyValue;
    vwap24h: MoneyValue;
    vwapEventAnchored: MoneyValue;
    activeVwapAnchorType: VwapAnchorTypeEnum;

    // Signed % deviation of close from the active anchor; sign yields the side.
    vwapDeviationPct: number;
    // Normalized distance: deviation pct / 20-bar σ of deviations.
    vwapDeviationSigma: number;

    volumeRatio: number;
    volume20barAvg: MoneyValue;

    atr14: MoneyValue;
    adx14: number;
    adxDiPlus: number;
    adxDiMinus: number;
    rsi14: number;
    bollingerUpper: MoneyValue;
    bollingerLower: MoneyValue;
    bollingerPctB: number;

    close: MoneyValue;
    fiveMinMovePct: number;
}
