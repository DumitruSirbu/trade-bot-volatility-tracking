import { CoinTierEnum } from '@bot/shared';

// Emitted when a symbol enters or leaves the tradable universe (membership change),
// carrying its tier and 24h volume rank so downstream consumers can react.
export interface IUniverseTransition {
    symbol: string;
    tier: CoinTierEnum;
    volumeRank: number;
}
