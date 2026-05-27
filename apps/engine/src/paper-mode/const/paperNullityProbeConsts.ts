// Consecutive transport-failure threshold before PaperExchangeNullityProbe
// transitions from "log + continue" to "exponential backoff" (ADR 0032 §D13).
// Below threshold: every failure logged but does not affect cadence. At
// threshold + 1: WARN + enter backoff window so a Binance outage cannot halt
// the soak.
//
// M11a R4 Item 5: relocated from PaperExchangeNullityProbe.ts.
export const TRANSPORT_FAILURE_THRESHOLD = 5;

// Exponential backoff multiplier applied per consecutive failure beyond the
// transport threshold. Cap is sourced from
// `AppConfigService.paperNullityProbeBackoffMaxMs`.
export const BACKOFF_INITIAL_MULTIPLIER = 2;
