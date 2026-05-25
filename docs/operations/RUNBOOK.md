# RUNBOOK

Local-soak operations runbook (M11a). This file is owned by `bot-scribe` for
the full M11a W3.15 scope; the sections below are W1.8's contribution and may
be expanded by later waves.

Cross-references:

- ADR 0027 — Login endpoint with bootstrap secret.
- ADR 0020 — Auth, token shape, revocation.
- ADR 0031 — `revoked_jti` TTL prune + age-floor.
- `docs/plans/M11a-local-soak.md` §W1, §W3.15.

## Bootstrap-secret rotation (W1.8)

The bootstrap secret (`AUTH_BOOTSTRAP_SECRET`) is the operator's sole
long-lived credential. ADR 0027 §2.3 mandates manual rotation; this section
documents the no-downtime procedure for a single-instance soak.

The procedure assumes:

- One engine container behind one dashboard container.
- The operator has shell access to the host running `docker compose`.
- The dashboard is reachable from a trusted network only (tailnet or
  loopback per W3.13).
- `AUTH_HMAC_SECRET` is **not** being rotated in the same window (a paired
  rotation is documented separately; mixing the two compounds the blast
  radius of a procedural mistake).

### 1. Generate a new secret

On the host running the engine:

```sh
# 48 base64 bytes ~= 64 base64 chars. Anything >= 32 bytes after
# base64-decode satisfies AUTH_BOOTSTRAP_SECRET_MIN_BYTES.
openssl rand -base64 48
```

Record the new value in a password manager BEFORE pasting it into the env
file. Loss of the new value mid-rotation leaves the operator unable to log
in until they revert to the old value or restart with the old `.env`.

### 2. Stage the new secret

The login path compares `AUTH_BOOTSTRAP_SECRET` against the request body via
`crypto.timingSafeEqual` (ADR 0027 §2.3). The engine reads the env value
ONCE at boot and caches a SHA-256 hash on the controller. Rotation is
therefore a process restart, not a hot-reload.

For a no-operator-visible-downtime rotation, the procedure is:

1. Confirm the operator currently holds a valid session token (the
   short-lived JWT issued at the previous login). The token survives the
   restart — JWTs are signed under `AUTH_HMAC_SECRET`, not the bootstrap
   secret. As long as the JWT has not hit its 15-min `exp`, the dashboard
   keeps working.
2. Edit `.env` and replace `AUTH_BOOTSTRAP_SECRET=<old>` with
   `AUTH_BOOTSTRAP_SECRET=<new>`. Verify file mode is `600` (W3.11:
   `ls -l .env | grep -- '-rw-------'`).
3. `docker compose up -d --no-deps engine` to recreate the engine
   container picking up the new env. The dashboard and Postgres are not
   touched.
4. The engine logs `auth.module.ready` (or equivalent) within the
   `start_period` of the healthcheck (60s — W3.7).
5. The dashboard's WebSocket disconnects on the engine restart and
   reconnects under the still-valid JWT. The operator sees a brief
   "reconnecting" indicator; no logout, no re-login.

### 3. Verify the new secret is in use

The next time the operator's JWT expires (≤15 min after step 2), the
dashboard prompts for a new login. The operator enters the **new** secret.

A successful login writes a `LOGIN_SUCCESS` row to `control_audit` with
`source_ip` set to the operator's address (ADR 0027 §2.5). Confirm by
running, via `docker compose exec postgres psql`:

```sql
SELECT occurred_at, action, source_ip, actor_sub
FROM control_audit
WHERE action IN ('LOGIN_SUCCESS','LOGIN_FAILURE','LOGIN_THROTTLED')
ORDER BY occurred_at DESC
LIMIT 5;
```

A `LOGIN_FAILURE` row with `reason='BAD_SECRET'` at the rotation time
indicates the operator pasted the wrong value. Re-attempt with the value
from the password manager.

### 4. Revoke the old secret

The old bootstrap secret stops being a valid credential the moment the
engine restarts in step 2. There is no overlap window — the comparison hash
is replaced atomically at boot.

There is **no `revoked_jti` row** written for a bootstrap-secret rotation
(per ADR 0031 §2.6) because no JWTs are invalidated; the secret rotation
affects the LOGIN path only. If the operator wants to evict existing
sessions during a bootstrap-secret rotation (e.g. after a suspected leak):

1. Revoke first via the CLI: `pnpm engine auth revoke --jti <jti>`. Repeat
   for every outstanding session jti (visible in `control_audit` rows with
   `action='LOGIN_SUCCESS'` since the last cold-restart).
2. Then run the rotation procedure above. The next prune cycle (≤1 hour
   per ADR 0031 §2.3) ages the revoked rows out under the normal TTL.

For a paired `AUTH_HMAC_SECRET` rotation, the rotation procedure is
documented in a separate section (TBD by `bot-scribe`).

### 5. Audit-trail rule

Every bootstrap-secret rotation MUST be recorded in the soak log
(`docs/work-log.md`) with:

- the date / time of the restart,
- the operator's source IP at the next login,
- the row count of `revoked_jti` before and after the next prune cycle
  (one operator-visible signal that ADR 0031 §2.4 row-count alarm is
  inert under a normal rotation).

The soak exit-gate requires at least one bootstrap-secret rotation to be
exercised during the soak window (`docs/plans/M11a-local-soak.md` §"Soak
exit criteria"). Recording the rotation in the work log is the evidence
that criterion was met.

## TODO — sections owned by later waves

The full W3.15 runbook (daily check, halt + drain, strategy-version
rollback, key-compromise, soak abort triggers, demo→live transition) is
authored by `bot-scribe` in W3. Do not write those sections here until W3
opens — premature drafts diverge from the eventual ops surface.
