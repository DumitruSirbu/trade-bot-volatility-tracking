// M9 R1 #5 — module-level read-api constants extracted out of
// `controllers/PositionsController.ts` per code-conventions §Constants
// Placement.

// `GET /v1/positions/closed` cursor pagination caps (ADR 0022 §2.2). Mirrors
// the halt-history cap so all read endpoints behave identically.
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;
