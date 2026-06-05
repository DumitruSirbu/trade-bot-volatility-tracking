# M20 — Pre-cloud go-live blocker hardening

## Context

M19 unblocked the paper soak (the per-coin liquidity gate). The next milestone on the
roadmap is **M15 — cloud go-live**, but M15 lists a set of preconditions ("Multi-instance
safety", live-key safety) that are still open as **HIGH go-live blockers** in
`docs/tech-debt.md`. Moving real money onto a cloud box before these are closed exposes the
two failure modes that single-box local running has masked: **deploy-overlap double-writers**
and **live-key / live-token edge cases**.

This milestone is the deliberate **pre-cloud cleanup**: clear the code-addressable HIGH
blockers so M15 is a hosting/topology exercise, not a correctness scramble. Scope was
confirmed with the user as *pre-cloud blocker hardening* (M15 remains the cloud migration
itself). The Claude model migration is explicitly **out of scope** (user direction).

Verified against the live code (Explore sweep, 2026-06-03) — every item below is real and
quoted in "Findings" at the bottom.

**Locked scope decision (user):** ship the engine-wide single-writer **advisory lock** now
(code-only, closes the real deploy-overlap race). The `risk_state.updated_at` newer-wins
guard is **re-tagged** as a prerequisite of the *future multi-instance* milestone, not a
single-instance go-live blocker — under one always-on writer the lock already serializes all
writes, so newer-wins is redundant until two writers exist by design. **M20 stays
migration-free** (no live-soak schema change), mirroring M19's code-only discipline.

## Scope

### 1. Engine-wide single-writer advisory lock  *(HIGH — the core cloud precondition)*
The engine has **no** guard preventing a second instance from writing the same Postgres
(only domain-scoped `pg_advisory_xact_lock`s exist for boot-mode-history and paper-state).
On cloud, a rolling deploy or `restart: unless-stopped` overlap briefly runs two engines, both
holding Binance state and both writing `risk_state` / `positions` / `executions`.

- Add a boot-time **session-level** `pg_try_advisory_lock(<engine_global_key>)` held for the
  process lifetime.
- **Connection (security-H + logic-low):** the lock MUST be held on a **dedicated standalone
  `pg.Client`**, NOT a TypeORM/pooled connection. `dataSourceOptions.ts` sets no `extra.max` →
  the `pg` default pool is 10; a lock issued through a pooled `query()` is silently released when
  that connection is idle-reaped or recycled. Open one direct `pg.Client` at boot, hold it for
  the process lifetime, attach an `error`/`end` handler that **exits the process non-zero** (a
  dropped lock connection = lost lock with the process still up = silent double-writer).
- **Cloud landmine (security-H):** the lock connection must be a **direct Postgres connection,
  not through a transaction-pooling proxy** — PgBouncer `transaction` mode breaks session-level
  advisory locks. Call this out now since M15 is the cloud target.
- **Boot slot (logic-BLOCKER — corrected):** acquire the lock in `main.ts` **before
  `NestFactory.create()`**, on the dedicated client, then hand that client to DI. "Alongside the
  schema/key-permission gate" is too loose and the `OnApplicationBootstrap`-hook reading is
  **wrong**: NestJS dispatches AB hooks bottom-up, so `BootModeChainService` appends a
  `boot_mode_history` row *before* any `BootstrapModule` AB hook could acquire the lock. The lock
  must front-run **all four pre-`listen()` DB writers**: (1) `BootModeChainService` boot-mode
  chain row, (2) `KeyPermissionAssertionService` `control_audit` row, (3) `EngineBootstrapService`
  phase 2–4a recon / `RiskStateRepository.upsertDay` exposure write, (4) phase-7
  `account_snapshots`. A losing instance must exit before it touches the DB **or** the live
  exchange (so place it before the key-permission `/sapi` call too).
- If the lock is **not** acquired → log a single clear line (`another engine instance holds the
  single-writer lock against this database; exiting`) and exit non-zero.
- Session lock auto-releases when the connection dies → a crashed engine frees it for the
  restart; no stuck-lock cleanup. Document this property.
- New const `ENGINE_SINGLE_WRITER_LOCK_KEY` (BIGINT, distinct across the **shared 64-bit lock
  key space** from both existing xact-lock keys `0x5b3f…` / `0x4d7e…`, not just distinct-by-type).
- **Forward note in code + ADR:** when a future multi-instance milestone lands, this becomes
  *leader election* (losers stand by, not exit) — do not delete it.

### 2. Agent token lifetime  *(HIGH — weekly agent dies mid-run today)*
`AUTH_TOKEN_MAX_TTL_SEC = 900` (15 min), but the weekly agent runs up to a **45-min** wallclock
budget and holds one immutable bearer for the whole run → every MCP call after minute 15 fails
`EXPIRED`. The 15-min cap is correct for an **interactive operator**; the agent is **unattended
automation** and needs a token that strictly outlives its wallclock budget.

- Introduce a **separate, bounded agent-audience TTL cap** (e.g. `AGENT_TOKEN_MAX_TTL_SEC`,
  ≤ 90 min) used only when minting a token whose `aud` is the agent/MCP audience. The operator
  cap stays **15 min** unchanged; `AUTH_TOKEN_DEFAULT_TTL_SEC` stays 15 min so non-agent issuance
  never inherits the longer window.
- The CLI argv parser enforces the correct cap per audience (operator vs agent).
- **`cap > wallclock` is necessary but NOT sufficient (logic-H — corrected):** the token is
  minted out-of-band by the operator CLI (`exp = mintTime + ttl`) and dropped into
  `AGENT_MCP_BEARER`; the 45-min run starts when **cron** fires, possibly hours/days later, so
  remaining budget at run-start can be near zero. A bounded cap alone does not guarantee coverage.
  **Pick one (architect):**
  - (b) **MCP client refreshes / re-mints on `EXPIRED`** — the only option that fully closes the
    gap without moving the signing secret, OR
  - (c) **Mint-freshness guard** — the agent asserts at startup that `(exp - now) > wallclock +
    skew_margin` and **refuses to start with a clear "re-mint" operator message** otherwise (loud,
    pre-run, not a silent minute-N failure).
  Default to (c) if (b) is heavier than the milestone warrants; do **not** ship bounded-cap-only.
- **Clock skew (logic-H):** engine signs, MCP verifies — on separate cloud hosts post-M15 their
  clocks differ. Fold an explicit `skew_margin` into the cap-vs-budget invariant
  (`cap > wallclock + skew_margin`).
- **Least-privilege binding (security-H):** the CLI currently lets `--aud` and `--scope` be chosen
  independently. Bind them: an **agent/MCP-audience token must be rejected if it carries any
  non-read (write/control) scope**, and the long cap must be rejected for any non-agent audience.
  A 90-min token is a 6× larger leak window than today's 15-min — it is only acceptable on a
  read-only least-privilege token. Add a paired test: *agent audience + write scope → rejected*.

### 3. `AuthFailureReasonEnum.BAD_AUDIENCE` + `aud` enforcement  *(HIGH — live-smoke gap)*
The enum has no `BAD_AUDIENCE`; on an audience mismatch the MCP verifier emits `BAD_SCOPE`, and
the **engine `AuthGuard` ignores `aud` entirely** (M13 fix-wave-7 left audience-policy to
consumers). For go-live, an MCP-audience token replayed against the engine control API should be
rejected *as an audience failure*.

- Shared: add `AuthFailureReasonEnum.BAD_AUDIENCE = 'bad_audience'` (`bot-shared-maintainer`).
- Engine `AuthGuard`: validate `aud` against the engine's expected audience and emit
  `BAD_AUDIENCE` on mismatch.
- **Absent `aud` in LIVE → reject (security-H — corrected default):** do NOT grandfather
  absent-`aud` past go-live. In LIVE, a missing `aud` is rejected (`BAD_AUDIENCE`/`MALFORMED`);
  absent-allowed survives only in PAPER/TESTNET if legacy tokens must keep working. Schedule a
  **re-mint / revoke of pre-M13 absent-`aud` tokens** before LIVE rather than relying on the
  legacy path.
- MCP bearer verifier: emit `BAD_AUDIENCE` (not `BAD_SCOPE`) on `aud !== 'mcp'`.
  *(Ownership note: `apps/mcp` has no dedicated specialist agent — main session handles this edit
  directly or via `general-purpose`; `bot-engine-nestjs` owns only the engine `AuthGuard` half.)*

### 4. Key-permission response-shape presence assertion  *(HIGH — live-key safety)*
`KeyPermissionAssertionService` / `CcxtBinanceExchangeClient.toKeyPermissionSnapshot` defaults
missing fields to `false` via `boolFromPayload(..., false)` — added for PAPER **sub-account** keys
that legitimately omit fields.

**Reframed (logic + security review):** the original "mode-aware / PAPER-vs-LIVE-master" framing
is unsound — **sub-account-vs-master is orthogonal to `EXCHANGE_ENV`** (a LIVE run can use a
sub-account key; nothing in the response or config tells you which), and the shared predicate's
`mode` param is already a **no-op** (`_mode` unused). So strictness cannot key off an env flag.
Two genuinely distinct concerns, both env-independent:

- **(a) Required-true fields absent → malformed response, fail loud (regardless of env).** If
  `enableReading` / `enableFutures` (the fields that must be `true`) are **entirely absent** from
  the payload, that is an unexpected shape (error object, renamed field, empty body), not a denied
  permission — fail boot loud instead of letting `false`-default produce an ambiguous reject. Add
  a minimum-key-set / presence check in `toKeyPermissionSnapshot`.
- **(b) Capability-disable flags stay strict in ALL modes (incl. PAPER).** `enableWithdrawals`,
  `enableInternalTransfer`, `permitsUniversalTransfer`, `enableMargin` must never silently
  default-pass — **PAPER also uses a live Binance key** (paper = live key + simulated fills), so a
  withdrawal-enabled key is unacceptable in PAPER too. Keep the `false`-default **only** for the
  structurally-absent sub-account fields (e.g. `tradingAuthorityExpirationTime`, sub-account-mgmt),
  never for the capability-disable set. (Note: a missing capability flag defaulting `false` is the
  *safe* direction for the gate; the real risk is masking a *shape change* — covered by (a).)
- **Operational verification (no code):** hit the real LIVE `/sapi/v1/account/apiRestrictions`
  once, capture the actual field set (master *and* sub-account shapes if both are in play), confirm
  the predicate against it, and record the observed shape in the runbook.

### 5. Rate-limit drift `header-used ≈ 1` investigation  *(HIGH — incident follow-up)*
The M18 directional alert already silences the benign (over-conservative) direction; the
under-count direction is the genuine canary. Open question from the M17 incident: do public
market-data endpoints (klines/depth/OI/funding) tally against the **same** `x-mbx-used-weight`
IP ledger the local `REQUEST_WEIGHT_1M` bucket models, or a separate ledger (which would make
`header-used ≈ 1` a modelling artefact, not a real drift)?

- **Deliverable is primarily an investigation + findings note** (low code): instrument the
  reconcile path to log the endpoint class alongside `headerUsed`/`localUsed` for a short
  observation window, characterize whether the ledger is shared or segregated.
- **Conditional code:** *only if* a separate ledger is confirmed, model the affected endpoints as
  a distinct bucket class so the under-count alert stops false-firing. Otherwise close the
  tech-debt item as "benign, directional alert sufficient" with the evidence.

### Operational carry-over (no engine code — tracked to M20 close)
- **Apply the branch-protection payload** (`docs/runbooks/ci-gates.md`) — repo-owner action,
  must be done before any live merge (HIGH, still NOT applied).
- **M19 unrun follow-ups:** post-deploy stale-halt clear for today's `risk_state` via
  `HaltService` → `clearHaltForDate` (gated by pg_dump + explicit confirm per CLAUDE.md #8/#9);
  10-min live app smoke; behavioural soak-funnel re-check (`coin_book_too_thin` replacing the
  false `global_halt`).

### Explicitly deferred / re-tagged (not M20)
- `risk_state.updated_at` true newer-wins upsert → **re-tag in tech-debt** under a future
  *multi-instance / horizontal-scaling* milestone (redundant under single-writer + advisory lock).
  Logic review confirmed no within-process out-of-order `upsertDay` race exists today (the risk
  gate evaluates serially on the single event loop; no concurrent scheduled `upsertDay` writer).
  **But the deferral is conditional on the lock landing:** do NOT re-tag `updated_at` out of the
  HIGH blocker list until the second-instance-exits integration test is green — if Item 1 ships
  broken, newer-wins loses its only justification.
- `decisions(position_id, ts)` index (MEDIUM) → batch into a future schema-perf migration so M20
  stays migration-free (avoids a live-soak `pg_dump`/confirm gate this milestone).
- OI/funding burst "real-429 hardening" — confirmed rate-limiter-paced today; headroom sufficient,
  stays deferred.

## Change set

| Workspace | Files (representative) | Item |
|-----------|------------------------|------|
| `packages/shared/` | `src/enum/AuthFailureReasonEnum.ts` | 3 |
| `apps/engine/` | new boot-step + `const` (lock key); `src/auth/const/authConsts.ts` (agent TTL cap) + CLI argv parser + `AuthGuard`; `src/bootstrap/KeyPermissionAssertionService.ts` + `exchange/.../CcxtBinanceExchangeClient.ts` (mode-aware parse); `src/exchange/service/RateLimitPolicyService.ts` (reconcile instrumentation) | 1,2,3,4,5 |
| `apps/mcp/` | bearer verifier (emit `BAD_AUDIENCE`) | 3 |
| `apps/agent/` | confirm McpClient token usage against new cap (likely doc/test only) | 2 |
| docs | new ADR (single-writer lock); revise ADR 0020 §2.1 (agent TTL + `aud`); revise key-permission ADR; runbook (master-account shape, lock behavior) | all |

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`**: new ADR for the engine-wide single-writer advisory lock
   (incl. the "evolves into leader-election, do not delete" forward note); revise ADR 0020 §2.1
   (agent-audience TTL cap + `cap > wallclock` invariant; engine `aud` enforcement + `BAD_AUDIENCE`);
   revise the key-permission ADR (mode-aware strict-on-LIVE). Decide the agent-token approach
   (bounded cap vs refresh) and the absent-`aud` policy.
2. **Serial — `bot-shared-maintainer`**: `AuthFailureReasonEnum.BAD_AUDIENCE`.
3. **Parallel — `bot-engine-nestjs`** (lock boot-step, agent TTL cap + CLI + AuthGuard `aud`,
   KeyPermission mode-aware, rate-limit reconcile instrumentation) **+ main session / `general-purpose`**
   (apps/mcp verifier `BAD_AUDIENCE`). *No dashboard work this milestone.* Split engine work across
   two dispatches to respect the file cap (auth cluster vs lock+exchange cluster).
4. **Serial — `bot-qa-engineer`**: paired tests per item — second-instance-exits proof
   (mock/integration on the advisory lock), agent-token cap boundary + `cap > wallclock` guard,
   `BAD_AUDIENCE` emitted on wrong `aud` (engine + mcp), KeyPermission LIVE-mode missing-field
   loud-fail, rate-limit reconcile log shape.
5. **Parallel — reviewers**: `bot-review-security` (token TTL surface, `aud` enforcement, lock key,
   live-key parse) + `bot-review-logic` (boot-order correctness, lock acquire/exit path, fail-closed
   key parse) + `bot-review-clean-code`. *Quant optional* — only the rate-limit reconcile math touches
   anything quant-adjacent. Cycle fix→re-review until zero blockers, zero highs, majority mediums.
6. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/tech-debt.md` (close items 1/3/4/5-as-resolved; **re-tag** `updated_at` newer-wins under
   the multi-instance milestone; leave `decisions` index as deferred), runbook updates.

Orchestrator verifies the actual diff after every wave (agent summaries describe intent, not reality).

## DB safety (HARD — CLAUDE.md #8/#9)
**M20 engine work is migration-free** — no schema change, no soak-DB write. The advisory lock is a
runtime session lock, not DDL. The **only** DB touch is the operational M19 stale-halt clear
(single-row, today's `risk_state`), which requires a `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`,
into the gitignored `backups/` folder) + explicit user confirmation **before** running. No `-v`,
no down/revert on the live soak.

## Verification
- **Unit/integration:** full `apps/engine` suite green; new paired tests green; agent + mcp suites green.
- **Single-writer proof:** boot one engine (acquires lock), boot a second against the same DB →
  second logs the clear line and exits non-zero **before any of the four pre-`listen()` DB writers
  run** (assert no second `boot_mode_history` / `control_audit` / `risk_state` / `account_snapshots`
  row was written by the loser); kill the first → second can now acquire on restart.
- **Winner-connection-death proof (security-M):** sever the lock connection (not the process) while
  the engine runs → assert the engine crashes non-zero rather than continuing lockless.
- **Agent token:** assert the refresh-on-`EXPIRED` path (b) OR the mint-freshness guard (c) —
  a token whose remaining life `< wallclock + skew` either refreshes or refuses-to-start loud
  (never a silent minute-N failure); operator cap still 15 min; CLI rejects > cap per audience;
  **agent audience + write/control scope → rejected** (least-privilege binding).
- **`BAD_AUDIENCE`:** a token with wrong `aud` against the engine control API → 401 with reason
  `BAD_AUDIENCE`; same against MCP → `BAD_AUDIENCE` (not `BAD_SCOPE`).
- **Key-permission:** a response missing a **required-true** field (`enableReading`/`enableFutures`)
  → boot aborts loud as malformed (any env); a capability-disable flag (`enableWithdrawals` etc.)
  missing → still strict in PAPER and LIVE; structurally-absent sub-account fields → safe-default
  unchanged.
- **Rate-limit:** reconcile log carries endpoint class + header/local; findings note written;
  conditional bucket-class code only if a segregated ledger is confirmed.
- **Milestone close:** 10-min live app smoke (per `feedback-milestone-app-smoke`) — fix-and-report any
  boot/DI error before the scribe.

## Success criteria
- A second engine instance cannot write the soak/live DB — it exits cleanly; a crashed engine frees
  the lock for restart.
- The weekly agent completes a full run without token expiry; the operator cap stays 15 min.
- Wrong-audience tokens are rejected as `BAD_AUDIENCE` on both engine and MCP.
- A LIVE master-account response-shape surprise fails boot loud instead of passing an unvalidated key.
- The `header-used ≈ 1` drift question is answered with evidence (and modelled only if real).
- Branch protection applied; M19 operational follow-ups run (or explicitly scheduled).
- Zero blockers, zero highs, majority mediums resolved at close. M20 is migration-free.

## Plan-review outcomes (`bot-review-security` + `bot-review-logic`, 2026-06-03)
Both reviewers audited this plan against the live code before any implementation. Incorporated:
- **Logic BLOCKER ×2 — lock boot slot + pre-`listen()` writers.** Corrected Item 1: acquire in
  `main.ts` before `NestFactory.create()` (the AB-hook reading was wrong — `BootModeChainService`
  writes first); enumerated the four DB writers the lock must front-run; added the proof test.
- **Logic H — agent `cap > wallclock` insufficient.** Token mint-age + cron delay can leave a
  near-expired token at run start; Item 2 now mandates refresh-on-`EXPIRED` or a mint-freshness
  guard + clock-skew margin, not bounded-cap-only.
- **Logic M — Item 4 "mode" signal doesn't exist.** Reframed off PAPER-vs-master onto an
  env-independent required-field presence check + all-mode capability-flag strictness.
- **Security H ×3 — dedicated non-pooled lock client (+ death-handler exit), no PgBouncer
  transaction mode, reject absent-`aud` in LIVE + re-mint legacy, bind agent audience to
  read-only scopes.** All folded into Items 1–3.
- **Security/logic M — winner-connection-death test, deferral-conditional-on-lock.** Added.
- **Remaining MEDIUM (open):** confirm the existing rate-limiter covers the agent/MCP and engine
  control surfaces (login path has limits; control path coverage to verify during implementation).

The `bot-architect` wave (dispatch 1) must ratify the now-corrected decisions: lock boot slot,
agent-token approach (b vs c — default c), LIVE absent-`aud` rejection, and the Item-4 reframe.

## Findings (verified in code, 2026-06-03)
- **No engine-wide single-writer guard.** Only `pg_advisory_xact_lock` in
  `boot-mode-history/const/bootModeHistoryConsts.ts` (`0x5b3f…`) and
  `paper-mode/const/paperStateAuditConsts.ts` (`0x4d7e…`). `RiskStateRepository.upsertDay`
  (`apps/engine/src/risk/repository/RiskStateRepository.ts:47`) is an unconditional
  `ON CONFLICT(date) DO UPDATE` with no temporal guard.
- **Agent TTL mismatch.** `AUTH_TOKEN_MAX_TTL_SEC = 15*60` (`apps/engine/src/auth/const/authConsts.ts:12`);
  CLI enforces `ttlSec ≤ MAX` (`IssueRevokeCommands.ts`); agent holds one immutable bearer for a
  45-min wallclock run (`apps/agent/.../main.ts`, `runWeeklyLoop.ts`).
- **`BAD_AUDIENCE` absent.** `AuthFailureReasonEnum` (packages/shared) lacks it; `AuthGuard` checks
  signature/expiry/revocation/scope but **never `aud`** (`isWellFormedPayload` only type-checks `aud`);
  MCP verifier owns the `aud` check and emits `BAD_SCOPE`.
- **KeyPermission safe-default.** `boolFromPayload(..., false)` in
  `CcxtBinanceExchangeClient.toKeyPermissionSnapshot` defaults missing fields to `false` (added for
  PAPER sub-accounts); conservative, but masks an unexpected LIVE master-account shape.
- **Rate-limit reconcile.** `RateLimitPolicyService.reconcileClass` computes signed
  `underCountFraction = (headerUsed - localUsed)/capacity`; benign direction already silenced (M18);
  open question is shared-vs-segregated IP weight ledger for public market-data endpoints.
- **`clearHaltForDate`** (`RiskStateRepository.ts:35`) exists and is reachable via
  `POST /v1/control/resume` (`HaltController`, scope `HALT`) → the M19 stale-halt clear path.
