export interface IShadowPerformanceSummary {
    readonly shadowVersion: string;
    readonly strategyVersionId: string;
    readonly label: string;
    readonly windowDays: number;
    readonly tradeCount: number;
    readonly winCount: number;
    readonly winRate: string | null;
    readonly netPnlUsd: string;
    readonly forceCloseFraction: string | null;
    readonly missRate: string | null;
}
