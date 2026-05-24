import { DomainException } from '../../common/exception';

// Raised by PromotionService when a state-machine guard rejects the requested
// promote / reactivate transition: the candidate row is missing, in the wrong
// status (e.g. promote requires DRAFT, reactivate requires ARCHIVED), or the
// referenced comparison report does not include / endorse the version. Distinct
// from PromotionRejectedException (which carries the structured gate outcome)
// so callers can differentiate "row state is wrong" from "gate said no".
export class PromotionStateException extends DomainException {
    constructor(message: string) {
        super('PROMOTION_STATE_INVALID', message);
    }
}
