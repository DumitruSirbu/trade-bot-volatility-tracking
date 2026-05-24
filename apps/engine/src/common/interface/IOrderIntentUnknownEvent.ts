import { SubmitStateEnum } from '../../execution/enum';

// Payload for ORDER_INTENT_UNKNOWN_EVENT (round-5 #4). Emitted by ExecutionService whenever
// a reduce-family terminal escalates to M6 reconciliation — partial fills, drift between
// local position qty and exchange-reported filled qty, or a reduce intent against a missing
// position row. M6's reconciler subscribes; `reason` lets it branch without re-deriving
// context.
//
// M6 R2.1.3 (ADR-0010 §1f step 1): `positionId` is the listener's index into the
// `positions` row that needs to move to RECONCILING. The executor knows the row id at
// emit time for the reduce-family path (it just looked it up via findOpenBySymbolAndSlot);
// the new field is engine-internal so no shared-contract change is required.
// `positionId` is `null` for the no-such-row path (reason='missing_position') and for
// OPEN/ADD escalations that never produced a row.
export interface IOrderIntentUnknownEvent {
    readonly eventId: string;
    readonly reservationId: string | null;
    readonly state: SubmitStateEnum;
    readonly reason?: 'drift' | 'missing_position' | string;
    readonly positionId?: number | null;
}
