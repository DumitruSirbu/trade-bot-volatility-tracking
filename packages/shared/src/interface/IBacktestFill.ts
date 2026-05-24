// One simulated fill produced by the backtest fill simulator (ADR 0015 §6). Money is
// transported as string at the shared boundary; the engine parses to MoneyValue at use.
// A fill is INTRABAR by definition: it carries the exact ms within the bar at which it
// occurred (entry = next-bar-open + latency; exit = first SL/TP touch on the intrabar
// path, else next-bar-open for signal closes).
export interface IBacktestFill {
    readonly eventId: string; // ties back to the originating decision
    readonly symbol: string;
    readonly side: 'long' | 'short';
    readonly intent: 'open' | 'reduce' | 'close';
    readonly priceUsdt: string; // post-slippage fill price
    readonly qty: string; // base-asset quantity
    readonly feeUsdt: string; // taker or maker per the order policy + flow_type
    readonly slippagePct: string; // signed; the adverse slippage applied
    readonly tsMs: number; // exact intrabar fill timestamp (next-bar-open + latency for entries)
    // True iff the order was modelled as a limit and never filled within its cancel timeout
    // (ADR 0015 §6 — Missed-fill model). When true, qty/feeUsdt are zero and this row exists
    // only so the report can compute fill-rate stats; it does not contribute to PnL.
    readonly missed: boolean;
    // True iff depth-aware slippage was applied (a book_snapshots row was available for the
    // trigger window); when false, the tier-floor model was used and fidelity is reduced.
    // Surfaced into IBacktestReport.lowFidelityTradeCount.
    readonly depthAware: boolean;
}
