export interface IDailyPerformanceRow {
    readonly strategyVersionId: string;
    readonly label: string;
    readonly date: string;
    readonly trades: number;
    readonly winCount: number;
    readonly winRate: string | null;
    readonly dayPnlUsd: string;
    readonly cumulativePnlUsd: string;
}
