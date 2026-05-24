import { CANDLE_5M_INTERVAL_MS } from '../../market-data/const';

// LatencyModel — pure helper that converts a signal bar's open timestamp into a simulated
// fill timestamp. The fill timestamp is anchored at the NEXT bar's open plus the configured
// signal-to-fill latency floor, which preserves the C2 look-ahead invariant: an entry born
// off a signal bar's close can never fill within that same bar in the simulator (ADR 0015
// §6). The latency floor models the realistic delay between bar-close decision and order
// placement (network + risk gate + exchange round-trip).
//
// Pure: no I/O, no clock, no global state. Determinism is the whole point — replays produce
// identical fill timestamps across runs (live-vs-backtest contract C2/C5).
export function computeFillTimestamp(signalBarOpenMs: number, latencyMs: number): number {
    const nextBarOpenMs = signalBarOpenMs + CANDLE_5M_INTERVAL_MS;

    return nextBarOpenMs + latencyMs;
}
