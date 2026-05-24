import { DomainException } from '../../common/exception';

// Raised when a walk-forward split policy or its target range is structurally
// invalid (non-positive bars or a non-positive range). The planner is pure, so
// this is the only failure mode: bad inputs reach the boundary as a typed
// domain exception instead of a silent zero-fold result. ADR 0017 §2.1.
export class WalkForwardPolicyException extends DomainException {
    constructor(message: string) {
        super('WALK_FORWARD_POLICY_INVALID', message);
    }
}
