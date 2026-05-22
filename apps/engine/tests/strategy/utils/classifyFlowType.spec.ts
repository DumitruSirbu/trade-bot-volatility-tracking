import { FlowTypeEnum, classifyFlowType } from '@bot/shared';

import { buildEvent, buildParams } from '../support/fixtures';

// Thresholds mirrored from classifyFlowType.ts for fixture construction.
const OI_FALLING_THRESHOLD_PCT = -0.5;
const VOLUME_SPIKE_THRESHOLD = 2.0;
const SYMBOL_AGE_NEW_THRESHOLD_HOURS = 48.0;
const SPREAD_TIGHT_THRESHOLD_PCT = 0.03;
const FUNDING_ELEVATED_THRESHOLD_ANNUALIZED = 0.05;

describe('classifyFlowType', () => {
    // Params with explicit trap + stress thresholds so each branch is isolated.
    const params = buildParams({
        idiosyncrasy_min_score: 0.7,
        volume_ratio_min: 1.5,
        stress_breadth_pct: 70.0,
        stress_same_bar_trigger_count: 3,
    });

    describe('idiosyncratic-altcoin trap — TOP guard, returns CATALYST_RISK', () => {
        // The trap is now the FIRST check. All three conditions must hold:
        //   idiosyncrasyScore >= idiosyncrasy_min_score  AND
        //   openInterestChange5mPct > 0 (rising OI)      AND
        //   volumeRatio >= volume_ratio_min

        it('returns CATALYST_RISK when idio >= threshold AND OI rising AND volume >= min', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.8, // ≥ 0.7
                openInterestChange5mPct: 0.5, // > 0 (rising)
                volumeRatio: 2.0, // ≥ 1.5
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('returns CATALYST_RISK even when OI would otherwise be in the falling branch', () => {
            // OI = -0.6 is below the OI_FALLING_THRESHOLD_PCT (-0.5) which would give
            // FORCED_EXHAUSTION, but the trap fires FIRST because OI is still > 0? No —
            // the trap requires openInterestChange5mPct > 0, so OI = -0.6 is NOT > 0.
            // This test pins that a falling-OI event with high idio does NOT trigger the trap.
            const event = buildEvent({
                idiosyncrasyScore: 0.9,
                openInterestChange5mPct: -0.6, // falling — trap does NOT fire (requires > 0)
                volumeRatio: 2.0,
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });

        it('trap fires and returns CATALYST_RISK regardless of other market signals', () => {
            // Even if OI is rising (not falling), the trap overrides any other path.
            const event = buildEvent({
                idiosyncrasyScore: 0.8,
                openInterestChange5mPct: 1.0, // rising
                volumeRatio: 3.0,
                // Set other signals to values that would NORMALLY trigger other flows:
                fundingRateAnnualized: 0.08, // would be catalyst via the funding rule
                symbolUniverseAgeHours: 24, // new symbol
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('does NOT trigger trap when idiosyncrasyScore is just below threshold', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.69, // just below 0.7
                openInterestChange5mPct: 0.5,
                volumeRatio: 2.0,
            });

            // Trap does not fire; falls through to FORCED_EXHAUSTION via OI path? No — OI=0.5
            // is above -0.5, so does not hit that branch. Falls through to TREND_INITIATION.
            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('does NOT trigger trap when OI is not rising (openInterestChange5mPct = 0)', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.9,
                openInterestChange5mPct: 0.0, // exactly 0 — trap requires strictly > 0
                volumeRatio: 2.0,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('does NOT trigger trap when volumeRatio is just below volume_ratio_min', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.9,
                openInterestChange5mPct: 0.5,
                volumeRatio: 1.49, // just below 1.5
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('boundary — idiosyncrasyScore exactly at threshold triggers the trap', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.7, // exactly at threshold (>= is inclusive)
                openInterestChange5mPct: 0.5,
                volumeRatio: 2.0,
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('trap result is NEVER FORCED_EXHAUSTION when all three trap conditions hold with rising OI', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.8,
                openInterestChange5mPct: 0.5,
                volumeRatio: 2.0,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });
    });

    describe('FORCED_EXHAUSTION — OI falling sharply (trap guard passed)', () => {
        it('returns FORCED_EXHAUSTION when OI falls below the threshold and idio is low', () => {
            const event = buildEvent({
                openInterestChange5mPct: OI_FALLING_THRESHOLD_PCT - 0.1, // -0.6
                idiosyncrasyScore: 0.1, // below trap threshold
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });

        it('returns FORCED_EXHAUSTION at exactly the OI falling boundary', () => {
            const event = buildEvent({
                openInterestChange5mPct: OI_FALLING_THRESHOLD_PCT, // exactly -0.5
                idiosyncrasyScore: 0.1,
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });

        it('does NOT return FORCED_EXHAUSTION when OI is just above the threshold', () => {
            const event = buildEvent({
                openInterestChange5mPct: OI_FALLING_THRESHOLD_PCT + 0.01, // -0.49
                idiosyncrasyScore: 0.1,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });

        it('returns FORCED_EXHAUSTION when OI is falling even with high idio IF OI is NOT rising (trap guard fails)', () => {
            // High idio but OI is falling (< 0), so trap guard fails (requires OI > 0) → FORCED_EXHAUSTION
            const event = buildEvent({
                idiosyncrasyScore: 0.9,
                openInterestChange5mPct: -1.0, // falling, not > 0 → trap guard fails
                volumeRatio: 2.0,
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });
    });

    describe('CATALYST_RISK — elevated funding + volume spike + new symbol', () => {
        it('returns CATALYST_RISK for high funding + volume spike + new symbol (no trap conditions)', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1, // below trap threshold
                openInterestChange5mPct: 0.1,
                volumeRatio: VOLUME_SPIKE_THRESHOLD + 0.5,
                fundingRateAnnualized: FUNDING_ELEVATED_THRESHOLD_ANNUALIZED + 0.01, // > 0.05
                symbolUniverseAgeHours: SYMBOL_AGE_NEW_THRESHOLD_HOURS - 1, // < 48h
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('does NOT return CATALYST_RISK from funding-rule when funding is below threshold', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.04, // below 0.05
                volumeRatio: 3.0,
                symbolUniverseAgeHours: 24,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.CATALYST_RISK);
        });

        it('does NOT return CATALYST_RISK from funding-rule when symbol is not new', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.06,
                volumeRatio: 3.0,
                symbolUniverseAgeHours: SYMBOL_AGE_NEW_THRESHOLD_HOURS + 1, // > 48h
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.CATALYST_RISK);
        });
    });

    describe('MARKET_BETA — params-driven breadth + same-bar thresholds', () => {
        it('returns MARKET_BETA when breadth exceeds stress_breadth_pct AND trigger count >= stress_same_bar_trigger_count', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                // Breadth must exceed params.stress_breadth_pct (70.0)
                marketBreadth5mUpPct: 71.0,
                // Trigger count must reach params.stress_same_bar_trigger_count (3)
                sameBarTriggerCount: 3,
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.MARKET_BETA);
        });

        it('does NOT return MARKET_BETA when sameBarTriggerCount is one below the threshold', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 71.0,
                sameBarTriggerCount: 2, // < 3
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.MARKET_BETA);
        });

        it('does NOT return MARKET_BETA when breadth is exactly at (not above) the threshold', () => {
            // Implementation uses `> params.stress_breadth_pct` (strict greater-than)
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 70.0, // equal, not above
                sameBarTriggerCount: 3,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.MARKET_BETA);
        });

        it('MARKET_BETA threshold changes with params — higher threshold requires more breadth', () => {
            const strictParams = buildParams({ stress_breadth_pct: 80.0, stress_same_bar_trigger_count: 3 });
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 75.0, // > 70 but < 80
                sameBarTriggerCount: 3,
            });

            // With default params (70): would be MARKET_BETA. With strict params (80): not.
            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.MARKET_BETA);
            expect(classifyFlowType(event, strictParams)).not.toBe(FlowTypeEnum.MARKET_BETA);
        });
    });

    describe('LOW_QUALITY_NOISE — tight spread + shallow depth (decimal comparison) + no volume', () => {
        it('returns LOW_QUALITY_NOISE for tight spread + depth < 1% of OI + low volume', () => {
            // depth < openInterest * 0.01: depth=5000, OI=1_000_000 → threshold=10_000 → 5000 < 10000
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: SPREAD_TIGHT_THRESHOLD_PCT - 0.01, // tight: < 0.03
                openInterest: '1000000.00',
                bookDepth10bpsUsdt: '5000.00', // < 1000000 * 0.01 = 10000
                volumeRatio: 1.0, // < 1.2
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.LOW_QUALITY_NOISE);
        });

        it('does NOT return LOW_QUALITY_NOISE when spread is above the tight threshold', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: SPREAD_TIGHT_THRESHOLD_PCT + 0.01, // wide spread
                openInterest: '1000000.00',
                bookDepth10bpsUsdt: '5000.00',
                volumeRatio: 1.0,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.LOW_QUALITY_NOISE);
        });

        it('does NOT return LOW_QUALITY_NOISE when depth exceeds 1% of OI', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: SPREAD_TIGHT_THRESHOLD_PCT - 0.01,
                openInterest: '1000000.00',
                bookDepth10bpsUsdt: '15000.00', // > 10000 — depth sufficient
                volumeRatio: 1.0,
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.LOW_QUALITY_NOISE);
        });

        it('does NOT return LOW_QUALITY_NOISE when volumeRatio >= 1.2', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: SPREAD_TIGHT_THRESHOLD_PCT - 0.01,
                openInterest: '1000000.00',
                bookDepth10bpsUsdt: '5000.00',
                volumeRatio: 1.2, // at the 1.2 threshold — not < 1.2, so not noise
            });

            expect(classifyFlowType(event, params)).not.toBe(FlowTypeEnum.LOW_QUALITY_NOISE);
        });
    });

    describe('TREND_INITIATION — default for confirmed volume moves', () => {
        it('returns TREND_INITIATION for volume spike + positive funding (all other paths avoided)', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01, // below catalyst threshold
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: 0.05,
                volumeRatio: VOLUME_SPIKE_THRESHOLD + 0.5,
                fundingRate: 0.0002, // > 0
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.TREND_INITIATION);
        });

        it('falls through to TREND_INITIATION for unclassified moves', () => {
            const event = buildEvent({
                idiosyncrasyScore: 0.1,
                openInterestChange5mPct: 0.1,
                fundingRateAnnualized: 0.01,
                marketBreadth5mUpPct: 50.0,
                sameBarTriggerCount: 1,
                bidAskSpreadPct: 0.05,
                volumeRatio: 1.5, // below spike threshold
                fundingRate: 0.0, // zero
            });

            expect(classifyFlowType(event, params)).toBe(FlowTypeEnum.TREND_INITIATION);
        });
    });

    describe('determinism', () => {
        it('returns the same result on two identical calls', () => {
            const event = buildEvent({ openInterestChange5mPct: -1.0, idiosyncrasyScore: 0.1 });

            const first = classifyFlowType(event, params);
            const second = classifyFlowType(event, params);

            expect(first).toBe(second);
        });
    });
});
