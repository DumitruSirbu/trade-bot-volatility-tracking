export interface IRiskStateView {
    date: string;
    realizedPnlDay: string;
    openExposure: string;
    tradesCount: number;
    isHalted: boolean;
    haltReason: string | null;
    lossWindowsState: Record<string, string>;
}
