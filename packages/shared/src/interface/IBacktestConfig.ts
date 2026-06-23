// The replay job description (ADR 0015 §3). All fields are primitive/string so this
// shape is safe to cross the shared boundary (no MoneyValue, no engine-internal types).
// The BacktestRunner converts string-money fields into MoneyValue at the boundary, the
// same way live config flows through AppConfigService.
//
// `dateRange` is interpreted in UTC and inclusive of `fromUtcDate`, exclusive of `toUtcDate`,
// matching how `universe_membership` rows are queried at point-in-time.
export interface IBacktestConfig {
    readonly strategyVersionId: number; // strategy_versions.id (active version under test)
    readonly fromUtcDate: string; // YYYY-MM-DD inclusive
    readonly toUtcDate: string; // YYYY-MM-DD exclusive
    readonly allocatedCapitalUsdt: string; // string-money; converted to MoneyValue at boundary
    readonly latencyMs: number; // signal-to-fill latency floor; >=0
    // When true, the depth-aware slippage extension is permitted to engage on bars where a
    // book_snapshots row exists for the symbol. When false, ONLY the tier-floor slippage
    // model is used. M7 default = true; ADR 0015 §6.
    readonly enableDepthAwareSlippage: boolean;
    // When true, the intrabar stop/TP simulator reads tick_aggregates for the bar to decide
    // whether SL/TP was hit within-bar; when false, it falls back to bar-extreme heuristics.
    // M7 default = true; ADR 0015 §8.
    readonly enableIntrabarStopSimulation: boolean;
    // Analysis-only override for the strategy's `time_stop_minutes` param. When set (>0), the
    // backtest runner replaces params.time_stop_minutes with this value for the run, leaving the
    // strategy_versions row untouched. Used to sweep the time-stop horizon (15/30/45/60) and
    // measure its effect on exit-mix and expectancy without mutating the live version row.
    // Undefined = use the version's configured time_stop_minutes unchanged.
    readonly timeStopMinutesOverride?: number;
    // Analysis-only override that re-derives the strategy's stop so the take-profit:stop-loss
    // distance ratio equals this value for the run (stop distance = TP distance / targetTpSlRatio).
    // The take-profit is left unchanged; position size is then re-derived by the risk gate from the
    // new stop distance (realistic risk-based sizing — a tighter stop yields a larger position).
    // Used to sweep reward:risk geometry without mutating the strategy code or the strategy_versions
    // row. Undefined = use the strategy's own stop placement unchanged. Must be > 0 when set.
    readonly targetTpSlRatioOverride?: number;
    // Opaque, deterministic seed echoed onto IBacktestReport (no RNG is used in the replay
    // itself — strategies and the gate stay pure — but tests may pin a config-hash here).
    readonly runLabel: string;
}
