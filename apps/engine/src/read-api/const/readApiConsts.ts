// M9 R1 #5 — module-level read-api constants extracted out of
// `controllers/PositionsController.ts` per code-conventions §Constants
// Placement.

// `GET /v1/positions/closed` cursor pagination caps (ADR 0022 §2.2). Mirrors
// the halt-history cap so all read endpoints behave identically.
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

// Fallback surfaced on the closed/detail position views when the row's
// strategy_versions_id references a version row that has been deleted
// out-of-band. Preserves a stable, non-misleading label rather than leaking
// the raw numeric id or fabricating a name.
export const UNKNOWN_STRATEGY_VERSION_NAME = 'unknown';
