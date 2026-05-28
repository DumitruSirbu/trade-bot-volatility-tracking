/**
 * Core fill-simulator output from FillSimulatorCore functions.
 * This is the internal representation used by both adapters.
 * It extends the ISimulatedFill surface with additional fields needed during replay/streaming.
 */
export interface ISimulatedFillCore {
    readonly filled: boolean; // true if the order filled (false = missed)
    readonly fillPrice: string; // decimal, the price at which it filled (zero if missed)
    readonly qty: string; // decimal, filled quantity (zero if missed)
    readonly feeUsdt: string; // decimal, fee (zero if missed)
    readonly slippagePct: string; // decimal, the slippage applied (signed, e.g. "0.15" for 15 bps)
    readonly missedReason: string | null; // e.g. 'timeout', null if filled
    readonly lowFidelity: boolean; // true if filled without tick-level confirmation
    readonly tsMs: number; // timestamp of the fill
}
