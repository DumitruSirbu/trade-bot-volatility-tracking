export interface IDailyPerformanceRow {
    readonly strategyVersionId: string;
    readonly label: string;
    /** True when this row matches `ACTIVE_STRATEGY_VERSION_ID` (the live trade path). */
    readonly isLive: boolean;
    readonly date: string;
    readonly trades: number;
    readonly winCount: number;
    readonly winRate: string | null;
    readonly dayPnlUsd: string;
    readonly cumulativePnlUsd: string;
}
