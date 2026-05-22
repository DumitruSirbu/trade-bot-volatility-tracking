// Per-symbol empirical distribution stats of VWAP deviation (M1 "empirical band
// calibration"). σ is treated as a normalized distance, NOT a probability — bands
// are calibrated by realized false-positive rate, not Gaussian intuition. Tracks
// MAD-style robust spread plus rough percentiles accumulated over closed bars.
export interface IDeviationStats {
    symbol: string;
    sampleCount: number;
    // False until enough samples (CALIBRATION_MIN_SAMPLES) have accumulated; until
    // then the percentiles below are not statistically trustworthy.
    isTrustworthy: boolean;
    medianAbsDeviationPct: number;
    p90AbsDeviationPct: number;
    p99AbsDeviationPct: number;
}
