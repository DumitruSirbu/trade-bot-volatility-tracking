import { DomainException } from '../../common/exception/DomainException';

// Thrown by PositionService.transition when the positionId does not resolve to
// a row. Distinct from IllegalStateTransitionException so reconciliation /
// recovery paths can react differently (missing row → drift-case escalation,
// not a state-machine bug).
export class PositionNotFoundException extends DomainException {
    constructor(readonly positionId: number) {
        super('POSITION_NOT_FOUND', `Position not found: positionId=${positionId}`);
    }
}
