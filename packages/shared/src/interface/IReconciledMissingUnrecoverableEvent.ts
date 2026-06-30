export interface IReconciledMissingUnrecoverableEvent {
    readonly positionId: string;
    readonly symbol: string;
    readonly side: 'buy' | 'sell';
    readonly dbQty: string;
    readonly reason: 'no_fills_found' | 'fetch_failed';
    readonly detectedAtMs: number;
}
