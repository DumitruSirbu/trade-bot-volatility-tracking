import { MoneyValue } from '../../common/utils';

// A funding-rate observation. Persisted to `funding_rates`, idempotent on
// UNIQUE(symbol, funding_time). The rate is a ratio carried as MoneyValue so precision
// is preserved end-to-end (ADR 0002 §2/§4).
export interface IFundingRateObservedEvent {
    symbol: string;
    fundingTimeMs: number;
    rate: MoneyValue;
}
