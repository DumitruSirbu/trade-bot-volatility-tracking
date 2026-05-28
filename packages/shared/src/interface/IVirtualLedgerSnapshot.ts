// M11a W0.6: Virtual ledger state snapshot (per ADR 0029 §2.1.2).
// Stamped into shadow_decisions.virtual_slot_state_snapshot (jsonb) at the moment the gate was evaluated.
// Used by the M7 fill simulator to decide whether a position was routed through the ledger gates.
// Money fields (entryPrice, stopLoss, takeProfit) are strings (decimal-as-string).
export interface IVirtualLedgerSnapshot {
    readonly riskDayUtcDate: string; // UTC date string (YYYY-MM-DD) of the risk day when snapshot was taken
    readonly openPositions: ReadonlyArray<IVirtualOpenPosition>;
    readonly haltedUntilRiskDayUtcDate: string | null; // null if not halted; set when halt_after_consecutive_losses fires
    readonly lastEventIdProcessed: string; // idempotency cursor
}

// Open position within a virtual ledger.
// Matches the shape of a position that would be recorded in the virtual ledger's live state.
export interface IVirtualOpenPosition {
    readonly symbol: string;
    readonly side: string; // PositionSideEnum value; kept as string to avoid circular import
    readonly openedAtMs: number;
    readonly openedAtEventId: string;
    readonly entryPrice: string; // decimal
    readonly qty: string; // decimal quantity
    readonly stopLoss: string; // decimal; SL price target
    readonly takeProfit: string; // decimal; TP price target
    readonly virtualOrderId: string; // unique identifier for this simulated position
}

// Closed position log entry (only enough state to count consecutive losses and trades-per-day).
export interface IVirtualClosedTradeLogEntry {
    readonly symbol: string;
    readonly side: string;
    readonly riskDayUtcDate: string; // the risk day on which it closed
    readonly closeReason: 'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | 'reverse_signal';
    readonly realizedPnl: string; // decimal; sign indicates profit (+) or loss (-)
    readonly closedAtMs: number;
    readonly closedAtEventId: string;
}
