// A round-trip (open → close) outcome produced by the replay (ADR 0015 §9). The
// metrics computer consumes a stream of these; the report aggregates them. Money is
// string at the shared boundary; net PnL is gross minus fees minus funding minus
// slippage cost — the same identity live M6 uses (ADR 0012).
export interface IBacktestTradeResult {
    readonly eventId: string;
    readonly symbol: string;
    readonly strategyVersionId: number;
    readonly side: 'long' | 'short';
    readonly slot: 'A' | 'B' | 'C';
    readonly flowType: string; // FlowTypeEnum as string at the shared boundary
    readonly regimeAtEntry: string; // ADX-derived regime label as string
    readonly coinTier: 'tier1' | 'tier2' | 'tier3';
    readonly entryPriceUsdt: string;
    readonly exitPriceUsdt: string;
    readonly qty: string;
    readonly grossPnlUsdt: string;
    readonly feesUsdt: string; // open fee + close fee
    readonly fundingUsdt: string; // signed; cashflows over the hold
    readonly slippageCostUsdt: string; // |entry_slippage_pct| + |exit_slippage_pct| applied to notional
    readonly netPnlUsdt: string; // gross - fees - |funding paid| - slippage cost (see ADR 0012)
    readonly riskBudgetSpent: string; // decimal stop-distance × qty (the ATR-sized risk budget the gate approved), ADR 0018 §2.1
    readonly returnPct: string; // netPnlUsdt / entryNotionalUsdt * 100
    readonly openedAtMs: number;
    readonly closedAtMs: number;
    readonly holdMs: number;
    readonly exitReason: 'take_profit' | 'stop_loss' | 'time_stop' | 'signal' | 'liquidation' | 'force_close';
    readonly lowFidelity: boolean; // true if EITHER fill used tier-floor only (no book_snapshots)
}
