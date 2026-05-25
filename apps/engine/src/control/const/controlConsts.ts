// M9 R1 #5 — module-level constants extracted out of `HaltController.ts` and
// `repository/ControlAuditRepository.ts` per code-conventions §Constants
// Placement. `HALT_REASON_MAX_LEN` was previously duplicated (controller +
// repository); the deduped definition lives here so a single bump propagates
// to both layers.

// REST route fragments for the kill-switch surface (ADR 0021 §2.1). Pinned
// here so the controller + integration tests import the same literals.
export const HALT_BASE_PATH = 'v1/control';
export const HALT_PATH = 'halt';
export const RESUME_PATH = 'resume';
export const HISTORY_PATH = 'halt/history';

// Maximum operator-supplied `reason` length (controller validation +
// repository truncation guard). 256 chars fits comfortably in a `text` column
// and stays under any reasonable Telegram alert body budget.
export const HALT_REASON_MAX_LEN = 256;

// `GET /v1/control/halt/history` pagination caps (ADR 0021 §2.1).
export const HALT_HISTORY_PAGE_SIZE_DEFAULT = 50;
export const HALT_HISTORY_PAGE_SIZE_MAX = 200;
