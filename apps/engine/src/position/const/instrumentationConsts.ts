// ADR 0013 §4 — `PositionInstrumentor` periodic flush cadence. 10 seconds is
// the locked default: any individual position can be "out of date" in the DB
// by up to 10s, but the values are analytic, not trading-critical. Live read
// API consumers (M9 dashboard) read the in-memory accumulator via
// `getLifeStats` for subsecond freshness. R1.3.3 mechanical move.
export const INSTRUMENTATION_FLUSH_INTERVAL_MS = 10_000;
