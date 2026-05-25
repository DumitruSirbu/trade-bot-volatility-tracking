// M9 W6 — event-name constants for the alert pipeline.
//
// The two RISK_* event names below are ASSUMED — M4 does not currently emit
// either as a bus event (model-divergence is encoded as RejectReasonEnum.
// MODEL_DIVERGENCE_HALT inside RiskGateService; market-stress halt is a
// boolean trip on internal counters). When the M4 owner wires the actual
// emissions, the event NAMES below are the canonical ones the alert
// pipeline subscribes to — keep them stable.

export const RISK_HALT_TRIGGERED_EVENT = 'risk.halt.triggered';
export const MODEL_DIVERGENCE_TRIGGERED_EVENT = 'risk.modelDivergence.triggered';

// De-dupe window for back-to-back risk halts on the same source. M4 may emit
// the same halt twice within a few ms during a recovery / re-check cycle; we
// coalesce inside the listener BEFORE calling HaltService (which is itself
// idempotent on the halt flag but would still write a fresh audit row).
export const RISK_HALT_DEDUP_WINDOW_MS = 1_000;
