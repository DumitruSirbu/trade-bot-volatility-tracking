import { CoinTierEnum, ITriggerParams } from '@bot/shared';

import { DEFAULT_VOLUME_RATIO_MIN, DEFAULT_VWAP_SIGMA_TRIGGER, TIER_ABS_MOVE_BANDS_PCT } from '../const';

// Resolves the trigger params for a symbol's tier (ADR §3 "Trigger params — source
// of truth"): σ and volume defaults are tier-independent strategy-version params;
// the absolute-move bands are per-tier. Lives in utils/ because it is a function,
// not a constant.
export function resolveTriggerParams(tier: CoinTierEnum): ITriggerParams {
    const band = TIER_ABS_MOVE_BANDS_PCT[tier];

    return {
        vwapSigmaTrigger: DEFAULT_VWAP_SIGMA_TRIGGER,
        volumeRatioMin: DEFAULT_VOLUME_RATIO_MIN,
        tierMinAbsMovePct: band.min,
        tierMaxAbsMovePct: band.max,
    };
}
