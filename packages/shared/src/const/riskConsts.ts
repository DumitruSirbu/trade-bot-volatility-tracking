import { CoinTierEnum } from '../enum/CoinTierEnum.js';

// Per-coin tier-keyed 10bps book-depth floor (USDT) — mirrors engine riskConsts /
// ADR 0004 §6a (M22). Shared copy is the single source of truth for read-API
// gate-detail projection; engine imports this constant for the live gate.
export const COIN_DEPTH_FLOOR_10BPS_USDT: Record<CoinTierEnum, number> = {
    [CoinTierEnum.TIER_1]: 10_000,
    [CoinTierEnum.TIER_2]: 2_500,
    [CoinTierEnum.TIER_3]: 2_000,
};
