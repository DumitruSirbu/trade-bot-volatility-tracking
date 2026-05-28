import { Decimal } from 'decimal.js';
import { FlowTypeEnum } from '../enum/FlowTypeEnum.js';
import { IVolatilityDetectedEvent } from '../interface/IVolatilityDetectedEvent.js';
import { IStrategyParams } from '../schema/strategyParamsSchema.js';

// Classification thresholds — deterministic, no magic numbers
const OI_FALLING_THRESHOLD_PCT = -0.5; // OI falling 0.5% or more
const VOLUME_SPIKE_THRESHOLD = 2.0; // volume_ratio >= 2.0 = clear spike
const SPREAD_TIGHT_THRESHOLD_PCT = 0.03; // spread <= 3bps = tight/passive
const SYMBOL_UNIVERSE_AGE_NEW_THRESHOLD_HOURS = 48.0; // symbol < 48h in top-300 = nascent
const FUNDING_ELEVATED_THRESHOLD_ANNUALIZED = 0.05; // 5% annualized funding = elevated
const DEPTH_MIN_RATIO_TO_OI = 0.01; // shallow depth: < 1% of open interest
const NO_VOLUME_CONFIRMATION_RATIO = 1.2; // weak volume spike threshold

/**
 * Classify flow type from market snapshot + params.
 *
 * Pure, deterministic function reading only fields already on IVolatilityDetectedEvent.
 * Enforces idiosyncratic-altcoin trap: when idiosyncrasyScore >= params.idiosyncrasy_min_score
 * AND openInterestChange5mPct > 0 AND volumeRatio >= params.volume_ratio_min,
 * never return FORCED_EXHAUSTION (return CATALYST_RISK instead).
 */
export function classifyFlowType(event: IVolatilityDetectedEvent, params: IStrategyParams): FlowTypeEnum {
    // Trap guard: idiosyncratic + rising OI + rising volume = catalyst/informed flow, never fade
    if (event.idiosyncrasyScore >= params.idiosyncrasy_min_score && event.openInterestChange5mPct > 0 && event.volumeRatio >= params.volume_ratio_min) {
        return FlowTypeEnum.CATALYST_RISK;
    }

    // Decision tree in order of specificity:

    // 1. Liquidation cascade signature: OI falling sharply on the spike
    //    (exhaustion detected via OI collapse, not volume spike alone).

    if (event.openInterestChange5mPct <= OI_FALLING_THRESHOLD_PCT) {
        return FlowTypeEnum.FORCED_EXHAUSTION;
    }

    // 2. Catalyst / informed flow indicators: elevated funding + high volume + new symbol

    if (
        event.fundingRateAnnualized > FUNDING_ELEVATED_THRESHOLD_ANNUALIZED &&
        event.volumeRatio >= VOLUME_SPIKE_THRESHOLD &&
        event.symbolUniverseAgeHours <= SYMBOL_UNIVERSE_AGE_NEW_THRESHOLD_HOURS
    ) {
        return FlowTypeEnum.CATALYST_RISK;
    }

    // 3. Market stress: extreme breadth + same-bar pile-on (params-driven thresholds)

    if (event.marketBreadth5mUpPct > params.stress_breadth_pct && event.sameBarTriggerCount >= params.stress_same_bar_trigger_count) {
        return FlowTypeEnum.MARKET_BETA;
    }

    // 4. Low-quality noise: tight spread + shallow depth + no volume confirmation
    const bookDepth = new Decimal(event.bookDepth10bpsUsdt);
    const openInterest = new Decimal(event.openInterest);
    const depthThreshold = openInterest.times(DEPTH_MIN_RATIO_TO_OI);

    if (event.bidAskSpreadPct <= SPREAD_TIGHT_THRESHOLD_PCT && bookDepth.lessThan(depthThreshold) && event.volumeRatio < NO_VOLUME_CONFIRMATION_RATIO) {
        return FlowTypeEnum.LOW_QUALITY_NOISE;
    }

    // 5. Default to trend initiation for confirmed moves (volume spike + structural intent)

    if (event.volumeRatio >= VOLUME_SPIKE_THRESHOLD && event.fundingRate > 0) {
        return FlowTypeEnum.TREND_INITIATION;
    }

    // 6. Fall-through: assume trend initiation for unclassified volume-driven moves

    return FlowTypeEnum.TREND_INITIATION;
}
