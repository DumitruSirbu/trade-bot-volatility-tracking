// M11a W0.6: Virtual position ledger interface for shadow-mode counterfactual evaluation.
// Per ADR 0029 §2.1, each shadow version maintains its own ledger instance honouring the same
// restricted-profile gates (max_open_positions: 1, halt_after_consecutive_losses: 2, max_trades_per_day: 3, etc.).
// The ledger is in-memory per run; on restart it is rebuilt by replaying shadow_decisions rows.
// Implementation is engine W4 work; this interface is the contract.
import { IVirtualLedgerSnapshot } from './IVirtualLedgerSnapshot.js';

export interface IVirtualPositionLedger {
    // Read — pure projections, never mutate.

    /**
     * Snapshot of the ledger state at the moment of decision (before any mutation).
     * This is the shape stamped into shadow_decisions.virtual_slot_state_snapshot.
     */
    snapshotForDecision(nowMs: number): IVirtualLedgerSnapshot;

    /**
     * Check if the ledger is halted due to consecutive losses.
     */
    isHalted(nowMs: number): boolean;

    /**
     * Count open positions in the ledger.
     */
    countOpenPositions(): number;

    /**
     * Count trades opened on a given risk day.
     * riskDayUtcDate is a UTC date string (YYYY-MM-DD).
     */
    countTradesOpenedOnRiskDay(riskDayUtcDate: string): number;

    /**
     * Count consecutive losses on a given risk day.
     * A loss is a trade with realizedPnl < 0.
     */
    countConsecutiveLossesInRiskDay(riskDayUtcDate: string): number;

    // Gate evaluation

    /**
     * Evaluate restricted-profile gates against the ledger state.
     * Returns a structured outcome the orchestrator records on the shadow_decisions row.
     */
    evaluateGates(input: IVirtualGateInput): IVirtualGateOutcome;

    // Mutate — invoked only by the orchestrator after a shadow decision has
    // been routed through the fill simulator and produced a simulated fill record.

    /**
     * Open a position in the ledger.
     * Idempotent on eventId — replay must not double-open.
     */
    tryOpen(open: IVirtualOpenInput): IVirtualMutationResult;

    /**
     * Close a position in the ledger.
     * Idempotent on eventId — replay must not double-close.
     */
    tryClose(close: IVirtualCloseInput): IVirtualMutationResult;
}

/**
 * Input to evaluateGates.
 * Captures the decision, the market context, and the restricted-profile constraints.
 */
export interface IVirtualGateInput {
    readonly eventId: string;
    readonly nowMs: number;
    readonly riskDayUtcDate: string; // UTC date string
    readonly decision: {
        readonly action: string; // SignalActionEnum value; kept as string to avoid circular import
        // Other decision fields as needed; implementation detail
    };
    readonly maxOpenPositions: number;
    readonly maxTradesPerDay: number;
    readonly haltAfterConsecutiveLosses: number;
    readonly requireExhaustionConfirmation: boolean;
    readonly skipMarketStress: boolean;
    readonly marginMode: 'isolated' | 'cross';
}

/**
 * Output from evaluateGates.
 * Describes whether the gate allowed the decision to proceed.
 */
export interface IVirtualGateOutcome {
    readonly allowed: boolean;
    readonly rejectReason?: string; // If allowed=false, describes why (e.g., 'max_open_positions_reached', 'halted')
}

/**
 * Input to tryOpen.
 * Captures the decision and the fill details from the simulator.
 */
export interface IVirtualOpenInput {
    readonly eventId: string;
    readonly nowMs: number;
    readonly riskDayUtcDate: string;
    readonly symbol: string;
    readonly side: string;
    readonly entryPrice: string; // decimal
    readonly qty: string; // decimal
    readonly stopLoss: string; // decimal; SL price target
    readonly takeProfit: string; // decimal; TP price target
    readonly virtualOrderId: string;
}

/**
 * Input to tryClose.
 * Captures the close event and reasoning (SL hit, TP hit, force-close, reverse-signal).
 */
export interface IVirtualCloseInput {
    readonly eventId: string;
    readonly nowMs: number;
    readonly riskDayUtcDate: string;
    readonly virtualOrderId: string; // references the open position
    readonly exitPrice: string; // decimal; price at which the position is closed
    readonly closeReason: 'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | 'reverse_signal';
    readonly realizedPnl: string; // decimal; entry-to-exit PnL before fees
}

/**
 * Output from tryOpen / tryClose.
 * Describes the mutation outcome.
 */
export interface IVirtualMutationResult {
    readonly success: boolean;
    readonly reason?: string; // If success=false, describes why
}
