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
    // Opaque, deterministic seed echoed onto IBacktestReport (no RNG is used in the replay
    // itself — strategies and the gate stay pure — but tests may pin a config-hash here).
    readonly runLabel: string;
}
