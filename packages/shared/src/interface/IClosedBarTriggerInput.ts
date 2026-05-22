export interface IClosedBarTriggerInput {
    symbol: string;
    vwapDeviationSigma: number;  // normalized distance from the active VWAP anchor
    vwapDeviationPct: number;    // signed % deviation; sign yields the side
    volumeRatio: number;         // currentBarVolume / 20bar avg
}
