import { FIVE_MINUTE_MS, MS_PER_DAY } from '../../../common/const';
import { WalkForwardSplitModeEnum } from '../../enum/WalkForwardSplitModeEnum';
import { WalkForwardPolicyException } from '../../exception/WalkForwardPolicyException';
import { IWalkForwardSplitPolicy } from '../../interface/IWalkForwardSplitPolicy';
import { WalkForwardPlanner } from '../WalkForwardPlanner';

const BARS_PER_DAY = MS_PER_DAY / FIVE_MINUTE_MS; // 288 five-minute bars per day

const buildPolicy = (overrides: Partial<IWalkForwardSplitPolicy> = {}): IWalkForwardSplitPolicy => ({
    trainBars: 60 * BARS_PER_DAY,
    validationBars: 14 * BARS_PER_DAY,
    oosBars: 14 * BARS_PER_DAY,
    stepBars: 14 * BARS_PER_DAY,
    mode: WalkForwardSplitModeEnum.ROLLING,
    ...overrides,
});

describe('WalkForwardPlanner', () => {
    describe('determinism', () => {
        it('returns the deeply-equal fold array on repeated calls with the same inputs', () => {
            const rangeFromMs = 0;
            const rangeToMs = 120 * MS_PER_DAY;
            const policy = buildPolicy();

            const first = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);
            const second = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            expect(second).toEqual(first);
        });
    });

    describe('rolling mode', () => {
        it('emits 3 folds across a 120-day range with 60/14/14/14 policy and respects the range boundary', () => {
            const rangeFromMs = 0;
            const rangeToMs = 120 * MS_PER_DAY;
            const policy = buildPolicy();

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            expect(folds).toHaveLength(3);
            expect(folds[0]).toEqual({
                foldIndex: 0,
                trainFromMs: 0,
                trainToMs: 60 * MS_PER_DAY,
                validationFromMs: 60 * MS_PER_DAY,
                validationToMs: 74 * MS_PER_DAY,
                oosFromMs: 74 * MS_PER_DAY,
                oosToMs: 88 * MS_PER_DAY,
            });
            expect(folds[2].oosToMs).toBe(116 * MS_PER_DAY);
            expect(folds[2].oosToMs).toBeLessThanOrEqual(rangeToMs);
        });

        it('advances each rolling fold by stepBars and keeps fixed window lengths', () => {
            const rangeFromMs = 0;
            const rangeToMs = 120 * MS_PER_DAY;
            const policy = buildPolicy();

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            for (let i = 1; i < folds.length; i++) {
                expect(folds[i].trainFromMs - folds[i - 1].trainFromMs).toBe(14 * MS_PER_DAY);
                expect(folds[i].trainToMs - folds[i].trainFromMs).toBe(60 * MS_PER_DAY);
                expect(folds[i].validationToMs - folds[i].validationFromMs).toBe(14 * MS_PER_DAY);
                expect(folds[i].oosToMs - folds[i].oosFromMs).toBe(14 * MS_PER_DAY);
            }
        });
    });

    describe('expanding mode', () => {
        it('pins trainFromMs to rangeFromMs across all folds and grows train monotonically', () => {
            const rangeFromMs = 1_700_000_000_000;
            const rangeToMs = rangeFromMs + 120 * MS_PER_DAY;
            const policy = buildPolicy({ mode: WalkForwardSplitModeEnum.EXPANDING });

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            expect(folds.length).toBeGreaterThan(1);

            for (const fold of folds) {
                expect(fold.trainFromMs).toBe(rangeFromMs);
            }

            for (let i = 1; i < folds.length; i++) {
                expect(folds[i].trainToMs).toBeGreaterThan(folds[i - 1].trainToMs);
            }
        });

        it('slides validation and oos forward by stepBars while train keeps the anchor', () => {
            const rangeFromMs = 0;
            const rangeToMs = 120 * MS_PER_DAY;
            const policy = buildPolicy({ mode: WalkForwardSplitModeEnum.EXPANDING });

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            expect(folds[0]).toEqual({
                foldIndex: 0,
                trainFromMs: 0,
                trainToMs: 60 * MS_PER_DAY,
                validationFromMs: 60 * MS_PER_DAY,
                validationToMs: 74 * MS_PER_DAY,
                oosFromMs: 74 * MS_PER_DAY,
                oosToMs: 88 * MS_PER_DAY,
            });
            expect(folds[1].validationFromMs - folds[0].validationFromMs).toBe(14 * MS_PER_DAY);
            expect(folds[1].oosFromMs - folds[0].oosFromMs).toBe(14 * MS_PER_DAY);
        });
    });

    describe('boundary behaviour', () => {
        it('returns an empty array when the range cannot fit even the first fold', () => {
            const rangeFromMs = 0;
            const rangeToMs = 30 * MS_PER_DAY; // 30 days < 88 days needed
            const policy = buildPolicy();

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            expect(folds).toEqual([]);
        });

        it('never emits a fold whose oosToMs exceeds rangeToMs', () => {
            const rangeFromMs = 0;
            const rangeToMs = 200 * MS_PER_DAY;
            const policy = buildPolicy();

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, policy);

            for (const fold of folds) {
                expect(fold.oosToMs).toBeLessThanOrEqual(rangeToMs);
            }
        });
    });

    describe('validation', () => {
        it.each([
            ['trainBars', { trainBars: 0 }],
            ['trainBars', { trainBars: -1 }],
            ['validationBars', { validationBars: 0 }],
            ['oosBars', { oosBars: 0 }],
            ['stepBars', { stepBars: 0 }],
        ])('throws WalkForwardPolicyException when %s is non-positive', (_label, overrides) => {
            const policy = buildPolicy(overrides);

            expect(() => WalkForwardPlanner.plan(0, 120 * MS_PER_DAY, policy)).toThrow(WalkForwardPolicyException);
        });

        it('throws when range is non-positive', () => {
            const policy = buildPolicy();

            expect(() => WalkForwardPlanner.plan(100, 100, policy)).toThrow(WalkForwardPolicyException);
            expect(() => WalkForwardPlanner.plan(100, 50, policy)).toThrow(WalkForwardPolicyException);
        });
    });

    describe('JSON round-trip', () => {
        it('serialises and parses back to a deeply-equal fold array (comparison_reports.folds-safe)', () => {
            const folds = WalkForwardPlanner.plan(0, 120 * MS_PER_DAY, buildPolicy());

            const roundTripped = JSON.parse(JSON.stringify(folds));

            expect(roundTripped).toEqual(folds);
        });
    });
});
