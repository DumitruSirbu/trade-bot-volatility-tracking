import { MoneyValue } from '../../common/utils';

// A CLOSED fixed 1-second OHLCV bucket. Persisted to `tick_aggregates`, idempotent on
// UNIQUE(symbol, ts) where ts is the bucket-START ms (ADR 0002 §4). Carrying open/high/
// low/close (not just last price) lets the M7 backtest reconstruct an intra-candle /
// intra-second spike with full fidelity. Money fields are MoneyValue, never float.
export interface ITickAggregateEvent {
    symbol: string;
    // Bucket start (floor of the tick ts to the second), in ms.
    tsMs: number;
    open: MoneyValue;
    high: MoneyValue;
    low: MoneyValue;
    close: MoneyValue;
    volume: MoneyValue;
}
