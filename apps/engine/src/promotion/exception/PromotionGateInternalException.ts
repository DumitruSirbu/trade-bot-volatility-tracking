import { DomainException } from '../../common/exception';

// Raised by PromotionGateService for unexpected internal states the gate cannot
// evaluate: candidate / baseline row missing, comparison report row missing,
// artefact path outside the configured root (see ArtefactPathOutsideRootException
// — thrown separately so security audits can grep for the path-containment
// failure mode distinctly).
export class PromotionGateInternalException extends DomainException {
    constructor(message: string) {
        super('PROMOTION_GATE_INTERNAL', message);
    }
}
