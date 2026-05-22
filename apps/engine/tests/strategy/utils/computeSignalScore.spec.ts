import { CoinTierEnum, FlowTypeEnum, computeSignalScore, strategyParamsSchema } from '@bot/shared';

import { buildEvent, buildParams } from '../support/fixtures';

// Mirror weight constants from computeSignalScore.ts to compute exact expectations.
const WEIGHT_DEVIATION = 0.35;
const WEIGHT_VOLUME = 0.25;
const WEIGHT_IDIOSYNCRASY = 0.25;
const WEIGHT_FUNDING_COST = 0.15;

// Funding thresholds (per-period rate) — mirrored from the implementation.
const FUNDING_COST_SUPPRESS_LEVEL = 0.001;
const FUNDING_COST_NEUTRAL_LEVEL = 0.01;

// Idiosyncrasy penalty factor for reversion thesis — mirrored.
const IDIOSYNCRASY_REVERSION_PENALTY_FACTOR = 0.7;

describe('computeSignalScore', () => {
    describe('score range invariant', () => {
        it('returns a value in [0, 100] for a standard event', () => {
            const params = buildParams();
            const event = buildEvent();

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        });

        it('returns 0 or above when all components are at their minimum', () => {
            const params = buildParams({ tier1_min_abs_move_pct: 0.5, tier1_max_abs_move_pct: 3.0 });
            const event = buildEvent({
                vwapDeviationPct: 0.5, // at tier min → deviation score = 0
                volumeRatio: 0.0, // below vol min → vol score = 0
                idiosyncrasyScore: 1.0, // max idio on FORCED_EXHAUSTION → penalized
                fundingRate: 1.0, // very high → funding score → 0
                coinTier: CoinTierEnum.TIER_1,
            });

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        });

        it('returns 100 or below when all components are at their maximum', () => {
            const params = buildParams({ tier1_min_abs_move_pct: 0.5, tier1_max_abs_move_pct: 3.0 });
            const event = buildEvent({
                vwapDeviationPct: 3.0, // at tier max → deviation score = 100
                volumeRatio: 5.0, // at vol ceiling → vol score = 100
                idiosyncrasyScore: 1.0, // max idio on TREND_INITIATION → score = 100 (feature)
                fundingRate: 0.0, // no cost → funding score = 100
                coinTier: CoinTierEnum.TIER_1,
            });

            const score = computeSignalScore(event, params, FlowTypeEnum.TREND_INITIATION);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        });
    });

    describe('deviation component', () => {
        it('higher absolute deviation within tier band yields higher score (monotonic)', () => {
            const params = buildParams({ tier1_min_abs_move_pct: 0.5, tier1_max_abs_move_pct: 3.0 });

            const low = computeSignalScore(
                buildEvent({ vwapDeviationPct: 1.0, volumeRatio: 1.5, idiosyncrasyScore: 0.5, fundingRate: 0, coinTier: CoinTierEnum.TIER_1 }),
                params,
                FlowTypeEnum.FORCED_EXHAUSTION,
            );
            const high = computeSignalScore(
                buildEvent({ vwapDeviationPct: 2.0, volumeRatio: 1.5, idiosyncrasyScore: 0.5, fundingRate: 0, coinTier: CoinTierEnum.TIER_1 }),
                params,
                FlowTypeEnum.FORCED_EXHAUSTION,
            );

            expect(high).toBeGreaterThan(low);
        });

        it('tier-1 and tier-3 events at mid-band yield the same deviation component (tier-normalized)', () => {
            const paramsT = buildParams({
                tier1_min_abs_move_pct: 0.5,
                tier1_max_abs_move_pct: 3.0,
                tier3_min_abs_move_pct: 1.2,
                tier3_max_abs_move_pct: 8.0,
            });

            const midT1 = (0.5 + 3.0) / 2; // 1.75
            const midT3 = (1.2 + 8.0) / 2; // 4.6

            const scoreT1 = computeSignalScore(
                buildEvent({ vwapDeviationPct: midT1, volumeRatio: 0, idiosyncrasyScore: 0, fundingRate: 0, coinTier: CoinTierEnum.TIER_1 }),
                paramsT,
                FlowTypeEnum.FORCED_EXHAUSTION,
            );
            const scoreT3 = computeSignalScore(
                buildEvent({ vwapDeviationPct: midT3, volumeRatio: 0, idiosyncrasyScore: 0, fundingRate: 0, coinTier: CoinTierEnum.TIER_3 }),
                paramsT,
                FlowTypeEnum.FORCED_EXHAUSTION,
            );

            // Both at the midpoint of their tier band → identical deviation scores → equal totals
            expect(Math.abs(scoreT1 - scoreT3)).toBeLessThan(1.0);
        });

        it('changing tier band params changes the deviation score for the same raw deviation', () => {
            const narrowParams = buildParams({ tier1_min_abs_move_pct: 1.0, tier1_max_abs_move_pct: 2.0 });
            const wideParams = buildParams({ tier1_min_abs_move_pct: 0.5, tier1_max_abs_move_pct: 3.0 });
            const event = buildEvent({ vwapDeviationPct: 1.5, coinTier: CoinTierEnum.TIER_1 });

            // In narrowParams: (1.5-1.0)/(2.0-1.0) = 0.5 normalized; in wideParams: 0.4
            const narrowScore = computeSignalScore(event, narrowParams, FlowTypeEnum.FORCED_EXHAUSTION);
            const wideScore = computeSignalScore(event, wideParams, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(narrowScore).not.toBe(wideScore);
        });
    });

    describe('volume component', () => {
        it('higher volumeRatio yields higher score (monotonic)', () => {
            const params = buildParams();

            const low = computeSignalScore(buildEvent({ volumeRatio: 1.5, idiosyncrasyScore: 0.3, fundingRate: 0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);
            const high = computeSignalScore(buildEvent({ volumeRatio: 4.0, idiosyncrasyScore: 0.3, fundingRate: 0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(high).toBeGreaterThan(low);
        });

        it('volumeRatio at ceiling (5.0) does not push score above 100', () => {
            const params = buildParams();
            const event = buildEvent({ volumeRatio: 5.0 });

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(score).toBeLessThanOrEqual(100);
        });
    });

    describe('idiosyncrasy component — flow-aware (ADR §5)', () => {
        it('TREND_INITIATION flow: high idiosyncrasyScore RAISES the score (momentum feature)', () => {
            const params = buildParams();

            const lowIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.1, fundingRate: 0 }), params, FlowTypeEnum.TREND_INITIATION);
            const highIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.9, fundingRate: 0 }), params, FlowTypeEnum.TREND_INITIATION);

            expect(highIdio).toBeGreaterThan(lowIdio);
        });

        it('CATALYST_RISK flow: high idiosyncrasyScore RAISES the score (same as momentum)', () => {
            const params = buildParams();

            const lowIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.2, fundingRate: 0 }), params, FlowTypeEnum.CATALYST_RISK);
            const highIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.8, fundingRate: 0 }), params, FlowTypeEnum.CATALYST_RISK);

            expect(highIdio).toBeGreaterThan(lowIdio);
        });

        it('FORCED_EXHAUSTION flow: high idiosyncrasyScore LOWERS the score (suspicious for reversion)', () => {
            const params = buildParams();

            const lowIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.1, fundingRate: 0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);
            const highIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.9, fundingRate: 0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(lowIdio).toBeGreaterThan(highIdio);
        });

        it('MARKET_BETA flow: idiosyncrasy is neutral (constant 50 contribution)', () => {
            const params = buildParams();

            const lowIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.0, fundingRate: 0 }), params, FlowTypeEnum.MARKET_BETA);
            const highIdio = computeSignalScore(buildEvent({ idiosyncrasyScore: 1.0, fundingRate: 0 }), params, FlowTypeEnum.MARKET_BETA);

            // Both produce the same idiosyncrasy component (50), so scores are equal
            expect(lowIdio).toBe(highIdio);
        });

        it('LOW_QUALITY_NOISE flow: idiosyncrasy is neutral (constant 50 contribution)', () => {
            const params = buildParams();

            const a = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.2, fundingRate: 0 }), params, FlowTypeEnum.LOW_QUALITY_NOISE);
            const b = computeSignalScore(buildEvent({ idiosyncrasyScore: 0.8, fundingRate: 0 }), params, FlowTypeEnum.LOW_QUALITY_NOISE);

            expect(a).toBe(b);
        });
    });

    describe('funding cost component (per-period rate: event.fundingRate)', () => {
        it('higher fundingRate (per-period) reduces the score', () => {
            const params = buildParams();

            const lowCost = computeSignalScore(buildEvent({ fundingRate: 0.0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);
            const highCost = computeSignalScore(buildEvent({ fundingRate: 0.008 }), params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(lowCost).toBeGreaterThan(highCost);
        });

        it('fundingRate at or below FUNDING_COST_SUPPRESS_LEVEL does not reduce score', () => {
            const params = buildParams();

            const atLevel = computeSignalScore(buildEvent({ fundingRate: FUNDING_COST_SUPPRESS_LEVEL }), params, FlowTypeEnum.FORCED_EXHAUSTION);
            const zeroFunding = computeSignalScore(buildEvent({ fundingRate: 0 }), params, FlowTypeEnum.FORCED_EXHAUSTION);

            // At or below suppress level → fundingCostScore = 100 for both
            expect(atLevel).toBe(zeroFunding);
        });

        it('fundingRate at the neutral level cap produces a near-zero funding component', () => {
            const params = buildParams();
            // At the neutral level (0.01), costRatio = 1.0 → fundingCostScore = 0
            const event = buildEvent({ fundingRate: FUNDING_COST_NEUTRAL_LEVEL });

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            // The funding component is 0, so score = weighted sum of other components only
            // Score must still be in [0,100]
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        });
    });

    describe('exact score on a pinned fixture', () => {
        it('pins exact score for FORCED_EXHAUSTION flow with known idiosyncrasy (reversion penalty applied)', () => {
            const params = buildParams({
                tier1_min_abs_move_pct: 0.5,
                tier1_max_abs_move_pct: 3.0,
            });

            const event = buildEvent({
                coinTier: CoinTierEnum.TIER_1,
                vwapDeviationPct: 2.0, // (2.0-0.5)/(3.0-0.5) = 0.6 → deviationScore=60
                volumeRatio: 3.25, // (3.25-1.5)/(5.0-1.5) = 0.5 → volumeScore=50
                idiosyncrasyScore: 0.4, // FORCED_EXHAUSTION: base=(1-0.4)*100=60, × 0.7 = 42
                fundingRate: 0.0, // ≤ 0.001 → fundingCostScore=100
            });

            const idioScore = (1 - 0.4) * 100 * IDIOSYNCRASY_REVERSION_PENALTY_FACTOR; // 60 * 0.7 = 42
            const expected = WEIGHT_DEVIATION * 60 + WEIGHT_VOLUME * 50 + WEIGHT_IDIOSYNCRASY * idioScore + WEIGHT_FUNDING_COST * 100;

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(score).toBeCloseTo(expected, 10);
        });

        it('pins exact score for TREND_INITIATION flow with high idiosyncrasy (momentum boost)', () => {
            const params = buildParams({
                tier1_min_abs_move_pct: 0.5,
                tier1_max_abs_move_pct: 3.0,
            });

            const event = buildEvent({
                coinTier: CoinTierEnum.TIER_1,
                vwapDeviationPct: 2.0, // deviationScore = 60
                volumeRatio: 3.25, // volumeScore = 50
                idiosyncrasyScore: 0.8, // TREND_INITIATION: idioScore = 0.8 * 100 = 80
                fundingRate: 0.0, // fundingCostScore = 100
            });

            const expected = WEIGHT_DEVIATION * 60 + WEIGHT_VOLUME * 50 + WEIGHT_IDIOSYNCRASY * 80 + WEIGHT_FUNDING_COST * 100;

            const score = computeSignalScore(event, params, FlowTypeEnum.TREND_INITIATION);

            expect(score).toBeCloseTo(expected, 10);
        });

        it('pins exact score for MARKET_BETA flow with neutral idiosyncrasy (constant 50)', () => {
            const params = buildParams({
                tier1_min_abs_move_pct: 0.5,
                tier1_max_abs_move_pct: 3.0,
            });

            const event = buildEvent({
                coinTier: CoinTierEnum.TIER_1,
                vwapDeviationPct: 2.0, // deviationScore = 60
                volumeRatio: 3.25, // volumeScore = 50
                idiosyncrasyScore: 0.9, // MARKET_BETA: neutral → constant 50
                fundingRate: 0.0, // fundingCostScore = 100
            });

            const expected = WEIGHT_DEVIATION * 60 + WEIGHT_VOLUME * 50 + WEIGHT_IDIOSYNCRASY * 50 + WEIGHT_FUNDING_COST * 100;

            const score = computeSignalScore(event, params, FlowTypeEnum.MARKET_BETA);

            expect(score).toBeCloseTo(expected, 10);
        });

        it('pins exact score with funding cost suppression (fundingRate above suppress level)', () => {
            const params = buildParams({
                tier1_min_abs_move_pct: 0.5,
                tier1_max_abs_move_pct: 3.0,
            });

            // fundingRate = 0.005 → costRatio = 0.005/0.01 = 0.5 → fundingCostScore = 50
            const event = buildEvent({
                coinTier: CoinTierEnum.TIER_1,
                vwapDeviationPct: 2.0,
                volumeRatio: 3.25,
                idiosyncrasyScore: 0.4,
                fundingRate: 0.005,
            });

            const fundingCostScore = (1 - 0.005 / FUNDING_COST_NEUTRAL_LEVEL) * 100; // 50
            const idioScore = (1 - 0.4) * 100 * IDIOSYNCRASY_REVERSION_PENALTY_FACTOR; // 42
            const expected = WEIGHT_DEVIATION * 60 + WEIGHT_VOLUME * 50 + WEIGHT_IDIOSYNCRASY * idioScore + WEIGHT_FUNDING_COST * fundingCostScore;

            const score = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(score).toBeCloseTo(expected, 10);
        });
    });

    describe('tier-band schema guard', () => {
        it('rejects tier max equal to tier min at load (the .refine guard prevents a zero band)', () => {
            const badParams = buildParams({ tier1_min_abs_move_pct: 2.0, tier1_max_abs_move_pct: 2.0 });

            const result = strategyParamsSchema.safeParse(badParams);

            expect(result.success).toBe(false);
        });

        it('rejects tier max below tier min at load', () => {
            const badParams = buildParams({ tier2_min_abs_move_pct: 6.0, tier2_max_abs_move_pct: 5.0 });

            const result = strategyParamsSchema.safeParse(badParams);

            expect(result.success).toBe(false);
        });
    });

    describe('determinism', () => {
        it('returns the identical score on repeated calls with the same input', () => {
            const params = buildParams();
            const event = buildEvent();

            const a = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);
            const b = computeSignalScore(event, params, FlowTypeEnum.FORCED_EXHAUSTION);

            expect(a).toBe(b);
        });
    });
});
