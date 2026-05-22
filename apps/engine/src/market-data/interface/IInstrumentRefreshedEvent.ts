import { CoinTierEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils';

// Tradable-universe metadata snapshot. Persisted to `instruments` as an UPSERT on
// UNIQUE(symbol) (ADR 0002 §4). Money fields are MoneyValue, never float.
export interface IInstrumentRefreshedEvent {
    symbol: string;
    base: string;
    quote: string;
    status: string;
    tickSize: MoneyValue;
    stepSize: MoneyValue;
    minNotional: MoneyValue;
    isTradable: boolean;
    volume24h: MoneyValue;
    coinTier: CoinTierEnum;
}
