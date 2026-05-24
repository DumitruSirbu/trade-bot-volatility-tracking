import { DomainException } from '../../common/exception/DomainException';

// Thrown by `PositionService.adjustQty` when the requested qty is not a legal
// Decimal value (NaN, non-finite, or negative). Distinct from
// PositionNotFoundException so recovery paths can react differently. Stable
// `code` so the global filter (and downstream alerting) can branch without
// parsing the message. R1.3.3 mechanical move from PositionService.ts.
export class IllegalQtyAdjustmentException extends DomainException {
    constructor(
        readonly positionId: number,
        readonly requestedQty: string,
    ) {
        super('POSITION_ILLEGAL_QTY_ADJUSTMENT', `Illegal qty adjustment for positionId=${positionId}: requested=${requestedQty}`);
    }
}
