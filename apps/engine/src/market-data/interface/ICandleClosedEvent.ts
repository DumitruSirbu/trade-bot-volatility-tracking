import { ICandle } from './ICandle';

// Emitted when a 1m or 5m bar graduates. Persisted to `candles`, idempotent on
// UNIQUE(symbol, interval, open_time) (ADR 0002 §4).
export interface ICandleClosedEvent {
    symbol: string;
    interval: '1m' | '5m';
    candle: ICandle;
}
