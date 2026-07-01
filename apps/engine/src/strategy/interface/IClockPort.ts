// The rebalance scheduler's injectable clock seam (ADR 0048 §2.2). Wraps Date.now() in
// production and is a controllable fake in tests, so the "no wall-clock outside an injectable
// seam" discipline holds and rebalance timing is deterministically testable. The emitted nowMs
// then flows through UNIVERSE_REBALANCE_DUE_EVENT into the pure ranking core (ADR 0047).
export interface IClockPort {
    nowMs(): number;
}

export const CLOCK_PORT = 'CLOCK_PORT';
