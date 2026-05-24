import { PositionStateEnum } from '@bot/shared';

import { DomainException } from '../../common/exception/DomainException';

// Thrown when a caller passes an adoption-ack payload for a non-OPEN target
// state, or from a non-MANUAL_ADOPTED_UNMANAGED source state. Defensive
// contract enforced by `PositionService.transition` per ADR 0014 §4a revised.
// R1.3.3 mechanical move from PositionService.ts.
export class IllegalAdoptionAckPayloadException extends DomainException {
    constructor(
        readonly positionId: number,
        readonly fromState: PositionStateEnum,
        readonly toState: PositionStateEnum,
    ) {
        super(
            'POSITION_ILLEGAL_ADOPTION_ACK_PAYLOAD',
            `Adoption-ack payload is only legal on MANUAL_ADOPTED_UNMANAGED → OPEN transitions (positionId=${positionId}, ${fromState} -> ${toState})`,
        );
    }
}
