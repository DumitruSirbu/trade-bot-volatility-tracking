// The in-memory view of an open backtest position (ADR 0015 §5). MIRRORS the read-side
// surface of PositionEntity, but never writes to the `positions` table — the replay holds
// these in a Map keyed by symbol. Money is string at the shared boundary.
//
// Closed positions are flushed into IBacktestTradeResult; once closed, no IBacktestPosition
// row survives. This shape exists for telemetry / per-bar mark-to-market on the equity curve.
export interface IBacktestPosition {
    readonly positionId: string; // synthetic UUID minted by BacktestRunner (NOT a DB id)
    readonly symbol: string;
    readonly side: 'long' | 'short';
    readonly slot: 'A' | 'B' | 'C';
    readonly entryPriceUsdt: string;
    readonly qty: string;
    readonly entryNotionalUsdt: string;
    readonly leverage: string;
    readonly stopLossUsdt: string;
    readonly takeProfitUsdt: string;
    readonly openedAtMs: number;
    readonly timeStopAtMs: number | null;
    // Lifetime instrumentation tracked through the position's intrabar path; mirrors the
    // immutable PositionEntity columns used by M8 for live-vs-backtest comparison.
    readonly maxAdverseExcursionPct: string;
    readonly maxFavorableExcursionPct: string;
    // Funding cashflows accumulated against this position during its hold; settled into
    // realized PnL on close so the backtest matches live M6 funding behavior (ADR 0012).
    readonly accumulatedFundingUsdt: string;
}
