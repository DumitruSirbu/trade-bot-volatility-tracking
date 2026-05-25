export interface IPerformanceByVersionView {
    strategyVersionId: string;
    label: string;
    status: string;
    windowDays: number;
    tradeCount: number;
    winRate: string | null;
    netPnlUsd: string;
    maxDrawdownUsd: string | null;
    sharpe: string | null;
    sortino: string | null;
    expectancyPerUnitRisk: string | null;
}
