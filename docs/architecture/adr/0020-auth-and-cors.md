# ADR 0020 — Auth, CORS & token lifecycle (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9 — Observability, control & read API
**Depends on:** M0 (secret loading), `docs/plans/archive/M9-observability-control.md` (Auth-FIRST gate).
**Consumed by:** ADR 0021 (kill-switch), ADR 0022 (read-API), ADR 0023 (WS/SSE), M10 (dashboard).

## 1. Context

Before any endpoint exists in the engine, an authentication guard must gate **all** HTTP and WS traffic. M9's brief is explicit: "no endpoint — especially halt — exists before the guard is in place." That requires us to pin the auth model **before** wave W0 of M9 dispatches code.

The engine is a single internal NestJS process behind the docker-compose network, reached only by:

- the M10 dashboard container (operator UI, single user today),
- an operator's CLI / curl from the same host,
- nothing else — no public internet exposure pre-M11.

Key constraints from `00-overview.md` and CLAUDE.md:

- exchange keys are least-privilege and never committed; auth credentials inherit the same rule;
- the engine is the only writer to the halt flag and to any future control surface — auth failure must be observable, not silent;
- the same shared-types package serves both engine and dashboard (M10 will consume the auth error shape).

## 2. Decision

### 2.1 Transport: short-lived bearer tokens (HS256 JWT) over HTTPS-in-prod / loopback in dev

A bearer-token model is chosen over mTLS. Token issuance is **out-of-band** (operator runs `pnpm engine auth issue --subject=operator --ttl=15m`); the token is consumed by both REST and the WS handshake via the `Authorization: Bearer <token>` header.

- **TTL:** 15 minutes hard maximum. Configurable down via env `AUTH_TOKEN_TTL_SEC` (default `900`). No "remember me." Refresh = re-issue (re-run the CLI).
- **Algorithm:** HS256 with a single signing secret pulled from the secret manager (`AUTH_SIGNING_SECRET`, 32-byte min). Rotation = swap the secret and invalidate all live tokens. RS256 deferred to M11 when an external IdP may exist.
- **Claims:** `sub` (operator id), `iat`, `exp`, `jti` (revocation id), `scopes` (`read` | `halt` | `admin`). No PII; no IP binding (operator may roam).
- **Storage at rest:** the engine **does not persist tokens**. Only the signing secret + a `revoked_jti` table (auto-pruned past `exp`).

### 2.2 Revocation path

A `POST /v1/auth/revoke { jti }` endpoint (scope `admin`) inserts the `jti` into `revoked_jti`. The auth guard checks `revoked_jti` on every request and on every WS message (see §2.5). A `pnpm engine auth revoke --jti=<id>` CLI command is the operator path.

Why a revocation table even with 15-min TTL: a leaked token must be killable in seconds, not minutes. The table is small (TTL-bounded) and indexed on `jti`.

### 2.3 CORS allow-list

`Access-Control-Allow-Origin` is **never `*`**. The allow-list is an env list `AUTH_CORS_ALLOWLIST` (comma-separated). Default in dev: `http://localhost:5173` (Vite dashboard). Default in prod: empty — operator must populate it explicitly before M10 deploy. Preflight (`OPTIONS`) is handled by the guard, not bypassed.

**Single source of truth (M9 R1 adjudication F):** The allow-list is parsed once at boot by `AppConfigService` (typed `readonly corsAllowlist: ReadonlyArray<string>`) and injected into both `AuthCorsInterceptor` and the socket.io `@WebSocketGateway`. Neither component reads `process.env` directly — `process.env` access is forbidden outside `AppConfigService`. Rationale: per-request `process.env` lookups (a) silently diverge from gateway boot-time reads if `.env` is hot-edited, (b) cost CPU per request, (c) bypass typed coercion. This applies to **every** env-derived setting in M9 (see also §2.7 and ADR 0021 §2.4).

`Access-Control-Allow-Credentials: true` is set because the dashboard sends the bearer in a header (not a cookie), but credentials mode keeps future cookie-based session paths open without a breaking change.

### 2.4 Secret-manager source

Phase 1 (now): secrets are loaded from environment variables, populated by `docker compose` from an operator-owned `.env` file that is gitignored. The same loader pattern as exchange keys (M1). `AUTH_SIGNING_SECRET` must be `>= 32 bytes`; the engine refuses to boot otherwise (boot-time check in the same startup-validation gate as ADR 0025).

Phase 2 (M11): swap the loader for AWS SSM / Vault / 1Password Connect without changing the guard. The guard depends on an `IAuthSecretProvider` port; the env loader is one adapter.

**Dev-mode default secret is forbidden.** The boot-time check refuses *any* well-known sentinel (`'change-me'`, `'dev-secret'`, repeated bytes, `< 32 bytes`). The operator must supply a real secret even in dev — there is no convenience fallback that could accidentally ship to prod via copy-paste.

### 2.7 Typed env access (single source)

All M9 env reads land in `AppConfigService` with typed coercion. Booleans use a case-insensitive parser (`'true'|'1'|'yes'` → `true`; `'false'|'0'|'no'` → `false`; anything else → boot-fail with the env name). Affected keys: `AUTH_SIGNING_SECRET`, `AUTH_TOKEN_TTL_SEC`, `AUTH_CORS_ALLOWLIST`, `KILL_SWITCH_FLATTEN_DEFAULT`, `ALERTS_ENABLED`, `ALERTS_MIN_SEVERITY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Controllers, interceptors, and gateways inject the config object, never `process.env`.

### 2.5 WS re-validation on expiry

Per M9 brief: a long-lived WS that authenticated once must not stream forever. The WS gateway:

- validates the bearer **on handshake** (`auth` field in the socket.io `connect` payload),
- attaches the token's `exp` and `jti` to the socket session,
- on each outbound emit, checks `now() < exp` AND `jti NOT IN revoked_jti`. On failure, the gateway emits a single `auth.expired` event with the failure reason and closes the socket. Client (M10) handles reconnect with a fresh token.
- runs a sweeper every 30s that proactively closes sockets whose tokens are within 5s of `exp`, so the client sees `auth.expired` as a clean close rather than a mid-emit drop.

### 2.6 Failure shape

All auth failures return HTTP `401` with body `{ "error": "AUTH_FAILED", "reason": "EXPIRED" | "REVOKED" | "MALFORMED" | "MISSING" | "BAD_SCOPE" | "CORS_FORBIDDEN" }`. The shape is locked in `packages/shared/src/interface/IAuthFailure.ts` (added by the shared-maintainer in W0). No stack traces, no claim contents, no token echo.

## 3. Consequences

- The auth guard ships in W0 of M9 and gates every endpoint added in later waves. There is no "internal-only" route bypass.
- Operator workflow gets a small ceremony (re-issue every 15 min) — acceptable given the operator base is one person and the workflow is largely "open dashboard once, leave it open."
- The `revoked_jti` table is the only new persisted state in W0 (one TypeORM migration; small).
- mTLS is **not** ruled out forever; ADR 0020 leaves the door open by making the guard's only contract "produce an `IAuthSubject` from the request." M11 may add an mTLS adapter without churning downstream waves.

## 4. Alternatives considered

- **mTLS only.** Rejected for phase 1: operator UX requires cert provisioning per browser, and revocation is harder (CRL/OCSP). Stronger in principle; deferred until external exposure (M11).
- **Long-lived API key.** Rejected: cannot be revoked without a rebuild/restart; violates M9's "revoked token stops working immediately."
- **Cookie/session.** Rejected: same-origin assumptions are weaker once the dashboard is on a different host; bearer-in-header generalises better and is simpler to test from a CLI.
- **No CORS allow-list (rely on auth alone).** Rejected: defense in depth — a CSRF-style cross-origin request from a malicious site the operator visits in the same browser must not even reach the guard.
- **Refresh tokens.** Rejected for phase 1: doubles the surface for a single-operator system. Re-issue via CLI is fine. Revisit when operator count > 1.
