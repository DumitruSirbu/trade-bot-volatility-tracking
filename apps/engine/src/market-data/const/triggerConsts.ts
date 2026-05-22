import { CoinTierEnum, VwapAnchorTypeEnum } from '@bot/shared';

// Default strategy-version trigger params. In live these come from the active
// strategy version's `params` jsonb (M7-calibrated); until that table exists
// (M2+), the engine resolves these defaults. σ is a NORMALIZED DISTANCE, not a
// probability — crypto returns are fat-tailed, bands are calibrated empirically.
export const DEFAULT_VWAP_SIGMA_TRIGGER = 2.5;
export const DEFAULT_VOLUME_RATIO_MIN = 2;

// Per-tier absolute-move bands (% deviation from VWAP), resolved from CoinTierEnum
// per ADR §3 "Trigger params — source of truth". Tighter caps on higher-rank
// (more liquid, lower-vol) tiers; wider tolerance on thin tier-3 names.
export const TIER_ABS_MOVE_BANDS_PCT: Readonly<Record<CoinTierEnum, { min: number; max: number }>> = {
    [CoinTierEnum.TIER_1]: { min: 0.8, max: 6 },
    [CoinTierEnum.TIER_2]: { min: 1.2, max: 9 },
    [CoinTierEnum.TIER_3]: { min: 1.8, max: 14 },
};

// Active VWAP anchor carried in the emitted payload. The 20-bar rolling anchor is
// the M1 default; M7 backtests compare anchors rather than assuming one is best.
export const ACTIVE_VWAP_ANCHOR_TYPE = VwapAnchorTypeEnum.ROLLING_20BAR;
