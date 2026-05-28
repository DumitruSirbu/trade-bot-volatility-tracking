/**
 * Open position state needed for intra-bar stop/TP evaluation.
 * Used by FillSimulatorCore.applyIntraBarStop() to decide if SL or TP triggers.
 */
export interface IFillPosition {
    readonly entryPrice: string; // decimal, position entry price
    readonly side: 'long' | 'short';
    readonly size: string; // decimal, open position size
    readonly stopLoss: string | null; // decimal, SL price if present
    readonly takeProfit: string | null; // decimal, TP price if present
    readonly timeStopDeadlineMs: number | null; // ms, time-stop deadline if applicable
}
