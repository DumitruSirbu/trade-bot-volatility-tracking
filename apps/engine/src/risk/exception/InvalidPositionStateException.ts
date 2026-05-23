import { DomainException } from '../../common/exception';

// Raised when a position the risk gate reads is internally inconsistent — e.g. a CLOSED
// position with a null closed_at (cooldown/consecutive-loss windows key off the close time;
// silently coercing it to 0 would corrupt those windows). Fail loud rather than mis-account.
export class InvalidPositionStateException extends DomainException {
    constructor(message: string, cause?: unknown) {
        super('RISK_INVALID_POSITION_STATE', message, cause);
    }
}
