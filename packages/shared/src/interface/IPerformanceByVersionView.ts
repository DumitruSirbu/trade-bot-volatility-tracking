export interface IPerformanceByVersionView {
    strategyVersionId: string;
    label: string;
    /** True when this row matches `ACTIVE_STRATEGY_VERSION_ID` (the live trade path). */
    isLive: boolean;
    status: string;
    windowDays: number;
    tradeCount: number;
    winRate: string | null;
    netPnlUsd: string;
    maxDrawdownUsd: string | null;
    sharpe: string | null;
    sortino: string | null;
    expectancyPerUnitRisk: string | null;
    /**
     * Fraction of traded shadow fills that exited via `force_close` (same-bar,
     * ≈ entry price). Shadow-only; null for active versions.
     * Range: "0".."1" (decimal string). Null when no traded fills.
     */
    forceCloseFraction: string | null;
    /**
     * Fraction of shadow open decisions that were missed (no entry fill).
     * Shadow-only; null for active versions.
     * Range: "0".."1" (decimal string). Null when no open decisions.
     */
    missRate: string | null;
}
