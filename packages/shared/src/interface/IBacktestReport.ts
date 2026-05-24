import { IBacktestTradeResult } from './IBacktestTradeResult.js';

// Per-day equity-curve point (ADR 0015 §9). Used as the input to Sharpe/Sortino and
// max-drawdown computations. `equityUsdt` is mark-to-market on closed PnL only; unrealized
// PnL on still-open positions at end-of-day is added with the last-known mark price.
export interface IBacktestEquityPoint {
    readonly utcDate: string; // YYYY-MM-DD
    readonly equityUsdt: string;
    readonly dailyReturnPct: string;
}

// Per-regime / per-flow / per-symbol breakdown (ADR 0015 §9). Lets the M8 comparator
// answer "where does the edge live" without re-aggregating the trade stream.
export interface IBacktestBreakdownRow {
    readonly key: string; // e.g. 'regime:trend', 'flow:liquidation_cascade', 'symbol:BTCUSDT'
    readonly tradeCount: number;
    readonly winRatePct: string;
    readonly netPnlUsdt: string;
    readonly profitFactor: string; // gross-win / gross-loss; "Infinity" string allowed
}

// The final, persisted-to-disk-as-JSON output of `run_backtest(version, dateRange)`. All
// money is string at the shared boundary. Definitions are pinned per ADR 0015 §9:
//   - Net PnL = gross - fees - |funding paid| - slippage cost
//   - Max drawdown = peak-to-trough on the daily mark-to-market equity curve, as %
//   - Sharpe / Sortino: daily-resampled equity returns, annualized with sqrt(365)
//   - Sortino MAR target = 0
export interface IBacktestReport {
    readonly runLabel: string;
    readonly strategyVersionId: number;
    readonly strategyName: string;
    readonly strategyVersion: number;
    readonly fromUtcDate: string;
    readonly toUtcDate: string;
    readonly tradeCount: number;
    readonly winCount: number;
    readonly lossCount: number;
    readonly winRatePct: string;
    readonly grossPnlUsdt: string;
    readonly feesUsdt: string;
    readonly fundingUsdt: string;
    readonly slippageCostUsdt: string;
    readonly netPnlUsdt: string;
    readonly returnPct: string;
    readonly profitFactor: string;
    readonly avgHoldMs: number;
    readonly maxDrawdownPct: string;
    readonly maxDrawdownDurationDays: number;
    readonly sharpeAnnualized: string;
    readonly sortinoAnnualized: string;
    readonly skippedTriggerCount: number; // strategy SKIP outcomes
    readonly rejectedByGateCount: number; // risk-gate REJECT outcomes
    readonly missedLimitFillCount: number; // limit orders that timed out unfilled
    readonly lowFidelityTradeCount: number; // trades where any fill lacked book_snapshots depth data
    readonly equityCurve: readonly IBacktestEquityPoint[];
    readonly perRegime: readonly IBacktestBreakdownRow[];
    readonly perFlowType: readonly IBacktestBreakdownRow[];
    readonly perSymbol: readonly IBacktestBreakdownRow[];
    readonly trades: readonly IBacktestTradeResult[]; // per-trade detail for downstream M8 comparison
}
