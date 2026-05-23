// The order-submit state machine (ADR 0006 §2). Engine-internal — used to drive the timeout-
// recovery protocol (§3) and the attemptN-increment rules (§4). The dashboard reads the
// persisted transactions row, not these states.
export enum SubmitStateEnum {
    PLANNED = 'planned',
    SUBMITTING = 'submitting',
    OPEN = 'open',
    PARTIAL = 'partial',
    FILLED = 'filled',
    CANCELLED = 'cancelled',
    REJECTED = 'rejected',
    UNKNOWN = 'unknown',
    DONE = 'done',
    ABORTED = 'aborted',
    RECONCILE_REQUIRED = 'reconcile_required',
}
