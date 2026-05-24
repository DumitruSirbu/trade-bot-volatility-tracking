// Event names for the @nestjs/event-emitter bus. String literals for event
// names live here (never inline) so emitters and handlers cannot drift apart.
export const HEALTH_PING_EVENT = 'common.health.ping';

// Market-data events. Emitted by MarketDataModule on the @nestjs/event-emitter
// bus; consumed by strategy/risk/persistence in later milestones.
export const PRICE_UPDATE_EVENT = 'marketData.price.update';
export const VOLATILITY_DETECTED_EVENT = 'marketData.volatility.detected';

// Universe-membership transitions (M2 persists these to universe_membership).
export const UNIVERSE_SYMBOL_ENTERED_EVENT = 'marketData.universe.symbolEntered';
export const UNIVERSE_SYMBOL_LEFT_EVENT = 'marketData.universe.symbolLeft';

// M2 persistence events (ADR 0002 §4). Emitted by MarketData where the value is already
// computed; consumed by the passive MarketDataPersistenceListener which upserts via
// repositories (idempotent on each table's UNIQUE constraint).
export const CANDLE_CLOSED_EVENT = 'marketData.candle.closed';
export const TICK_AGGREGATE_EVENT = 'marketData.tick.aggregate';
export const OPEN_INTEREST_SAMPLED_EVENT = 'marketData.openInterest.sampled';
export const FUNDING_RATE_OBSERVED_EVENT = 'marketData.fundingRate.observed';
export const INSTRUMENT_REFRESHED_EVENT = 'marketData.instrument.refreshed';
export const UNIVERSE_SYMBOL_TIER_CHANGED_EVENT = 'marketData.universe.tierChanged';

// Risk-gate approval seam (ADR 0004 §1). On APPROVAL the orchestrator emits this carrying the
// approved order intent + sizing + slot + reservation handle. M5 subscribes and submits to the
// exchange — M4 itself never calls the exchange API.
export const ORDER_INTENT_APPROVED_EVENT = 'risk.orderIntent.approved';

// Risk-gate seams M5 emits back to the gate so reservations release / partial-confirm against
// the actual fill (ADR 0007 §5 + ADR 0006 §3). Engine-internal; the orchestrator hooks them
// in M5/M6 to drive `confirmReservation` / `releaseReservation` on the ledger.
export const ORDER_INTENT_EXPIRED_EVENT = 'risk.orderIntent.expired';
export const ORDER_INTENT_FAILED_EVENT = 'risk.orderIntent.failed';
export const ORDER_INTENT_UNKNOWN_EVENT = 'risk.orderIntent.unknown';

// M6 R1.2.3 (ADR 0012 §5c). Emitted by ExecutionService.applyReduceFillToPosition
// when exchange-reported `fillSummary.filledQty` exceeds the local position qty.
// Architect decision: keep the clamp (position arithmetic stays consistent) AND
// emit a dedicated drift event so M9 alerting + M8 analytics can isolate
// "exchange filled more than we asked for" — a distinct signal from the generic
// ORDER_INTENT_UNKNOWN_EVENT drift. Payload: IExchangeOverfillDriftEvent from
// `@bot/shared`.
export const EXCHANGE_OVERFILL_DRIFT_EVENT = 'execution.exchange.overfillDrift';

// Execution lifecycle (ADR 0008 §3). On a protective-attach failure, ExecutionService falls
// back to local-only protection and emits this; M6's local protective monitor (next milestone)
// subscribes. M5 only emits + logs — the monitor itself ships in M6.
export const ORDER_PROTECTIVE_FALLBACK_EVENT = 'execution.protective.fallback';
export const POSITION_OPENED_EVENT = 'execution.position.opened';
export const POSITION_CLOSED_EVENT = 'execution.position.closed';

// Emitted in LIVE mode when the zero-fill audit-row insert fails — the audit trail is a
// survival-class invariant in live operation, so a failure escalates to error-level + a
// dedicated event so an operator alert (M9) can fire. Dry-run keeps warn-level only.
export const ORDER_AUDIT_PERSIST_FAILED_EVENT = 'execution.audit.persistFailed';

// Classified failure reasons for ORDER_AUDIT_PERSIST_FAILED_EVENT payloads (round-4 #4).
// Raw error descriptions stay in logger.error only; the wire payload exposes only this
// closed enum so downstream alerting (M9) can branch without parsing prose.
export enum AuditFailureReasonEnum {
    DB_UNIQUE_VIOLATION = 'db_unique_violation',
    DB_UNAVAILABLE = 'db_unavailable',
    UNKNOWN = 'unknown',
}
