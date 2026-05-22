import { MoneyValue } from '../../common/utils';

// An OI sample. Persisted to `open_interest`, idempotent on UNIQUE(symbol, ts).
export interface IOpenInterestSampledEvent {
    symbol: string;
    tsMs: number;
    value: MoneyValue;
}
