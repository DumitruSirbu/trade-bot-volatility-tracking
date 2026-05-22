import { CoinTierEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// A symbol's membership in the tradable universe. `enteredAtMs` backs
// symbol-universe-age-hours (fresh entrants are pump-risk and generally skipped).
export interface IUniverseEntry {
    symbol: string;
    volumeRank: number;
    tier: CoinTierEnum;
    quoteVolume24h: MoneyValue;
    enteredAtMs: number;
}
