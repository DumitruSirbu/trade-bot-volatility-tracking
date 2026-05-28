/**
 * Minimal market snapshot for fill-simulator input.
 * Shared by both HistoricalFillAdapter (M7 backtest) and StreamingFillAdapter (PAPER).
 *
 * This shape must be invariant across both adapters so they can feed the same
 * FillSimulatorCore and produce numerically equivalent fills for the same intent.
 */
export interface IFillSnapshot {
    readonly bid: string; // decimal, last known bid
    readonly ask: string; // decimal, last known ask
    readonly last: string; // decimal, last trade price
    readonly mark: string; // decimal, mark price at decision time
    readonly high: string; // decimal, bar's high (for intra-bar evaluations)
    readonly low: string; // decimal, bar's low (for intra-bar evaluations)
    readonly ts: number; // timestamp in ms at which snapshot is valid
}
