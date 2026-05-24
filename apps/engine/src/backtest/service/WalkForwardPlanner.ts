import { FIVE_MINUTE_MS } from '../../common/const';
import { WalkForwardSplitModeEnum } from '../enum/WalkForwardSplitModeEnum';
import { WalkForwardPolicyException } from '../exception/WalkForwardPolicyException';
import { IWalkForwardFold } from '../interface/IWalkForwardFold';
import { IWalkForwardSplitPolicy } from '../interface/IWalkForwardSplitPolicy';

// Pure, deterministic walk-forward fold planner (ADR 0017 §2.1).
//
// Given a date range `[rangeFromMs, rangeToMs)` and a split policy, emits the
// ordered `IWalkForwardFold[]` the comparison driver will iterate over. The
// returned array IS the persistence shape (`comparison_reports.folds jsonb`),
// so it must JSON-round-trip without loss and the same inputs must produce the
// same outputs across processes — no clock reads, no RNG, no I/O.
//
// Bar width: every `*Bars` policy field counts the project's primary 5-minute
// candle. Multiplying by `FIVE_MINUTE_MS` (common/const/timeConsts) is the only
// translation from bars to wall-clock milliseconds; the const lives at the
// common layer so live indicators, the backtest, and this planner agree.
//
// Boundary contract: emit folds while the next fold's `oosToMs <= rangeToMs`.
// If even fold 0 does not fit, return `[]` and let the caller decide (the
// comparison driver surfaces this as "range too short for policy" without
// throwing). The opposite policy — pad or shrink the trailing fold — would
// silently misalign the OOS window against the persisted policy on re-run.
export class WalkForwardPlanner {
    static plan(rangeFromMs: number, rangeToMs: number, policy: IWalkForwardSplitPolicy): IWalkForwardFold[] {
        this.assertValid(rangeFromMs, rangeToMs, policy);

        const trainMs = policy.trainBars * FIVE_MINUTE_MS;
        const validationMs = policy.validationBars * FIVE_MINUTE_MS;
        const oosMs = policy.oosBars * FIVE_MINUTE_MS;
        const stepMs = policy.stepBars * FIVE_MINUTE_MS;

        const folds: IWalkForwardFold[] = [];
        let foldIndex = 0;

        while (true) {
            const fold = this.buildFold(foldIndex, rangeFromMs, trainMs, validationMs, oosMs, stepMs, policy.mode);

            if (fold.oosToMs > rangeToMs) {
                break;
            }

            folds.push(fold);
            foldIndex += 1;
        }

        return folds;
    }

    private static buildFold(
        foldIndex: number,
        rangeFromMs: number,
        trainMs: number,
        validationMs: number,
        oosMs: number,
        stepMs: number,
        mode: WalkForwardSplitModeEnum,
    ): IWalkForwardFold {
        const stepOffset = foldIndex * stepMs;

        if (mode === WalkForwardSplitModeEnum.EXPANDING) {
            const trainFromMs = rangeFromMs;
            const trainToMs = rangeFromMs + trainMs + stepOffset;
            const validationFromMs = trainToMs;
            const validationToMs = validationFromMs + validationMs;
            const oosFromMs = validationToMs;
            const oosToMs = oosFromMs + oosMs;

            return { foldIndex, trainFromMs, trainToMs, validationFromMs, validationToMs, oosFromMs, oosToMs };
        }

        const trainFromMs = rangeFromMs + stepOffset;
        const trainToMs = trainFromMs + trainMs;
        const validationFromMs = trainToMs;
        const validationToMs = validationFromMs + validationMs;
        const oosFromMs = validationToMs;
        const oosToMs = oosFromMs + oosMs;

        return { foldIndex, trainFromMs, trainToMs, validationFromMs, validationToMs, oosFromMs, oosToMs };
    }

    private static assertValid(rangeFromMs: number, rangeToMs: number, policy: IWalkForwardSplitPolicy): void {
        if (rangeToMs <= rangeFromMs) {
            throw new WalkForwardPolicyException(`Range must be positive: rangeFromMs=${rangeFromMs} rangeToMs=${rangeToMs}`);
        }

        if (policy.trainBars <= 0) {
            throw new WalkForwardPolicyException(`trainBars must be > 0, got ${policy.trainBars}`);
        }

        if (policy.validationBars <= 0) {
            throw new WalkForwardPolicyException(`validationBars must be > 0, got ${policy.validationBars}`);
        }

        if (policy.oosBars <= 0) {
            throw new WalkForwardPolicyException(`oosBars must be > 0, got ${policy.oosBars}`);
        }

        if (policy.stepBars <= 0) {
            throw new WalkForwardPolicyException(`stepBars must be > 0, got ${policy.stepBars}`);
        }
    }
}
