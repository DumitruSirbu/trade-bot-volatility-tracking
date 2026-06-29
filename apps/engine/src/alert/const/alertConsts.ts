// M9 R1 #5 — module-level alert constants extracted out of
// `AlertRateLimiter.ts` and `TelegramAlertSink.ts` per code-conventions
// §Constants Placement.

// Rate-limiter windows (ADR 0024 §2.4). Sliding-window ceiling + per-symbol
// coalesce window.
export const ALERT_GLOBAL_CEILING_PER_MIN = 30;
export const ALERT_GLOBAL_WINDOW_MS = 60_000;
export const ALERT_COALESCE_WINDOW_MS = 10_000;

// Telegram sink wire-level constants. The host is hard-coded — `api.telegram.org`
// is the only endpoint we speak to (write-only credential).
export const TELEGRAM_API_HOST = 'https://api.telegram.org';
export const HTTP_TIMEOUT_MS = 5_000;
export const HTTP_OK_STATUS = 200;
export const HTTP_TOO_MANY = 429;

// REST route fragments for the admin alert-probe surface. Pinned here so the
// controller + integration tests import the same literals.
export const ALERT_BASE_PATH = 'v1/control';
export const TEST_ALERT_PATH = 'test-alert';
