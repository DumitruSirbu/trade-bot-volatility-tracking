import { DomainException } from '../../common/exception';

// Raised by ComparisonRunnerService when its inputs are structurally invalid
// (degenerate range, empty candidate set, planner returned zero folds). The
// runner is composition-only — every leaf execution path is BacktestRunner; a
// failure here is always an upstream-config issue, never an execution bug.
export class ComparisonRunnerException extends DomainException {
    constructor(message: string) {
        super('COMPARISON_RUNNER_INVALID', message);
    }
}
