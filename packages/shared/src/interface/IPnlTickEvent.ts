export interface IPnlTickEvent {
    asOf: string;
    equityUsd: string;
    openExposureUsd: string;
    unrealizedPnlUsd: string;
}

export interface IStreamLaggedEvent {
    droppedCount: number;
    sinceMs: number;
}
