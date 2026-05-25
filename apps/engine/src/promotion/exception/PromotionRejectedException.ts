import { DomainException } from '../../common/exception';

import { IPromotionGateOutcome } from '../interface/IPromotionGateOutcome';

// Thrown by PromotionService.promote when PromotionGateService.evaluate returns
// a decision !== 'promote'. The full outcome (including failed criteria with
// severity) is attached so the CLI / caller can render a structured rejection
// report rather than parsing the message string.
//
// There is intentionally NO `--force` override path (ADR 0019 §2.1 / §4 alt 1).
// A genuinely mis-calibrated threshold is tuned via PR with review, not via a
// flag.
export class PromotionRejectedException extends DomainException {
    constructor(readonly outcome: IPromotionGateOutcome) {
        super(
            'PROMOTION_REJECTED',
            `Promotion rejected for version ${outcome.versionId}: decision=${outcome.decision}, failedCriteria=${outcome.failedCriteria.map((failure) => failure.index).join(',')}`,
        );
    }
}
