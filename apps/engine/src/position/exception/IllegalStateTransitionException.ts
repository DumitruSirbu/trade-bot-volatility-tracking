import { PositionStateEnum } from '@bot/shared';

import { DomainException } from '../../common/exception/DomainException';

// Thrown by PositionService.transition when the requested move is not in the
// ADR 0009 §3 legal-transition graph. Stable `code` so the global filter (and
// downstream alerting) can branch without parsing the message.
export class IllegalStateTransitionException extends DomainException {
    constructor(
        readonly positionId: number,
        readonly fromState: PositionStateEnum,
        readonly toState: PositionStateEnum,
    ) {
        super('POSITION_ILLEGAL_STATE_TRANSITION', `Illegal position state transition for positionId=${positionId}: ${fromState} -> ${toState}`);
    }
}
