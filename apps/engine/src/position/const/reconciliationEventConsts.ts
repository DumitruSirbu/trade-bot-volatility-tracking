// Engine-internal event names produced by `ReconciliationService` (M6 W4a/W4b).
// Co-located in `const/` per the conventions; no inline string literals for
// event names. R1.3.3 mechanical move out of the service file.

export const RECONCILIATION_DRIFT_DETECTED_EVENT = 'reconciliation.drift.detected';

export const RECONCILIATION_RESOLVED_EVENT = 'reconciliation.resolved';

export const POSITION_ADOPTED_EVENT = 'position.adopted';

// M6 R1.1.2 (ADR 0010 §1b revised). Emitted when case-(b) handler discovers a
// `MANUAL_ADOPTED_UNMANAGED` position no longer on the exchange. The bot did
// not place the row so it cannot transition it (the §3 graph from
// MANUAL_ADOPTED_UNMANAGED → CLOSED is only via operator-issued flatten);
// instead we alert the operator and leave the row in place.
export const POSITION_ADOPTION_VANISHED_EVENT = 'position.adoption.vanished';
