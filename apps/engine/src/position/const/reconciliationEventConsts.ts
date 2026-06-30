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

// M49 (ADR 0010 §1b/§1f amendment, D3.1). Emitted when a RECONCILED_MISSING close
// finalizes with NULL realized PnL because the closing-fill recovery was
// unavailable — `fetchMyTrades` returned no matching reducing fills
// (`no_fills_found`) or the fetch threw (`fetch_failed`). A real-money close with
// null PnL must not be log-grep-only; this structured event (mirroring
// `POSITION_ADOPTION_VANISHED_EVENT`) flags the row for deferred manual backfill.
// The close is NEVER blocked — the event is emitted alongside the null-PnL finalize.
export const RECONCILED_MISSING_UNRECOVERABLE_EVENT = 'position.reconciled_missing.unrecoverable';
