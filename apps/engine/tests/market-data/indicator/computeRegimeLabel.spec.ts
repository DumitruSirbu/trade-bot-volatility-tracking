import { RegimeLabelEnum } from '@bot/shared';

import { computeRegimeLabel } from '../../../src/market-data/indicator/computeRegimeLabel';
import { ADX_RANGING_MAX, ADX_TRENDING_MIN } from '../../../src/market-data/const';

// Thresholds from the implementation: < 20 ranging, > 25 trending, 20–25 transitioning.
// Tests use the constants so they follow the implementation without hard-coding magic numbers.

describe('computeRegimeLabel', () => {
    describe('ranging regime (ADX < 20)', () => {
        it('returns RANGING when ADX is zero', () => {
            expect(computeRegimeLabel(0, 20, 10)).toBe(RegimeLabelEnum.RANGING);
        });

        it('returns RANGING when ADX is well below the threshold', () => {
            expect(computeRegimeLabel(10, 30, 10)).toBe(RegimeLabelEnum.RANGING);
        });

        it('returns RANGING when ADX is one epsilon below the threshold', () => {
            expect(computeRegimeLabel(ADX_RANGING_MAX - 0.001, 30, 10)).toBe(RegimeLabelEnum.RANGING);
        });

        it('does NOT return RANGING when ADX equals the threshold exactly', () => {
            // At exactly 20, ADX is not < 20, so it must not be RANGING.
            expect(computeRegimeLabel(ADX_RANGING_MAX, 30, 10)).not.toBe(RegimeLabelEnum.RANGING);
        });
    });

    describe('transitioning regime (20 ≤ ADX ≤ 25)', () => {
        it('returns TRANSITIONING when ADX equals the lower boundary exactly', () => {
            expect(computeRegimeLabel(ADX_RANGING_MAX, 30, 10)).toBe(RegimeLabelEnum.TRANSITIONING);
        });

        it('returns TRANSITIONING when ADX is in the middle of the zone', () => {
            expect(computeRegimeLabel(22.5, 30, 10)).toBe(RegimeLabelEnum.TRANSITIONING);
        });

        it('returns TRANSITIONING when ADX equals the upper boundary exactly', () => {
            expect(computeRegimeLabel(ADX_TRENDING_MIN, 30, 10)).toBe(RegimeLabelEnum.TRANSITIONING);
        });

        it('does NOT return TRANSITIONING when ADX is one epsilon above the upper boundary', () => {
            expect(computeRegimeLabel(ADX_TRENDING_MIN + 0.001, 30, 10)).not.toBe(RegimeLabelEnum.TRANSITIONING);
        });
    });

    describe('trending regime (ADX > 25)', () => {
        describe('trending up', () => {
            it('returns TRENDING_UP when diPlus > diMinus and ADX is above threshold', () => {
                expect(computeRegimeLabel(30, 40, 20)).toBe(RegimeLabelEnum.TRENDING_UP);
            });

            it('returns TRENDING_UP when diPlus equals diMinus (tie goes to UP by implementation)', () => {
                // diPlus >= diMinus → TRENDING_UP; equal DIs produces TRENDING_UP.
                expect(computeRegimeLabel(30, 25, 25)).toBe(RegimeLabelEnum.TRENDING_UP);
            });
        });

        describe('trending down', () => {
            it('returns TRENDING_DOWN when diMinus > diPlus and ADX is above threshold', () => {
                expect(computeRegimeLabel(30, 10, 40)).toBe(RegimeLabelEnum.TRENDING_DOWN);
            });

            it('returns TRENDING_DOWN when diPlus is zero and diMinus is positive', () => {
                expect(computeRegimeLabel(40, 0, 30)).toBe(RegimeLabelEnum.TRENDING_DOWN);
            });
        });

        it('returns a trending label for very high ADX values', () => {
            const result = computeRegimeLabel(90, 60, 20);

            expect([RegimeLabelEnum.TRENDING_UP, RegimeLabelEnum.TRENDING_DOWN]).toContain(result);
        });
    });

    describe('boundary — ADX exactly at 25 + epsilon transitions to trending', () => {
        it('returns TRENDING_UP for ADX just above the upper boundary with diPlus > diMinus', () => {
            expect(computeRegimeLabel(ADX_TRENDING_MIN + 0.001, 30, 10)).toBe(RegimeLabelEnum.TRENDING_UP);
        });

        it('returns TRENDING_DOWN for ADX just above the upper boundary with diMinus > diPlus', () => {
            expect(computeRegimeLabel(ADX_TRENDING_MIN + 0.001, 10, 30)).toBe(RegimeLabelEnum.TRENDING_DOWN);
        });
    });
});
