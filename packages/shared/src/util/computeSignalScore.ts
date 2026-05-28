import { CoinTierEnum, FlowTypeEnum } from '../enum/index.js';
import { IVolatilityDetectedEvent } from '../interface/IVolatilityDetectedEvent.js';
import { IStrategyParams } from '../schema/strategyParamsSchema.js';

// Score component weights (no inline magic numbers)
const WEIGHT_DEVIATION = 0.35;
const WEIGHT_VOLUME = 0.25;
const WEIGHT_IDIOSYNCRASY = 0.25;
const WEIGHT_FUNDING_COST = 0.15;

// Volume normalization thresholds
const VOLUME_RATIO_MIN = 1.5; // baseline confirmation
const VOLUME_RATIO_MAX = 5.0; // hard ceiling for scoring

// Idiosyncrasy scoring rules
const IDIOSYNCRASY_REVERSION_PENALTY_FACTOR = 0.7; // penalize high idio on reversion branches
const IDIOSYNCRASY_NEUTRAL_SCORE = 50; // neutral contribution for market-beta / noise flows

// Funding cost (per-period rate, matches seed funding_rate_suppress_threshold)
// Unit: periodic rate (e.g., 0.001 = 0.1% per 8h), consistent with M2 seed
const FUNDING_COST_SUPPRESS_LEVEL = 0.001; // suppress scoring below this periodic rate
const FUNDING_COST_NEUTRAL_LEVEL = 0.01; // 1% per 8h = cap for cost scaling

/**
 * Compute signal quality score (0–100) from market snapshot deterministically.
 *
 * Inputs (all already on the event/snapshot; no float-money):
 * - vwapDeviationPct: normalized to tier bands from params
 * - volumeRatio: higher confirmation → higher score
 * - idiosyncrasyScore: flow-aware contribution (raised for momentum, lowered for reversion)
 * - fundingRate: per-period rate (0.001 ≈ 0.1% per 8h); inverse cost erodes score
 * - flowType: used to determine idiosyncrasy treatment (momentum vs reversion)
 *
 * Pure `number` math; identical inputs → identical score, live and backtest.
 */
export function computeSignalScore(event: IVolatilityDetectedEvent, params: IStrategyParams, flowType: FlowTypeEnum): number {
    // 1. Normalize vwapDeviationPct to tier band (from params)
    const tierMinMove = getTierMinAbsMove(event.coinTier, params);
    const tierMaxMove = getTierMaxAbsMove(event.coinTier, params);
    const tierBand = tierMaxMove - tierMinMove;
    const deviationAbsPct = Math.abs(event.vwapDeviationPct);
    const deviationNormalized = (deviationAbsPct - tierMinMove) / tierBand;
    const deviationClamped = Math.max(0, Math.min(1, deviationNormalized));
    const deviationScore = deviationClamped * 100;

    // 2. Volume ratio confirmation
    const volumeNormalized = Math.max(0, Math.min(1, (event.volumeRatio - VOLUME_RATIO_MIN) / (VOLUME_RATIO_MAX - VOLUME_RATIO_MIN)));
    const volumeScore = volumeNormalized * 100;

    // 3. Idiosyncrasy (flow-aware contribution per ADR §5)
    //    - Momentum-favorable flows (TREND_INITIATION, CATALYST_RISK): high idio → high score
    //    - Reversion thesis (FORCED_EXHAUSTION): high idio → low score (penalize)
    //    - Neutral (MARKET_BETA, LOW_QUALITY_NOISE): low contribution
    let idiosyncrasyScore = 0;

    if (flowType === FlowTypeEnum.TREND_INITIATION || flowType === FlowTypeEnum.CATALYST_RISK) {
        // Momentum-favorable: high idiosyncrasy is a feature (catalyst flow)
        idiosyncrasyScore = event.idiosyncrasyScore * 100;
    } else if (flowType === FlowTypeEnum.FORCED_EXHAUSTION) {
        // Reversion thesis: high idiosyncrasy is suspicious (not a clean exhaustion)
        const baseScore = (1 - event.idiosyncrasyScore) * 100;
        idiosyncrasyScore = baseScore * IDIOSYNCRASY_REVERSION_PENALTY_FACTOR;
    } else {
        // MARKET_BETA, LOW_QUALITY_NOISE: neutral, moderate contribution
        idiosyncrasyScore = IDIOSYNCRASY_NEUTRAL_SCORE;
    }

    idiosyncrasyScore = Math.max(0, Math.min(100, idiosyncrasyScore));

    // 4. Inverse funding cost (per-period rate, consistent with M2 seed)
    //    Unit: periodic rate (0.001 = 0.1% per 8h). Suppress near-zero costs; cap at 1%.
    let fundingCostScore = 100;

    if (event.fundingRate > FUNDING_COST_SUPPRESS_LEVEL) {
        const costRatio = Math.min(1, event.fundingRate / FUNDING_COST_NEUTRAL_LEVEL);
        fundingCostScore = (1 - costRatio) * 100;
    }

    // Weighted sum
    const rawScore =
        WEIGHT_DEVIATION * deviationScore + WEIGHT_VOLUME * volumeScore + WEIGHT_IDIOSYNCRASY * idiosyncrasyScore + WEIGHT_FUNDING_COST * fundingCostScore;

    // Clamp to [0, 100]

    return Math.max(0, Math.min(100, rawScore));
}

/**
 * Get tier-specific minimum absolute move % threshold from params.
 */
function getTierMinAbsMove(tier: CoinTierEnum, params: IStrategyParams): number {
    switch (tier) {
        case CoinTierEnum.TIER_1:
            return params.tier1_min_abs_move_pct;
        case CoinTierEnum.TIER_2:
            return params.tier2_min_abs_move_pct;
        case CoinTierEnum.TIER_3:
            return params.tier3_min_abs_move_pct;
    }
}

/**
 * Get tier-specific maximum absolute move % threshold from params.
 */
function getTierMaxAbsMove(tier: CoinTierEnum, params: IStrategyParams): number {
    switch (tier) {
        case CoinTierEnum.TIER_1:
            return params.tier1_max_abs_move_pct;
        case CoinTierEnum.TIER_2:
            return params.tier2_max_abs_move_pct;
        case CoinTierEnum.TIER_3:
            return params.tier3_max_abs_move_pct;
    }
}
