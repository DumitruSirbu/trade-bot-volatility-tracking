/**
 * Result of intra-bar stop/TP evaluation by FillSimulatorCore.applyIntraBarStop().
 * Returned when evaluating whether an open position's SL or TP was hit during a bar.
 */
export interface IIntraBarStopResult {
    readonly hit: 'stop_loss' | 'take_profit' | null; // which level fired, if any
    readonly hitTsMs: number | null; // timestamp in ms of the hit
    readonly hitPrice: string | null; // decimal, the price at which it hit
    readonly lowFidelity: boolean; // true if resolved from bar high/low only (no ticks)
}
