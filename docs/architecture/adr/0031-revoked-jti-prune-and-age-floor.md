# ADR 0031 — `revoked_jti` TTL prune + age-floor

**Status:** Accepted (M11a design wave)
**Date:** 2026-05-25
**Milestone:** M11a — Local soak hardening (W1.6)
**Depends on:** ADR 0020 (auth, token shape, `revoked_jti` table), ADR 0027 (login endpoint — same JWT shape, same revocation list).
**Consumed by:** M11a W1.6 (engine `RevokedJtiPruneScheduler`), W4 soak exit-gate "revoked_jti stayed bounded" criterion.

## 1. Context

The `revoked_jti` table (ADR 0020 §2.2, projected by `RevokedJtiEntity` in
`apps/engine/src/auth/entity/RevokedJtiEntity.ts`) records every revoked JWT id
so `AuthGuard` can reject a stolen-but-revoked token before it is honoured.

ADR 0027 added a login endpoint that issues tokens with the **same shape** as
CLI tokens and writes into the **same** `revoked_jti` table. Under a multi-week
local soak (M11a W4) with auth rotation drills (W1.8), revocations accumulate:

- normal session churn (one operator, ~1 login per TTL cycle);
- bootstrap-secret rotation drills bulk-revoke outstanding sessions;
- JWT signing-secret rotation drills do the same;
- adversarial events (suspected leak → revoke + rotate).

The table is currently insert-only with no prune. Over a 60-day soak the row
count is small in absolute terms but unbounded in principle, and the absence of
a documented prune procedure means a future high-volume mode (multi-operator,
external exposure) would inherit the unbounded growth silently.

A naive prune ("delete rows older than 7 days") introduces a **security hole**:
if a JTI entry is pruned while its token's `exp` claim is still in the future,
the token returns to validity. `AuthGuard` would then accept a previously
revoked token until natural expiry. This ADR fixes the rule in advance of the
W1.6 implementation.

## 2. Decision

### 2.1 Invariant (load-bearing)

> **A revoked JTI entry must outlive any token that carries it.**

A token issued at time `T` with lifetime `L` carries `exp = T + L`. If the
corresponding `revoked_jti` row is deleted at any moment before `exp`, the
token re-enters the validity window from `AuthGuard`'s perspective — a
stolen-and-revoked token can be replayed. Pruning must therefore wait until
no live token can still reference the jti.

### 2.2 Age floor

```
prune_after  >=  jwt_max_ttl  +  safety_margin
```

- `jwt_max_ttl` is the value of `AUTH_TOKEN_TTL_SEC` (ADR 0027 §2.2; default
  `15 min`). It is the **maximum** lifetime a token can carry — there is no
  refresh, no "remember me", no extended TTL (ADR 0027 §2.8).
- `safety_margin` = **1 hour**. Absorbs (a) clock skew between the engine
  and Postgres (NTP-bounded, sub-second in practice, but the margin is a
  belt-and-braces budget), (b) skew between the engine's `iat` clamping and
  the verifier's wall clock, and (c) the prune cadence itself (the next
  scheduled prune may run up to one cadence-interval after the strict floor).
- The math: a row is eligible for deletion only when
  `revoked_at < now() - prune_after`. Given `revoked_at <= iat` is **false**
  in general (the row is written at revocation time, not issuance time), the
  conservative bound uses `revoked_at` itself: any token carrying this jti
  has `exp <= revoked_at + jwt_max_ttl`. Choosing
  `prune_after = jwt_max_ttl + safety_margin` guarantees
  `now() - prune_after > revoked_at  =>  now() > exp + safety_margin`, i.e.
  the token is already past `exp` plus the margin before the row is pruned.
- Concrete default: `jwt_max_ttl = 15 min`, `safety_margin = 60 min`,
  `prune_after = 75 min`. Exposed via `AUTH_REVOKED_JTI_PRUNE_AFTER_SEC`,
  validated at boot by `AppConfigService`: must be `>= AUTH_TOKEN_TTL_SEC +
  3600`. Boot-fail with a clear message otherwise. This is the same
  bind-at-boot pattern ADR 0027 §2.3 uses for bootstrap-secret constraints.

### 2.3 Prune cadence

A NestJS `@Cron`-driven scheduler running **hourly** inside the engine
process. Class: `RevokedJtiPruneScheduler`, located alongside
`AuthModule.ts`. Pattern matches `DailyPnlSummaryScheduler` (M9, ADR 0024)
and the M2/M8 `TickAggregatePartitionService` — both already use NestJS
`@nestjs/schedule` with engine-local cron triggers.

- **Hourly**, not "every prune_after", because (a) the dominant cost is the
  single indexed `DELETE` and is negligible, (b) running more frequently
  bounds the post-floor lag, (c) hourly aligns with operator log-review
  cadence in `RUNBOOK.md` (M11a W3.15).
- **Single-host only.** Postgres `pg_cron` is rejected — M11a is explicitly
  single-instance (M11b owns multi-instance). One engine process running the
  cron is the correct authority; a second authority (Postgres) would compete
  for the delete and add operational surface for zero benefit.
- The scheduler logs each run at `info`: row-count deleted, oldest
  `revoked_at` remaining, total row-count after. The log line is one of the
  daily-check signals in the runbook.
- The scheduler skips work if the prior run is still executing (NestJS
  default; the cron decorator is non-reentrant).
- Boot sequencing: the scheduler is registered in Phase 8 of the M6
  10-phase crash-recovery pipeline (per `EngineBootstrapService` — Phase 8
  is the documented scheduler kickoff). No work runs before `AuthGuard` is
  live; no work runs in `EXCHANGE_ENV=TESTNET` smoke runs by accident
  because the scheduler ships unconditionally — testnet still wants the
  same hygiene.

### 2.4 Bounded growth assertion

The steady-state row count is bounded by:

```
row_count  <=  (max_revocations_per_minute)  *  prune_after_minutes
```

- Operator-driven revocations during normal session churn: ~1/hour.
- Rotation drills: a single bulk revoke during a bootstrap-secret rotation
  or JWT-signing-secret rotation evicts ~all outstanding sessions —
  bounded by `AUTH_LOGIN_SCOPES`-shaped session count, which for a
  single-operator soak is `O(1)` (a handful).
- Adversarial revocation rate (compromise scenario): not bounded by the
  bot — bounded by the operator typing speed.

**Alert:** if `row_count > REVOKED_JTI_MAX_ROWS` (default `10_000`), the
scheduler emits a single Telegram `WARNING` alert per scheduler tick (the
ADR 0024 coalescing rule applies). A breach at 10k indicates either (a) a
prune failure (deletes throwing — surfaced separately at `error`), or (b)
a revocation storm worth operator attention. The alert reason is
`'REVOKED_JTI_UNBOUNDED'`. The threshold is configurable.

The bound is independent of `jwt_max_ttl` because `prune_after` already
absorbs it.

### 2.5 JTI lifecycle

- **Insert** on revocation. `RevokedJtiRepository.add(jti, reason,
  revokedBy)` is the only writer; `revoked_at` is server-set via the entity's
  `default: () => 'now()'` clause (confirmed in `RevokedJtiEntity.ts:11`).
- **Read** by `AuthGuard` on every authenticated request.
- **Delete** by `RevokedJtiPruneScheduler` once per hour where
  `revoked_at < now() - AUTH_REVOKED_JTI_PRUNE_AFTER_SEC`.
- **Never update.** The row is immutable between insert and delete. No
  refresh, no "extend revocation," no soft-delete column.

The existing `revoked_at` column (server-side `DEFAULT now()`, see
`RevokedJtiEntity.ts:11`) serves as the prune timestamp directly — no
separate `created_at` column is required. **No migration is owned by this
ADR.** If a future change splits the two timestamps, the migration belongs
to that change's wave, not this one.

### 2.6 Interaction with bootstrap-secret rotation (ADR 0027 §2.3) and JWT-secret rotation

When `AUTH_SIGNING_SECRET` rotates, every token signed with the old secret
fails JWT signature verification at `AuthGuard` — regardless of `revoked_jti`
content. The signature check runs before the revocation check, so the
`revoked_jti` table is **not** the rotation invalidation path. Two
consequences for the operator:

- **The table does NOT need to be flushed at rotation.** Rotation evicts
  sessions by signature, not by jti. The existing rows continue to age out
  under the normal prune cadence.
- **Rotation drills must still complete a normal prune cycle** before the
  soak exit-gate evaluator (M11a W4) reads `revoked_jti` stats, because the
  drill leaves transient rows behind. This is implicit in the hourly
  cadence and explicitly documented in `RUNBOOK.md` under the rotation
  procedure (W1.8).

`AUTH_BOOTSTRAP_SECRET` rotation (ADR 0027 §2.3) does not produce
`revoked_jti` rows on its own — it changes the login path, not in-flight
tokens. Outstanding session tokens stay valid until their natural `exp` or
until the operator explicitly revokes them via the CLI `auth revoke`
command. If the operator wants to evict sessions during a bootstrap-secret
rotation, the documented procedure is "revoke first, rotate second" —
ordering recorded in the W3.15 runbook.

## 3. Consequences

- **Security:** the load-bearing invariant ("a revoked entry outlives any
  token carrying it") is now explicit, configurable with safe defaults, and
  enforced at boot. No prune scheduler ships without `AppConfigService`
  refusing to boot if `AUTH_REVOKED_JTI_PRUNE_AFTER_SEC <
  AUTH_TOKEN_TTL_SEC + 3600`.
- **Bounded growth:** the steady-state row count is small (`O(prune_after *
  revocation_rate)`); a `WARNING` alert fires before unbounded growth can
  threaten Postgres. The W4 soak exit-gate criterion "revoked_jti stayed
  bounded" is now measurable.
- **Operational surface:** one new scheduler, one new env var, one new
  alert reason. Pattern matches existing schedulers (M9
  `DailyPnlSummaryScheduler`, M2/M8 partition cron) — no new framework or
  process supervisor is introduced.
- **No migration owed by this ADR.** The existing `revoked_at` column
  satisfies the prune timestamp need.
- **Multi-instance forward-compatibility (M11b):** if M11b introduces a
  second engine instance, the hourly cron becomes a leader-elected job or
  moves to a dedicated maintenance process. The contract documented here
  (the age-floor invariant) is unaffected by topology; only the cadence
  authority changes.

## 4. Alternatives considered

- **No prune (keep all rows forever).** Rejected: the W4 soak exit-gate
  cannot assert "bounded" against an explicitly unbounded table, and a
  future high-volume mode inherits a silent latent issue. The cost of the
  scheduler is negligible.
- **Prune based on `exp` decoded from the JTI / token.** Rejected: the
  table stores `jti` only, not the original token. Re-deriving `exp` would
  require either storing it (schema change for no benefit over a fixed
  floor) or trusting an external claim that cannot be re-verified after
  revocation. The fixed `prune_after = jwt_max_ttl + margin` floor is
  strictly safer and requires no schema change.
- **Postgres `pg_cron` for the prune job.** Rejected: M11a is
  single-instance and single-host (M11b owns multi-instance). Adding a
  second scheduling authority inside Postgres splits operational surface,
  doubles failure modes, and offers nothing the engine-local `@Cron`
  scheduler does not already deliver. Re-evaluate in M11b only if leader
  election proves harder than `pg_cron`.
- **Hourly cadence vs. daily cadence.** Daily rejected: post-floor lag of up
  to 24h enlarges the row-count headroom proportionally and pushes any
  alert reaction off the operator's daily-check cadence. Hourly is the
  natural granularity given the 15-min TTL.
- **Smaller safety margin (e.g., 5 minutes).** Rejected: the cost of a 1h
  margin is `O(60)` extra rows under any realistic revocation rate;
  shrinking the margin trades operator-visible safety for negligible
  storage. The margin also has to cover the cadence interval itself, so
  setting it below the cadence is incoherent.
- **Flush `revoked_jti` on signing-secret rotation.** Rejected (and
  documented in §2.6): signature verification already invalidates the
  affected tokens; flushing is redundant and would erase the audit-grade
  property that a revocation row outlives every token it ever protected.
- **Move revocation to a TTL-indexed cache (Redis).** Rejected for M11a:
  Postgres is the system of record, Redis is not currently used by
  `AuthGuard`, and introducing a second source of truth for the
  security-critical revocation list duplicates the failure modes without
  benefit at single-instance scale. M11b may revisit if multi-instance auth
  requires shared low-latency state.
