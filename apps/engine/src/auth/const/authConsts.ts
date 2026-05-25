// M9 W2 — auth-stack constants (per code-conventions §Constants Placement).

// HS256 header `{"alg":"HS256","typ":"JWT"}` base64url-encoded. Hard-coded
// because the engine only signs / verifies this one shape; comparing against
// a constant rejects alg-swap attacks (e.g. `none`, `RS256`) up-front.
export const AUTH_HS256_HEADER_B64URL = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';

// ADR 0020 §2.1: 15-minute TTL default for CLI-issued tokens. The issuer
// allows shorter TTLs but never longer than the hard cap (enforced in the
// CLI argv parser).
export const AUTH_TOKEN_DEFAULT_TTL_SEC = 15 * 60;
export const AUTH_TOKEN_MAX_TTL_SEC = 15 * 60;

// ADR 0020 §2.1: HS256 signing secret must be at least 32 bytes.
export const AUTH_MIN_SECRET_BYTES = 32;

// Bearer scheme prefix; case-insensitive per RFC 6750 but we normalise once
// at the guard boundary and compare against this lowercased form.
export const AUTH_BEARER_PREFIX = 'bearer ';

// ADR 0020 §2.3: comma-separated env var name + the failure mode for
// disallowed origins. Default-empty list in prod means "deny all" — operator
// must populate the allow-list explicitly.
export const AUTH_CORS_ALLOWLIST_ENV = 'AUTH_CORS_ALLOWLIST';

// Metadata key the `@RequiredScopes(...)` decorator stamps on handlers /
// controllers. The guard reads via Nest's Reflector.
export const REQUIRED_SCOPES_METADATA_KEY = 'auth:required_scopes';

// ---------------------------------------------------------------------------
// M10 W0.5 (ADR 0027) — login endpoint constants.
// ---------------------------------------------------------------------------

// REST route fragments. Pinned here so the controller + tests + shared
// READ_API_PATHS share the same literals (`v1/auth/login` mounted at root).
export const AUTH_BASE_PATH = 'v1/auth';
export const AUTH_LOGIN_PATH = 'login';

// Subject stamped on login-issued tokens. Single-operator system; per-operator
// credentials are M11 scope.
export const AUTH_LOGIN_SUBJECT = 'operator';

// Audit-row sentinels for failed / throttled login attempts (ADR 0027 §2.5).
// Success rows use the issued sub (AUTH_LOGIN_SUBJECT) + jti.
export const AUTH_LOGIN_FAILURE_ACTOR_SUB = 'unknown';
export const AUTH_LOGIN_FAILURE_ACTOR_JTI = '';

// Per-IP sliding-window rate limit (ADR 0027 §2.4).
export const LOGIN_PER_IP_BURST_WINDOW_MS = 10_000;
export const LOGIN_PER_IP_BURST_MAX = 5;
export const LOGIN_PER_IP_SUSTAINED_WINDOW_MS = 600_000;
export const LOGIN_PER_IP_SUSTAINED_MAX = 20;

// Global ceiling across all IPs (ADR 0027 §2.4). Past this every login throws
// 429 and a coalesced CRITICAL Telegram alert fires.
export const LOGIN_GLOBAL_WINDOW_MS = 60_000;
export const LOGIN_GLOBAL_MAX_ATTEMPTS = 200;
export const LOGIN_GLOBAL_ALERT_COALESCE_MS = 60_000;

// M10 R2 #1/#3 — request-body `secret` max length. Caps the per-request work
// (SHA-256 hash + audit row truncation) and prevents a body-size DoS through
// the login path. 1024 bytes comfortably exceeds any realistic bootstrap
// secret (the env enforces a 32-byte minimum; humans rarely paste > 256).
export const LOGIN_SECRET_MAX_LEN = 1024;
