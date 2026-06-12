# Independent Review — M17 Automated Daily DB Backup

**Plan reviewed:** `docs/plans/archive/M17-daily-db-backup.md`  
**Reviewer:** Composer (independent analysis)  
**Passes:** 2 — initial (pre-amendment) + follow-up (post-amendment, 2026-05-31)

---

## Executive Verdict (Pass 2)

The amended M17 plan **resolves every blocker and medium finding** from the initial review. The plan now explicitly documents dynamic cron registration, the host-vs-container `DB_BACKUP_DIR` contract, Docker-only automated backup scope, CI/test disable defaults, spawn/secret handling, re-entrancy, security guards, and both filename prefixes. Verification expanded from 10 to 15 checks covering compose path survival, non-default cron, and non-root writes.

**Assessment:** **Ready for implementation dispatch** — no remaining plan-level blockers. A handful of low-risk implementation notes below should be handled during Wave 2 coding, not as further plan edits.

| Area | Pass 1 | Pass 2 | Notes |
|------|--------|--------|-------|
| Problem / motivation | A | A | Unchanged — real recovery gap. |
| Safety (soak DB) | A | A | Read-only dump, scoped prune, no volume ops. |
| Architecture fit | B+ | **A-** | `SchedulerRegistry` pattern specified; first use in repo. |
| DevOps / compose | B | **A-** | Mount + env override + permissions documented. |
| Host-dev ergonomics | C+ | **B+** | Docker-only scope locked; manual rule-9 fallback clear. |
| Test plan | A- | **A** | Dynamic cron + re-entrancy + adversarial prune tests added. |
| Docs / naming | B | **A-** | Deliberate prefix split + runbook scribe task. |

**Bottom line:** Approve for dispatch. Standard waves (DevOps → Engine → QA → Review → Scribe).

---

## Amendment Resolution Matrix

The plan header cites the independent review and maps each finding to locked decisions / tasks. Status:

| ID | Finding (Pass 1) | Resolved in plan? | Where |
|----|------------------|-------------------|-------|
| H1 | Dynamic `@Cron()` won't work | **Yes** | Locked #1, #7; Wave 2 `onModuleInit` + `SchedulerRegistry`; QA cron test; verify #12 |
| H2 | Host vs container `DB_BACKUP_DIR` | **Yes** | Locked #3; Wave 1 compose override; `.env.example` table; verify #11 |
| H3 | Host dev (`pnpm engine:dev`) | **Yes** | Locked #4 — Docker-only; `DB_BACKUP_ENABLED=false` on host dev |
| H4 | Non-root mount permissions | **Yes** | Wave 1 chown note; verify #15 |
| M1 | CI must disable backups | **Yes** | Wave 1 CI env; `.env.test.example`; verify #14 |
| M2 | M16 dependency overstated | **Yes** | Depends-on rephrased; optional port guard in Wave 2 |
| M3 | `pg_dump` spawn contract | **Yes** | Wave 2 `--no-owner --no-acl`, env creds, no URL logging |
| M4 | Re-entrancy mutex | **Yes** | Wave 2 + QA + verify #12 |
| M5 | Disk space / ENOSPC | **Partial** | Optional log size + ENOSPC WARN — acceptable for M17 |
| M6 | Admin probe undefined | **Yes** | Dropped; verify #4 uses test/boot hook only |
| M7 | Alpine package verify | **Yes** | Wave 1 build smoke |
| L1 | Alert type reuse | **Yes** | Wave 2 `UNHANDLED_EXCEPTION` + reason |
| L2 | Retention sort key | **Yes** | Embedded timestamp, mtime fallback |
| L3 | Anchored regex + realpath | **Yes** | Wave 2 + adversarial QA |
| L4 | Schedule vs PnL/partition crons | **Yes** | Locked #3 cron comment |
| L5 | `.gitignore` | **Yes** | `backups/` in Wave 1 |
| L6 | Cloud seam | **Yes** | Out of scope unchanged |
| Naming | `backup_*` vs `trade_bot_*` | **Yes** | Locked #5 — deliberate; scribe documents both |
| Verify 11–15 | Suggested E2E checks | **Yes** | All merged into verification section |

**Pass 1 recommended amendments (1–10):** all incorporated.

---

## Remaining Low-Risk Notes (Implementation, Not Plan Blockers)

These are worth addressing in Wave 2 code or during review; none require another plan revision.

### N1 — First `SchedulerRegistry` usage in the repo

No existing scheduler uses dynamic registration. During implementation:

- Import `CronJob` from `cron` (transitive dep of `@nestjs/schedule`).
- Implement `OnModuleDestroy` to call `schedulerRegistry.deleteCronJob('db-backup')` on shutdown — avoids duplicate registration on hot-reload in dev and aligns with graceful shutdown patterns.
- Wrap the cron callback async work explicitly:

  ```typescript
  () => { void this.onTick().catch((err) => this.logger.error(...)); }
  ```

  so a rejected `onTick()` does not become an unhandled rejection (NestJS async error guidance).

### N2 — Optional test-DB port guard needs a constant

Wave 2 optional guard: reject `DATABASE_URL` port === `TEST_DB_PORT` (6900) when `NODE_ENV !== 'test'`.

`TEST_DB_PORT` is **not** in `EnvironmentVariables` today (only `.env.test.example` / CI). Options:

- Hardcode `6900` as a named module const (e.g. `TEST_DB_GUARD_PORT`) with a comment pointing at M16, **or**
- Add optional `TEST_DB_PORT` to env schema (only validated when set).

Prefer the const to avoid requiring a production env var that has no soak meaning.

### N3 — Same env var name, two meanings (documented — stay vigilant)

Compose uses `DB_BACKUP_DIR` from `.env` for the **host** bind source and overrides it to `/var/backups/trade-bot` inside the container. The plan documents this correctly. Implementers should not remove the compose `environment:` override when editing compose later.

### N4 — Wave 3 is unit-only; compose E2E is manual verification

Retention, path contract, and restore smoke rely on verification steps 1–15 (operator / milestone close), not an automated integration spec. Acceptable for M17 scope; consider a deferred `*.integration.spec.ts` if regressions appear.

### N5 — `.env.example` host-dev note

Scribe task covers runbook content. Ensure `.env.example` comments that **`DB_BACKUP_ENABLED=true` is for compose soak runs** and host dev should leave it `false` — the plan states this in locked #4 but the example file default is `true` (correct for compose-first onboarding).

### N6 — Temp files during failed dumps

Atomic write promotes only on success; failed runs may leave `trade_bot_*.sql.gz.tmp`. Plan does not require cleanup — acceptable. Optional: unlink stale `.tmp` files older than N hours on next successful run (out of scope unless reviewers ask).

---

## What Still Looks Strong

1. **Safety invariants unchanged** — postgres service/volume untouched; read-only dump; pattern-scoped delete only.
2. **Test matrix is complete** for a scheduler: filename, retention boundaries, prune scope, disabled flag, dynamic cron registration, re-entrancy, adversarial failures, config validation.
3. **Security prep built in** — anchored regex, `realpath`, no credential logging, explicit security review wave.
4. **Operator story** — scribe wave covers mount permissions, dual prefixes, host/container path table, manual dump not replaced.
5. **CI contract** — explicit `DB_BACKUP_ENABLED: 'false'` prevents dumping ephemeral 6900 data during tests.

---

## Suggested Verification (No Additions Required)

Pass 1 suggested checks 11–15 are already in the plan. Optional stretch (not required for DoD):

16. **Stale `.tmp` cleanup** — after forced kill mid-dump, next successful run leaves no promoted partial file (already implied by atomic write; `.tmp` may remain).
17. **`onModuleDestroy`** — engine restarts in dev without duplicate `db-backup` cron jobs (log once per schedule).

---

## Pass 1 Archive (Summary)

Initial review (pre-amendment) identified four high-risk gaps (dynamic cron, path env split, host dev scope, mount permissions) and six medium items (CI disable, M16 wording, spawn flags, mutex, admin probe, Alpine verify). All were addressed in the amended plan. Pass 1 concluded **Approve with amendments**; Pass 2 concludes **Approve for implementation**.

---

## Conclusion

**Recommended status:** **Approve for implementation** — dispatch DevOps → Engine → QA → Review → Scribe per the amended plan. Track implementation notes N1–N2 during Wave 2; no further plan document changes required before agent dispatch.
