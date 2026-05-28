// M11a W0.4: Reconciliation drift event for EXCHANGE_NOT_IN_DB case.
// Cited by M6 W4b but never elevated to shared package. Used by soak runbook
// for abort-threshold logic and by M4 reconciliation abort triggers.
// Has the same envelope as other drift-detected events.
export interface IExchangeNotInDbDriftEvent {
    readonly positionId: null; // EXCHANGE_NOT_IN_DB positions have no local DB entry
    readonly symbol: string;
    readonly side: string; // PositionSideEnum value; kept as string to avoid circular import
    readonly driftCase: 'exchange_not_in_db';
    readonly dbQty: null; // No DB qty for new exchange position
    readonly exchangeQty: string; // decimal quantity on exchange
    readonly detectedAtMs: number;
}
