import { SubmitStateEnum } from '../../execution/enum';

// Payload for ORDER_INTENT_UNKNOWN_EVENT (round-5 #4). Emitted by ExecutionService whenever
// a reduce-family terminal escalates to M6 reconciliation — partial fills, drift between
// local position qty and exchange-reported filled qty, or a reduce intent against a missing
// position row. M6's reconciler subscribes; `reason` lets it branch without re-deriving
// context.
export interface IOrderIntentUnknownEvent {
    readonly eventId: string;
    readonly reservationId: string | null;
    readonly state: SubmitStateEnum;
    readonly reason?: 'drift' | 'missing_position' | string;
}
