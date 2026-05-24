import { PositionStateEnum } from '@bot/shared';

import { DomainException } from '../../common/exception/DomainException';

// Thrown when a caller passes a close payload for a non-CLOSED target state.
// Defensive contract: close fields belong to the close transition only.
// R1.3.3 mechanical move from PositionService.ts.
export class IllegalClosePayloadException extends DomainException {
    constructor(
        readonly positionId: number,
        readonly targetState: PositionStateEnum,
    ) {
        super('POSITION_ILLEGAL_CLOSE_PAYLOAD', `Close payload is only legal on transitions to CLOSED (positionId=${positionId}, targetState=${targetState})`);
    }
}
