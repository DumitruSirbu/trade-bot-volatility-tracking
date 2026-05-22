import { Injectable } from '@nestjs/common';

import { CALIBRATION_MIN_SAMPLES, CALIBRATION_SAMPLE_CAP } from '../const';
import { IDeviationStats } from '../interface';

// Empirical band calibration (M1 task). Accumulates per-symbol abs VWAP-deviation
// samples and exposes robust distribution stats (median ≈ MAD center, p90, p99).
// σ is treated as a NORMALIZED DISTANCE, not a probability — bands are calibrated
// by realized false-positive rate, not Gaussian intuition. M7 consumes these stats
// to tune trigger params; M1 only accumulates and exposes them.
@Injectable()
export class DeviationCalibrationService {
    private readonly samplesBySymbol = new Map<string, number[]>();

    // Ring buffer: one sample per closed bar, capped at CALIBRATION_SAMPLE_CAP so the
    // accumulator can never grow unbounded in a 24/7 process (oldest dropped first).
    record(symbol: string, deviationPct: number): void {
        const samples = this.samplesBySymbol.get(symbol) ?? [];

        samples.push(Math.abs(deviationPct));

        if (samples.length > CALIBRATION_SAMPLE_CAP) {
            samples.shift();
        }

        this.samplesBySymbol.set(symbol, samples);
    }

    stats(symbol: string): IDeviationStats {
        const samples = [...(this.samplesBySymbol.get(symbol) ?? [])].sort((left, right) => left - right);

        return {
            symbol,
            sampleCount: samples.length,
            isTrustworthy: samples.length >= CALIBRATION_MIN_SAMPLES,
            medianAbsDeviationPct: this.percentile(samples, 0.5),
            p90AbsDeviationPct: this.percentile(samples, 0.9),
            p99AbsDeviationPct: this.percentile(samples, 0.99),
        };
    }

    private percentile(sortedSamples: number[], fraction: number): number {
        if (sortedSamples.length === 0) {
            return 0;
        }

        const index = Math.min(sortedSamples.length - 1, Math.floor(fraction * sortedSamples.length));

        return sortedSamples[index];
    }
}
