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
