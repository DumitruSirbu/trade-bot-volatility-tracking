import { CoinTierEnum } from '@bot/shared';

// Universe sizing (M1 task: top 200–300 by 24h volume with a liquidity floor).
export const UNIVERSE_MAX_SYMBOLS = 50;

// Stablecoins by base symbol — excluded from the universe regardless of volume rank.
// These have negligible VWAP deviation and produce zero signal; tracking them wastes
// DB space and pollutes breadth / sameBarTriggerCount metrics.
export const STABLECOIN_BASE_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDD', 'DAI', 'USDP', 'GUSD', 'FRAX', 'LUSD']);

// Liquidity floor in 24h quote (USDT) volume — below this a symbol is too thin to
// trade safely regardless of rank. Decimal-as-string (money never float).
export const UNIVERSE_MIN_QUOTE_VOLUME_USDT = '20000000';

// Tier bands by volume rank (1-based). tier1 = top 50, tier2 = 51–150,
// tier3 = 151–300. Re-evaluated on every refresh.
export const TIER_1_MAX_RANK = 50;
export const TIER_2_MAX_RANK = 150;
export const TIER_3_MAX_RANK = 300;

export const COIN_TIER_BY_MAX_RANK: ReadonlyArray<{ maxRank: number; tier: CoinTierEnum }> = [
    { maxRank: TIER_1_MAX_RANK, tier: CoinTierEnum.TIER_1 },
    { maxRank: TIER_2_MAX_RANK, tier: CoinTierEnum.TIER_2 },
    { maxRank: TIER_3_MAX_RANK, tier: CoinTierEnum.TIER_3 },
];

// Universe refresh cadence. Hourly is frequent enough to catch new listings /
// volume rotation without churning tier assignments mid-session.
export const UNIVERSE_REFRESH_CRON = '0 * * * *';

// Reference symbols whose moves drive idiosyncrasy + market-stress inputs.
export const BTC_REFERENCE_SYMBOL = 'BTC/USDT:USDT';
export const ETH_REFERENCE_SYMBOL = 'ETH/USDT:USDT';
