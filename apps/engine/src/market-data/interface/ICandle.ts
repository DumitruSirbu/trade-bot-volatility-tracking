import { MoneyValue } from '../../common/utils/money';

// An OHLCV bar. Price/volume fields are decimal (MoneyValue) — never float.
// `openTimeMs` is the bar's open boundary (epoch ms); `isClosed` distinguishes the
// forming candle from graduated closed bars (closed-bars-only invariant, ADR §4).
export interface ICandle {
    openTimeMs: number;
    open: MoneyValue;
    high: MoneyValue;
    low: MoneyValue;
    close: MoneyValue;
    // Base-asset volume traded in the bar.
    volume: MoneyValue;
    // Sum of price × volume, for true VWAP (typical-price approximation in M1).
    quoteVolume: MoneyValue;
    isClosed: boolean;
}
