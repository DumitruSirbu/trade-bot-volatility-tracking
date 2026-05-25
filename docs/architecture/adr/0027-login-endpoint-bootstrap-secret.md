# ADR 0027 — Login endpoint with bootstrap secret (M10)

**Status:** Accepted (M10 design wave)
**Date:** 2026-05-25
**Milestone:** M10 — Dashboard
**Depends on:** ADR 0020 (auth, CORS, token shape, revocation), ADR 0021 (rate-limit pattern), ADR 0026 (dashboard topology).
**Amends:** ADR 0020 §2.1 (token issuance is now CLI **and** login-endpoint; both produce the same JWT shape and respect the same revocation list).
**Consumed by:** M10 W0.5 (engine `AuthController`), M10 W1 (dashboard `LoginScreen`).

## 1. Context

ADR 0020 §2.1 picked CLI-only token issuance (`pnpm engine auth issue ...`) and ADR 0020 §4 rejected a login endpoint with the reasoning "doubles the surface for a single-operator system." M10 design surfaced the operator-side cost: paste-the-token is workable but every 15 minutes the operator must context-switch to a shell, run the CLI, copy the JWT, and paste it back. That cadence (~ every 15 minutes, all session) makes the friction non-trivial and pushes operators toward longer-lived tokens — exactly the anti-pattern ADR 0020 wanted to prevent.

The orchestrator has overridden D1 (M10 execution plan §Decisions) and chosen a **login endpoint behind a bootstrap secret**. This ADR locks the contract before W0.5 ships engine code.

The login endpoint must:

- Not weaken any invariant from ADR 0020 (token shape, revocation, CORS, expiry semantics).
- Defend against brute-force of the bootstrap secret.
- Audit every login attempt — success and failure — with the same forensic depth as `control_audit`.
- Coexist with the CLI issuance path (CLI stays for operator-host workflows, scripts, ops runbooks).

## 2. Decision

### 2.1 Endpoint shape

```
POST /v1/auth/login
Content-Type: application/json
Body: { "secret": "<bootstrap-secret string>" }

200 OK
{
  "token": "<HS256 JWT>",
  "expiresAt": "<ISO timestamp>",
  "scopes": ["read", "halt"],
  "subject": "operator"
}

401 Unauthorized
{ "error": "AUTH_FAILED", "reason": "BAD_SECRET" }

429 Too Many Requests + Retry-After: <sec>
{ "error": "RATE_LIMITED", "reason": "TOO_MANY_LOGIN_ATTEMPTS", "retryAfterSec": <n> }

400 Bad Request
{ "error": "AUTH_FAILED", "reason": "MALFORMED" }  // missing/empty secret
```

The 401 body deliberately does NOT distinguish "secret never matched" from "secret matched but the issuance pipeline failed." Both surface as `BAD_SECRET` to deny an oracle.

The endpoint is **unauthenticated** (no bearer required — it is the bootstrap path). It is reachable from any origin on the CORS allow-list (same allow-list as the rest of the API per ADR 0020 §2.3). Preflight OPTIONS handled by `AuthCorsInterceptor` unchanged.

### 2.2 Token shape — identical to ADR 0020 §2.1

The returned JWT is HS256-signed with the **same `AUTH_SIGNING_SECRET`** the CLI uses. Same claims (`sub`, `iat`, `exp`, `jti`, `scopes`). Same TTL (default 15 min, configurable via `AUTH_TOKEN_TTL_SEC`). The auth guard (`AuthGuard`) cannot tell a login-endpoint-issued token from a CLI-issued one — and must not need to. Revocation via `POST /v1/auth/revoke` works identically. The `revoked_jti` table is shared.

Scopes returned by login default to `['read', 'halt']`. The endpoint **does NOT issue `admin` scope** — admin tokens (used for `POST /v1/auth/revoke`) remain CLI-only. Rationale: admin scope can revoke any token including itself; binding it behind a single shared secret over HTTP enlarges its blast radius. The CLI runs on the engine host, inside the trust boundary.

Configurable via env `AUTH_LOGIN_SCOPES` (comma-separated, default `read,halt`); `admin` in that list is **refused at boot** by `AppConfigService` with a clear error message.

### 2.3 Bootstrap-secret storage

The bootstrap secret is loaded from env `AUTH_BOOTSTRAP_SECRET` via `AppConfigService` (per ADR 0020 §2.7 — no per-request `process.env`). Constraints, enforced at boot:

- **Minimum 32 bytes** (256-bit entropy). Boot-fail otherwise.
- **No well-known sentinels** (`'change-me'`, `'dev-secret'`, repeated bytes, all-lowercase ASCII, the same value as `AUTH_SIGNING_SECRET`). Same boot-time rejection list as the signing secret, extended.
- **Not equal to `AUTH_SIGNING_SECRET`.** Reuse across keys would let a compromised signing secret forge logins (and vice versa).
- **Not committed to git** (gitignored `.env`, same discipline as exchange keys per ADR 0020 §2.4).

Comparison MUST use `crypto.timingSafeEqual` against the SHA-256 hash of both inputs (hash first to normalize length, since `timingSafeEqual` rejects unequal-length buffers — and an attacker should not learn the secret's length via that path either).

The secret is **long-lived and manually rotated**. There is no rotation ceremony in M10; the operator stops the engine, swaps the env value, restarts, and re-logs-in. M11 may introduce a graceful-rotation overlap window. Rotation in M10 invalidates all in-flight session tokens issued via login (signing-secret rotation does too — same property).

### 2.4 Rate-limit

The login endpoint is brute-force bait. The limiter is stricter than the kill-switch's per-`sub` window (because there is no `sub` to key off — the caller is unauthenticated).

Keyed on **source IP** (from `X-Forwarded-For` first hop, falling back to socket remote address). Two layered windows:

| Window | Limit | Rationale |
|---|---|---|
| 10 seconds | 5 attempts | Stops scripted bursts. |
| 10 minutes | 20 attempts | Stops sustained low-rate guessing. |

On either limit hit → 429 with `Retry-After` set to the more-restrictive remaining window. The 429 counts toward the windows so an attacker cannot probe-and-poll the limiter cheaply.

A **global ceiling** also applies: 200 total login attempts across all IPs in any 60-second window. Past that, every login returns 429 with `reason: 'TOO_MANY_LOGIN_ATTEMPTS'` and a single Telegram `CRITICAL` alert fires (coalesced — one per minute max, per ADR 0024 rate-limit pattern). This catches distributed attacks single-IP limits miss.

Limiter is in-memory and single-process (matches `HaltRateLimiter` per ADR 0021 §2.2). A Redis-backed shared limiter is M11 scope when multi-instance or external exposure is in scope.

Successful logins **also** count toward the per-IP windows. An operator who triggers re-login every 15 minutes will sit at ~1/hr — well under the cap.

### 2.5 Audit-log entry

Login attempts (success AND failure, AND rate-limited) write to the same `control_audit` table (ADR 0021 §2.3) with extended `action` enum:

| Column | Login success | Login failure | Login throttled |
|---|---|---|---|
| `action` | `'LOGIN_SUCCESS'` | `'LOGIN_FAILURE'` | `'LOGIN_THROTTLED'` |
| `actor_sub` | `'operator'` (the issued sub) | `'unknown'` (no sub assignable) | `'unknown'` |
| `actor_jti` | the new token's jti | `''` (no token) | `''` |
| `source_ip` | from request | from request | from request |
| `reason` | `'login'` | `'BAD_SECRET'` \| `'MALFORMED'` | `'TOO_MANY_LOGIN_ATTEMPTS'` |
| `flatten_requested` | `false` | `false` | `false` |
| `previous_state` | current halt state | current halt state | current halt state |
| `new_state` | unchanged | unchanged | unchanged |
| `correlation_event_id` | `null` | `null` | `null` |

The `HaltAuditActionEnum` shared type extends from `{HALT, RESUME}` to `{HALT, RESUME, LOGIN_SUCCESS, LOGIN_FAILURE, LOGIN_THROTTLED}` in W0. Existing `IHaltAuditEntry` consumers (dashboard history drawer, `GET /v1/control/halt/history`) display login rows naturally — operators see "who logged in from where" in the same timeline as halts.

`previous_state` / `new_state` carry the engine's halt state at audit-write time so a forensic reader sees the operating mode during the login. They are not changed by login itself.

Login failure does NOT count against the kill-switch's per-`sub` rate-limit (different surface, different limiter, different key dimension).

### 2.6 CLI coexistence

`pnpm engine auth issue` and `pnpm engine auth revoke` remain. The CLI:

- Issues tokens with the same JWT shape, signed with the same secret, optionally including the `admin` scope (only path to admin).
- Bypasses `AUTH_BOOTSTRAP_SECRET` (the CLI runs on the engine host, inside the trust boundary — file-system access to `.env` already implies full compromise).
- Writes `control_audit` with `action='LOGIN_SUCCESS'`, `actor_sub='cli'`, `source_ip=null`. Distinguishes CLI tokens from HTTP-login tokens in the audit trail without enlarging the enum further.

The dashboard never sees the CLI path; the CLI is the operator's emergency / scripted path.

### 2.7 Failure-shape consistency

All login failures use the existing `IAuthFailure` envelope (ADR 0020 §2.6) with one new `AuthFailureReasonEnum` member: `BAD_SECRET`. Rate-limit 429s use the existing `IRateLimitFailure` envelope from `HaltRateLimiter` with one new member: `TOO_MANY_LOGIN_ATTEMPTS`. Both enum extensions land in `packages/shared/` (M10 W0).

### 2.8 What the login endpoint does NOT do

- Does NOT set a cookie. Token is in the JSON body. Storage is the dashboard's concern (sessionStorage per ADR 0026 §2.3).
- Does NOT support refresh. Re-login on expiry, same model as ADR 0020 §2.1.
- Does NOT support "remember me" or extended TTL. `AUTH_TOKEN_TTL_SEC` is universal.
- Does NOT echo the bootstrap secret in any response, log line, or audit row. The secret never leaves env-loader memory.
- Does NOT short-circuit `revoked_jti`. A jti returned by login can be revoked by the next request (`POST /v1/auth/revoke`) just like any CLI-issued token.

## 3. Consequences

- **Operator UX** improves materially: login once per session via a form, re-login when expired. The CLI remains as the emergency / admin path.
- **Attack surface widens by one unauthenticated POST.** Mitigated by: minimum-32-byte secret + sentinel rejection, constant-time compare, layered rate-limit, global ceiling, full audit, Telegram alert on global threshold, response opacity (`BAD_SECRET` regardless of failure mode).
- **Threat model** for the bootstrap secret: long-lived shared secret, single operator, single value. Compromise = full operator access (read + halt) for the configured TTL until detected and rotated. Detection signals: anomalous `LOGIN_SUCCESS` rows in `control_audit` (source IP, frequency); Telegram alert on global rate-limit ceiling. Compensation: short TTL (15 min) bounds session blast radius; admin scope is still CLI-only so an attacker cannot self-revoke other tokens to evict the operator.
- **Audit-trail expands** — the `control_audit` table now records login events; volume grows roughly linearly with operator session count, still small. Pagination / retention concerns deferred to M11 (already flagged in M9 execution plan §Risks).
- **Shared enum extensions** (`HaltAuditActionEnum`, `AuthFailureReasonEnum`, `IRateLimitFailure.reason`) are additive and backward-compatible with existing M9 consumers.

## 4. Alternatives considered

- **Keep paste-the-token (no endpoint).** Rejected by D1 override — operator UX is the dominant cost in a single-operator system and the friction was nudging toward bad habits (longer TTLs, token reuse).
- **Per-operator credentials (username + password).** Rejected: requires a user store + password hashing (Argon2/bcrypt) + reset flow + lockout. Massive surface for a single-operator system. Bootstrap secret captures the single-operator essence with one env var.
- **OAuth / external IdP.** Rejected for M10: same reason ADR 0020 rejected RS256 — no external IdP exists; introducing one for a single operator is over-engineered. Deferred to M11 when multi-operator may apply.
- **Bootstrap secret as a header (`X-Bootstrap-Secret`) on every request.** Rejected: that IS "long-lived API key" which ADR 0020 §4 already rejected — cannot be revoked without restart, defeats the 15-min TTL property. The login endpoint exchanges the long-lived secret for a short-lived bearer once.
- **TLS client certs (mTLS) for login only.** Rejected for M10: cert provisioning workflow exceeds the M10 budget; if mTLS arrives in M11 per ADR 0020 §4, it replaces this endpoint cleanly.
- **Allow `admin` scope via login.** Rejected per §2.2: admin is the revocation path; binding it to a single shared secret over HTTP would let a leaked secret evict the legitimate operator.
- **Single rate-limit window (10s/5).** Rejected: catches bursts but not patient low-rate guessing. Two-window + global ceiling is the standard defense-in-depth shape.
- **Per-username rate-limit (instead of per-IP).** Rejected: there is no username at the rate-limit decision point — the caller is unauthenticated by definition. Per-IP is the only honest key.
- **Distinguish 401 reasons (`BAD_SECRET` vs `MALFORMED`).** Accepted with care: `MALFORMED` only fires when the body itself is invalid JSON or missing the `secret` field. A present-but-wrong secret is always `BAD_SECRET`. An attacker learns nothing about correctness — they learn whether their request was a valid POST shape, which they can determine client-side anyway.
