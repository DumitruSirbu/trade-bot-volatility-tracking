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

// M10 R1 #3 (Security HIGH) — hard timeout on the login-audit insert. ADR
// 0027 §2.5 declares audit best-effort; under a slow DB the rate-limit
// window would advance while the controller waited, letting an attacker
// amplify their effective probe rate by pinning the connection pool. The
// timeout caps that latency at the repository boundary; on timeout the
// repository logs and returns null so the controller continues to mint /
// reject as if the audit had succeeded. 500ms comfortably covers a healthy
// insert (~ single-digit ms) and is small enough to keep login latency well
// under the per-IP rate-limit window granularity (10s).
export const LOGIN_AUDIT_TIMEOUT_MS = 500;
