/**
 * Adversarial tests for WalkForwardPlanner (M8 W8 QA / ADR 0017 §2.1).
 *
 * Cluster: boundary and degenerate fold ranges — the planner must be strictly
 * monotonic in folds emitted, never emit a fold whose oosToMs exceeds rangeToMs,
 * and must throw rather than silently emit nonsense on invalid policies.
 */

import { FIVE_MINUTE_MS, MS_PER_DAY } from '../../../common/const';
import { WalkForwardSplitModeEnum } from '../../enum/WalkForwardSplitModeEnum';
import { WalkForwardPolicyException } from '../../exception/WalkForwardPolicyException';
import { IWalkForwardSplitPolicy } from '../../interface/IWalkForwardSplitPolicy';
import { WalkForwardPlanner } from '../WalkForwardPlanner';

const BARS_PER_DAY = MS_PER_DAY / FIVE_MINUTE_MS; // 288

function buildRollingPolicy(overrides: Partial<IWalkForwardSplitPolicy> = {}): IWalkForwardSplitPolicy {
    return {
        trainBars: 60 * BARS_PER_DAY,
        validationBars: 14 * BARS_PER_DAY,
        oosBars: 14 * BARS_PER_DAY,
        stepBars: 14 * BARS_PER_DAY,
        mode: WalkForwardSplitModeEnum.ROLLING,
        ...overrides,
    };
}

// Total bars in one complete fold = train + validation + oos.
// Using tiny bar counts so we can drive exact ms arithmetic without large constants.
const TINY_TRAIN_BARS = 10;
const TINY_VAL_BARS = 3;
const TINY_OOS_BARS = 3;
const TINY_STEP_BARS = 3;
const TINY_FOLD_TOTAL_MS = (TINY_TRAIN_BARS + TINY_VAL_BARS + TINY_OOS_BARS) * FIVE_MINUTE_MS;

describe('WalkForwardPlanner — adversarial edges', () => {
    describe('exact-one-fold range', () => {
        it('emits exactly one fold when range exactly equals one fold total bars', () => {
            // rangeToMs is exactly fold0.oosToMs — the boundary condition.
            const rangeFromMs = 0;
            const rangeToMs = TINY_FOLD_TOTAL_MS; // foldIndex=0 oosToMs = rangeToMs exactly

            const folds = WalkForwardPlanner.plan(
                rangeFromMs,
                rangeToMs,
                buildRollingPolicy({
                    trainBars: TINY_TRAIN_BARS,
                    validationBars: TINY_VAL_BARS,
                    oosBars: TINY_OOS_BARS,
                    stepBars: TINY_STEP_BARS,
                }),
            );

            expect(folds).toHaveLength(1);
            expect(folds[0].oosToMs).toBe(rangeToMs);
            expect(folds[0].foldIndex).toBe(0);
        });

        it('emits [] when range is exactly one ms shorter than one fold total', () => {
            const rangeFromMs = 0;
            const rangeToMs = TINY_FOLD_TOTAL_MS - 1; // one ms short → fold0.oosToMs > rangeToMs

            const folds = WalkForwardPlanner.plan(
                rangeFromMs,
                rangeToMs,
                buildRollingPolicy({
                    trainBars: TINY_TRAIN_BARS,
                    validationBars: TINY_VAL_BARS,
                    oosBars: TINY_OOS_BARS,
                    stepBars: TINY_STEP_BARS,
                }),
            );

            expect(folds).toHaveLength(0);
        });
    });

    describe('sparse step (step > full fold)', () => {
        it('emits non-overlapping folds when stepBars > train+val+oos', () => {
            // step = 24 bars, fold width = 10 bars → gap of 14 bars between folds.
            // The OOS windows of adjacent folds must NOT overlap.
            const stepBars = 24; // larger than fold width (16)
            const rangeFromMs = 0;
            const rangeToMs = 200 * FIVE_MINUTE_MS;

            const folds = WalkForwardPlanner.plan(
                rangeFromMs,
                rangeToMs,
                buildRollingPolicy({
                    trainBars: TINY_TRAIN_BARS,
                    validationBars: TINY_VAL_BARS,
                    oosBars: TINY_OOS_BARS,
                    stepBars,
                }),
            );

            expect(folds.length).toBeGreaterThan(1);

            for (let i = 1; i < folds.length; i += 1) {
                // Adjacent train windows must not overlap when step > fold width.
                expect(folds[i].trainFromMs).toBeGreaterThan(folds[i - 1].oosToMs);
            }

            // No fold exceeds the range.
            for (const fold of folds) {
                expect(fold.oosToMs).toBeLessThanOrEqual(rangeToMs);
            }
        });
    });

    describe('dense step (step = 1 bar)', () => {
        it('adjacent folds share most of train but no fold extends past rangeToMs', () => {
            const rangeFromMs = 0;
            const rangeToMs = 20 * FIVE_MINUTE_MS;

            const folds = WalkForwardPlanner.plan(
                rangeFromMs,
                rangeToMs,
                buildRollingPolicy({
                    trainBars: TINY_TRAIN_BARS,
                    validationBars: TINY_VAL_BARS,
                    oosBars: TINY_OOS_BARS,
                    stepBars: 1, // one bar step → maximum overlap
                }),
            );

            expect(folds.length).toBeGreaterThan(1);

            // Each fold advances by exactly 1 bar (one FIVE_MINUTE_MS step).
            for (let i = 1; i < folds.length; i += 1) {
                expect(folds[i].trainFromMs - folds[i - 1].trainFromMs).toBe(FIVE_MINUTE_MS);
            }

            // No fold exceeds the range boundary.
            for (const fold of folds) {
                expect(fold.oosToMs).toBeLessThanOrEqual(rangeToMs);
            }
        });
    });

    describe('expanding mode — stepBars=0 guard', () => {
        it('throws WalkForwardPolicyException when stepBars is 0 regardless of mode', () => {
            // stepBars=0 is rejected by assertValid; this tests that the expanding
            // branch does NOT short-circuit the validation.
            expect(() =>
                WalkForwardPlanner.plan(
                    0,
                    200 * FIVE_MINUTE_MS,
                    buildRollingPolicy({
                        stepBars: 0,
                        mode: WalkForwardSplitModeEnum.EXPANDING,
                    }),
                ),
            ).toThrow(WalkForwardPolicyException);
        });
    });

    describe('massive range (10 years)', () => {
        it('terminates in finite time and produces a finite fold array', () => {
            const tenYearsMs = 10 * 365 * MS_PER_DAY;
            const rangeFromMs = 0;
            const rangeToMs = tenYearsMs;

            const folds = WalkForwardPlanner.plan(rangeFromMs, rangeToMs, buildRollingPolicy());

            expect(folds.length).toBeGreaterThan(0);
            expect(Number.isFinite(folds.length)).toBe(true);

            // Every fold must be internally consistent.
            for (const fold of folds) {
                expect(fold.trainToMs).toBeGreaterThan(fold.trainFromMs);
                expect(fold.validationFromMs).toBe(fold.trainToMs);
                expect(fold.oosFromMs).toBe(fold.validationToMs);
                expect(fold.oosToMs).toBeLessThanOrEqual(rangeToMs);
            }
        });
    });

    describe('validation guards', () => {
        it('throws when rangeToMs <= rangeFromMs', () => {
            expect(() =>
                WalkForwardPlanner.plan(1000, 1000, buildRollingPolicy()),
            ).toThrow(WalkForwardPolicyException);
        });

        it('throws when trainBars <= 0', () => {
            expect(() =>
                WalkForwardPlanner.plan(0, 1_000_000, buildRollingPolicy({ trainBars: 0 })),
            ).toThrow(WalkForwardPolicyException);
        });

        it('throws when oosBars <= 0', () => {
            expect(() =>
                WalkForwardPlanner.plan(0, 1_000_000, buildRollingPolicy({ oosBars: -1 })),
            ).toThrow(WalkForwardPolicyException);
        });
    });
});
