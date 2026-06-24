# M45 — Position-risk sizing integrity + risk-accounting hardening

> **Sequencing note:** M45 is a **trading-safety + correctness** milestone addressing the highest-priority
> tech-debt items accumulated across M31–M43. It is **not** a go-live milestone (M15 keeps that slot) and
> **not** a soak-gated milestone — no deliverable waits on accumulated fills. The milestone can begin as
> soon as M44's B5 soak gate closes; it can also run in parallel since none of the M45 deliverables depend
> on the shadow-fidelity verification result.
>
> **Safety invariants hold throughout.** No order path bypasses the risk gate. Strategies remain
> pure/deterministic. Money stays `decimal`. No LLM in the live loop. D1 (position sizer fix) is
> **sizing-only** — it does NOT move the VWAP structural stop (locked per ADR 0045 §D1). It can only
> reduce realized exposure per trade relative to the current engine state; the M1 tech-debt prerequisite
> ("forensics before any VWAP-stop change") is NOT triggered by D1 because D1 does not change the stop.
>
> **Scope rationale.** Six deliverables, clustered by risk surface: (D1) position-sizing correctness (H1),
> (D2) risk-state DB integrity (H2), (D3) risk-state accounting on ADD/halt (M4, M5), (D4) concurrent close
> race (M3), (D5) auth enum correctness (H5), (D6) branch protection ops gate (H7). All deliverables have
> investigation-first gates before implementation — D2, D3a, D3b showed significant code drift from the
> original tech-debt descriptions (see §D2 and §D3 root causes). All are code-confirmed or ops-confirmed by
> milestone close; no soak window required.

## Findings → scope decision (at a glance)

| # | Finding (tech-debt ref) | Severity | M45 scope |
|---|------------------------|----------|-----------|
| 1 | Position sizer uses `1.5×ATR` proxy stop; actual momentum stop is VWAP session (~4×ATR empirically); full stop-out exposes ~2.7× intended per-trade budget (H1) | **HIGH (live risk)** | **D1 — IN.** Investigation-first (D1.0); restructure `PositionSizer` to size off derived stop distance; add zero-denominator guard. |
| 2 | `risk_state` upsert is last-write-wins; concurrent writers can overwrite fresh accounting with a stale snapshot (H2) | **HIGH (pre-soak blocker)** | **D2 — IN (investigation-first, D2.0).** Confirm current repository state before implementing — code has drifted from tech-debt description (accounting-side race largely closed by existing `upsertAccountingForDay`). Fix the remaining full-row paths. |
| 3 | `persistHalt` uses full-row upsert including accounting fields; can clobber fresh accounting between load and write (M4) | **MEDIUM (race)** | **D3a — IN (investigation-first, D3.0).** Confirm exact column names and remaining full-row halt paths before implementing — `halt_source`/`halted` do not exist; actual columns are `is_halted`/`halt_reason`. |
| 4 | `RiskStateLifecycleListener` only recomputes `open_exposure` on open/close events; ADD and partial-reduce paths may leave exposure stale (M5) | **MEDIUM (accounting gap)** | **D3b — IN (shares D3.0 gate).** Confirm ADD/REDUCE don't already route through `adjustOpenExposure` before adding a recompute path — double-counting risk if delta path is already active. |
| 5 | Two close paths can both read `qty > 0` before either writes; `breachInFlight` covers monitor-vs-monitor only (M3) | **MEDIUM (race)** | **D4 — IN.** Per-position `closingInFlight` guard in `applyReduceFillToPosition`; must specify reservation-release and failure-path lifecycle. |
| 6 | JWT verifier uses `BAD_SCOPE` for audience mismatch; `BAD_AUDIENCE` enum value does not exist (H5) | **HIGH (auth correctness)** | **D5 — IN (trivial).** Add enum value; update verifier. |
| 7 | Branch protection rules documented in `docs/runbooks/ci-gates.md` not yet applied to repo (H7) | **HIGH (go-live gate)** | **D6 — IN (ops only).** Operator applies full §2 payload; scribe confirms all 10 checks + post-apply test merge. |
| — | H3, H4, H6, M1, M2, M6–M23, all LOW items | — | **OUT — see Non-goals.** |

---

## D1 (HIGH, live risk) — Position sizer vs momentum stop alignment

### Root cause (confirmed by M43 RR-sweep + code read)

`PositionSizer.ts` computes position size using `atr14 × atrStopMultiplier` (multiplier = 1.5) as the
stop-distance proxy (`PositionSizer.ts:51`). The actual momentum stop is the session VWAP
(`stopLossPrice: new Money(event.vwapSession)`, `momentumCore.ts:66`, `StopTypeEnum.STRUCTURAL`) —
empirically ~4×ATR from entry. The position is therefore sized for a 1.5×ATR loss but executes against a
~4×ATR structural stop: a full stop-out delivers ~2.7× the intended per-trade risk budget.

> **ADR 0045 §D1 constraint (locked):** the VWAP structural stop must NOT be moved. The fix is sizing-only.

> **Interface name (confirmed by code):** The sizing input is `ISizingInput` (`PositionSizer.ts:11`) — an
> engine-local interface, NOT in `packages/shared/`. Open question 1 is likely resolved: no shared-package
> touch is needed for D1. Confirm at D1.0 that `stopLossPrice` is absent from `ISizingInput` and needs to
> be added there (engine-only change).

### Investigation-first (D1.0 — no sizing code until complete)

bot-engine-nestjs must, before any implementation:

- **(a)** Confirm realized `|entry - stopLossPrice| / entryPrice` distribution from `positions` (closed
  momentum trades, tier1 only, `from ≥ M40-deploy`) to validate the ~4×ATR empirical estimate.
- **(b)** Compute `positionQty × stopDistance` vs `risked_usdt` — express as a concrete multiple.
- **(c)** Confirm `ISizingInput` does not yet carry `stopLossPrice`; confirm the fix is engine-local only.
- **(d)** Identify the minimum stop-distance floor for the new denominator guard (see A5 below) —
  e.g. 1 tick size, or a min-bps fraction of entry — and confirm decimal.js behavior on division
  by zero / Infinity inputs.

D1.0 findings go into the work-log.

### Fix (D1.1 — after D1.0)

1. Add `stopLossPrice: MoneyValue` (or `decimal`) to `ISizingInput` (engine-local).
2. Restructure `PositionSizer` to compute: `positionQty = riskedUsdt / |entryPrice - stopLossPrice|`.
3. Add a minimum-stop-distance guard before dividing: if `|entryPrice - stopLossPrice| < minStopDistance`
   (determined at D1.0), return `invalid_inputs` — do not produce an order.
4. Remove `atrStopMultiplier` from the sizing formula (retain as dead-code comment or delete per
   bot-engine-nestjs discretion).

### Acceptance criteria (D1)

- **A0:** D1.0 work-log entry confirms realized stop-distance multiple, `ISizingInput` engine-local
  finding, and the chosen `minStopDistance` floor.
- **A1 (sizing correctness):** unit test asserts `positionQty × |entry - stopLoss| ≈ riskedUsdt`
  (within fee tolerance) for a realistic momentum open with VWAP-derived stop.
- **A2 (stop value unchanged):** the VWAP stop **formula/value** in `momentumCore.ts` is unchanged —
  `stopLossPrice = new Money(event.vwapSession)` remains. (Note: `momentumCore.ts` may need a one-line
  wiring change to pass `stopLossPrice` downstream; the *computation* of the stop value must be
  byte-for-byte unchanged, not the file.)
- **A3 (determinism):** sizing is pure — no `Date.now()` / `Math.random()` / I/O.
- **A4 (decimal end-to-end):** `stopLossPrice` is typed as `Money` / `decimal` — NOT `number` — in
  `ISizingInput` and at every call site. A4 is satisfied only if the DTO field type is `decimal`, not
  if the sizer happens to call `decimal.dividedBy()` on a `number` input.
- **A5 (zero-denominator guard):** adversarial test: `stopLossPrice == entryPrice` → `invalid_inputs`
  returned, no position created. Adversarial test: `stopLossPrice` within one tick of `entryPrice` →
  either `invalid_inputs` or a qty capped by the guard. Adversarial test: `stopLossPrice` NaN /
  Infinity → `invalid_inputs`.

---

## D2 (HIGH, pre-soak blocker) — `risk_state` newer-wins upsert

### Root cause (H2, W2.4 from M11) — investigation required before fix

The tech-debt description states a "last-write-wins upsert." The current code has partially evolved past
this: `upsertAccountingForDay` (`RiskStateRepository.ts:55–71`) already column-scopes accounting writes
and omits halt columns. However, `persistHalt`, `setOpenExposureFromBoot`, and `adjustOpenExposure` still
call the full-row `upsertDay`, and `RiskStateEntity` does NOT have an `updated_at` column (the original
W2.4 proposal assumed one exists — it does not). This is a schema migration if newer-wins semantics
require a timestamp.

> **Critical:** The unique conflict key is `uq_risk_state_date` on `['date']` — NOT
> `(day, strategy_version_id)`. Any SQL must target the correct constraint.

### Investigation-first (D2.0 — mandatory)

bot-engine-nestjs must confirm before writing any code:

- **(a)** Enumerate every call site of `upsertDay` and confirm which still write accounting columns
  alongside halt columns.
- **(b)** Determine whether a newer-wins guard requires adding `updated_at` (migration) or can be
  expressed on an existing monotonic field (e.g. sequence/version) without migration.
- **(c)** Confirm whether the accounting-side race is already effectively closed by `upsertAccountingForDay`
  and whether the remaining gap is halt-writes-stale-accounting (the D3a gap, not a D2 gap).
- **(d)** Decide: if the remaining gap IS the D3a gap, D2 may reduce to "add `updated_at` to
  `RiskStateEntity` + apply the guard." Document the finding in the work-log.

### Fix (D2.1 — after D2.0)

Per D2.0 findings: either (a) add `updated_at` column + migration + newer-wins `ON CONFLICT … WHERE
risk_state.updated_at <= EXCLUDED.updated_at` guard on all upsert paths, or (b) if no new column is
needed, apply a comparable monotonic guard. The approach is bot-engine-nestjs's call after D2.0.

> **D2 + D3a coupling:** both deliverables interact through whatever timestamp/monotonic field guards the
> upsert. Implement and test them together in Wave 2 Batch A. Confirm the guard is present on **all**
> upsert paths (`upsertDay`, the new halt-only upsert from D3a, and `upsertAccountingForDay`).

### Acceptance criteria (D2)

- **B0:** D2.0 work-log entry states the exact remaining race, whether migration is needed, and the
  chosen monotonic guard field.
- **B1:** unit test: two sequential upserts where the second carries an older timestamp/sequence → the
  older snapshot does not overwrite the newer row values.
- **B2:** existing risk-state repository tests remain green.

---

## D3 (MEDIUM) — Risk-state accounting hardening

*M4 and M5 bundled: same `RiskGateService` / `RiskStateLifecycleListener`, same investigation gate.*

### D3.0 — Investigation (mandatory before D3a and D3b)

bot-engine-nestjs must confirm before implementing either sub-item:

- **(a) D3a:** Read `persistHalt` (`RiskGateService.ts:957`) and confirm it still calls full-row `upsertDay`
  including accounting columns. Confirm actual column names on `RiskStateEntity` (`is_halted`,
  `halt_reason` — NOT `halted`, `halt_source`, or `updated_at`). Identify the exact set of columns the
  new halt-only upsert should write.
- **(b) D3b:** Confirm whether ADD/REDUCE intents already route through `adjustOpenExposure`
  (`RiskGateService.ts:405`). If they do, firing an additional recompute on ADD would **double-count**
  exposure. The D3b fix may be a no-op, or may target a different gap (e.g. ADD emits `open_exposure`
  delta but no lifecycle event → `risk_state` not persisted until next open/close event).

### D3a — `persistHalt` halt-column-only upsert (M4, after D3.0)

`persistHalt` currently calls full-row `upsertDay({ ...base, isHalted, haltReason })` — the accounting
side of the base snapshot can be stale by the time the await resolves, clobbering a fresher
`upsertAccountingForDay` write from the listener.

**Fix:** add a `upsertHaltForDay` primitive to `RiskStateRepository` (symmetric mirror of
`upsertAccountingForDay`) writing only `is_halted` / `halt_reason` (and the upsert's monotonic guard
field per D2.1). `persistHalt` calls this instead of `upsertDay`.

### D3b — ADD/partial-reduce exposure recompute (M5, after D3.0)

**Fix (conditional on D3.0(b)):** if ADD/REDUCE do NOT already route through `adjustOpenExposure`, add
a recompute trigger from those paths. If they DO route through `adjustOpenExposure` but `risk_state` is
not persisted until the next lifecycle event, fire a scoped `upsertAccountingForDay` at end of the
ADD/partial-reduce handler (not a full recompute that could interfere with the delta path).

### Acceptance criteria (D3)

- **C0:** D3.0 work-log entry confirms actual column names, remaining full-row paths, and whether D3b is
  a recompute or a persistence trigger.
- **C1 (D3a):** halt-only upsert writes `is_halted`, `halt_reason`, and the D2 monotonic guard field;
  does NOT write `realized_pnl_day`, `open_exposure`, or `trades_count`. Test: a `persistHalt` call
  following a concurrent accounting update leaves the fresh accounting values intact.
- **C2 (D3b, conditional):** if D3.0 finds a gap: ADD fires → `open_exposure` in `risk_state` reflects
  updated notional within the same or next-tick window. If D3.0 finds the gap is already closed,
  record as resolved in the work-log and ship no code for D3b.
- **C3:** existing halt and lifecycle listener tests remain green.

---

## D4 (MEDIUM) — Concurrent double-close race in `applyReduceFillToPosition`

### Root cause (M3, logged M31)

`ExecutionService.applyReduceFillToPosition` reads the position row (`qty > 0`) before writing the
close. Two concurrent close intents can both pass the guard. `LocalProtectiveMonitor.breachInFlight`
covers monitor-vs-monitor; the monitor-vs-strategy-close cross-path race is unguarded.

`LocalProtectiveMonitor.ts:244` shows the established pattern: `breachInFlight` has an explicit
disarm listener that fires on failure — "WITHOUT this listener, `breachInFlight` stays set forever."
The `closingInFlight` set must follow the same lifecycle contract.

### Fix

Add `closingInFlight: Set<string>` (keyed by `positionId`) to `ExecutionService`. Before proceeding
with a close:

1. If `positionId` is in `closingInFlight`, abort and return — **do not release the slot** (the winning
   caller owns the release).
2. Otherwise, add to `closingInFlight` inside a `try` block.
3. On completion **or failure**, remove from `closingInFlight` in the `finally` block — never leave the
   set permanently populated after an error.

> **Single-replica invariant:** this guard is correct for the current single-process deploy only. A
> boot-time config assertion or a compile-time enforcement should ensure this is visible if horizontal
> scaling is introduced. If multi-replica deploy is planned before go-live, replace with a DB-level
> advisory lock.

### Acceptance criteria (D4)

- **D1:** adversarial test: two simultaneous `applyReduceFillToPosition` calls on the same `positionId`
  → exactly one proceeds; the second returns without throwing, without emitting a `POSITION_CLOSED_EVENT`,
  and without touching the slot/exposure ledger.
- **D2 (exactly-once release):** after a deduped double-close attempt, `open_exposure` and the
  reservation ledger reflect exactly one release — no double-free, no under-release.
- **D3 (failure-path lifecycle):** test: first close attempt throws after adding to `closingInFlight`
  → entry is removed from the set in the `finally` block → a subsequent close attempt on the same
  position succeeds normally (no permanently stuck position).
- **D4:** existing execution + reconciliation tests remain green.

---

## D5 (HIGH, trivial) — `AuthFailureReasonEnum.BAD_AUDIENCE` value

### Root cause (H5)

`AuthFailureReasonEnum` has no `BAD_AUDIENCE` value. The JWT verifier uses `BAD_SCOPE` for audience
mismatch (`bearerVerifier.ts:143`). Confirmed by code read: the value is never persisted (not in JWT
payload, not in any DB column) — only used in response bodies and log strings. Adding a new enum member
is purely additive; no backwards-compat shim is needed for existing tokens or audit records.

### Fix

1. Add `BAD_AUDIENCE = 'bad_audience'` to `AuthFailureReasonEnum`. If the enum is in `packages/shared/`,
   route through `bot-shared-maintainer` in Wave 1; if engine-local, engine wave suffices.
2. Update the JWT audience check to emit `BAD_AUDIENCE`.
3. Confirm any dashboard / alert-routing consumer handles unknown enum values gracefully (forward-compat
   — new value reaches the client before client redeployment).

### Acceptance criteria (D5)

- **E1:** existing verifier tests pass; a new test confirms audience-mismatch rejection emits
  `AuthFailureReasonEnum.BAD_AUDIENCE`.

---

## D6 (HIGH, ops) — Branch protection apply

### Context (H7)

Branch protection rules are documented in `docs/runbooks/ci-gates.md` §2 and were scheduled to be
applied in M14. They remain unapplied. `ci-gates.md §2` encodes ADR 0039 §2.6: ten named required
status checks (exact strings), `strict: true`, linear history, no admin bypass, require PR, require
conversation resolution.

### Action (operator, not a code change)

The **repo owner** applies the full `ci-gates.md §2` payload via GitHub repo settings. The **scribe**
records the confirmation in `docs/work-log.md` and removes H7 from `docs/tech-debt.md`.

> **Lock-out warning:** With `strict:true` and no admin bypass, a misspelled required check name will
> block all PRs to `main` with no override. Before recording F1 as done, the operator MUST perform the
> post-apply verification step (F2) below.

### Acceptance criteria (D6)

- **F1:** work-log entry records the exact applied payload confirming: all 10 required status check
  names from `ci-gates.md §2` (exact strings), `strict: true`, linear history enforced,
  `enforce_admins` (no admin bypass), PR review required, conversation resolution required.
- **F2 (post-apply test merge):** operator opens a trivial PR (e.g. single-line comment), confirms
  all required checks run and pass, and merges it successfully. This verifies no check name is
  misspelled and no lock-out condition exists. Work-log records the PR number and merge outcome.

---

## Non-goals

| Tech-debt ref | Reason for deferral |
|---------------|---------------------|
| H3 (API key shape) | Requires live master-account key validation; belongs in M15 pre-gate checklist |
| H4 (rate-limit drift) | Complex cross-system root cause; warrants a dedicated monitoring milestone |
| H6 (agent token TTL 900s) | No live trade path impact; defer to agent hardening milestone |
| M1 (sl_outside_liquidation forensics) | Analysis query only; not triggered by D1 (D1 is sizing-only, does not move the VWAP stop) |
| M2 (live/backtest idiosyncrasy diverge) | Requires backtest re-baseline + parity suite; own milestone |
| M6 (decisions.position_id) | Analytics convenience; not blocking any live or soak path |
| M7 (MAE/MFE seed-timing) | Complex async fix; own milestone |
| M8 (B6 window discipline) | Analysis-layer guard; deferred to next analysis pass |
| M9 (M15 soak evaluator) | Belongs in M15 scope |
| M10–M23, all LOW items | Out of scope for M45 |

> **Post-M45 follow-up (D1):** once D1 corrects position sizing to the true VWAP stop distance,
> realized exit slippage on the wider effective stop becomes more material. Revisit M13 (entry-vs-exit
> depth gap) and M22 (depth-floor recalibration) against post-M45 fill telemetry.

---

## Open questions

1. **D1 interface:** `ISizingInput` is engine-local (`PositionSizer.ts:11`); no shared-package touch
   expected. Confirm at D1.0 that `stopLossPrice` only needs to be added to `ISizingInput` and wired
   through the momentum call site (engine-only change, no Wave 1 shared-maintainer gate on D1).
2. **D2 migration:** does newer-wins require adding `updated_at` to `RiskStateEntity` (schema migration)
   or can it use an existing monotonic field? D2.0 resolves this; if migration, scribe adds a migration
   note to the dispatch sequence.
3. **D3b event vs direct call:** if D3.0(b) finds a recompute is needed, prefer a direct
   `upsertAccountingForDay` call over a new event to avoid indirection unless decoupling is warranted.
4. **D4 multi-replica:** if horizontal scaling is planned before go-live, replace `closingInFlight`
   with a DB advisory lock before M15. Architect flags this to the DevOps milestone if the timeline
   accelerates.

---

## Dispatch sequence

Follow `docs/best-practices/dev-qa-cycle.md`. Max 5 files per wave.

**Wave 0 — Investigations (serial; ALL must complete before Wave 2)**
- bot-engine-nestjs: D1.0 (PositionSizer + soak DB); D2.0 (RiskStateRepository race audit); D3.0
  (persistHalt columns + ADD/REDUCE path audit). Output to work-log. **No code changes in Wave 0.**

**Wave 1 — Shared contracts (serial, after Wave 0)**
- bot-shared-maintainer: `BAD_AUDIENCE` to `AuthFailureReasonEnum` (D5); confirm `ISizingInput` is
  engine-local and no shared-package touch is needed for D1 (expected outcome of D1.0 open question 1).

**Wave 2 — Engine implementation (two parallel batches, after Wave 0 + 1)**
- **Batch A** — bot-engine-nestjs: D1.1 (`ISizingInput` + `PositionSizer` stop-distance + zero-guard);
  D2.1 (`RiskStateRepository` newer-wins upsert per D2.0 findings). *(D2 + D3a share the monotonic
  guard field — implement and test together.)*
- **Batch B** — bot-engine-nestjs: D3a (`upsertHaltForDay` primitive + `persistHalt` wiring per D3.0);
  D3b (ADD/partial-reduce recompute if D3.0 finds a gap); D4 (`closingInFlight` guard + failure-path
  lifecycle); D5 verifier update (after Wave 1).

**Wave 3 — QA (serial)**
- bot-qa-engineer: D1 sizing invariant + zero-denominator adversarial tests; D2 upsert-ordering test;
  D3a halt-isolation test + `updated_at`/guard-field assertion; D3b ADD recompute test (if applicable);
  D4 adversarial double-close + exactly-once release + failure-path stuck-position tests; D5 audience
  emission test.

**Wave 4 — Review (parallel)**
- bot-review-quant: D1 sizing math (decimal, `riskedUsdt` invariant, no float, zero-guard boundary).
- bot-review-logic: D1 stop-distance derivation; D2 upsert semantics; D3 accounting race; D4 close
  race + slot-release; dispatch investigation gates.
- bot-review-security: D1 `stopLossPrice` decimal end-to-end (A4); D4 `closingInFlight` scope; D5
  enum + verifier forward-compat; D6 F1/F2 completeness.
- bot-review-clean-code: D1–D5 conventions per `docs/best-practices/code-conventions.md`.

**Wave 5 — Docs (serial)**
- bot-scribe: remove H1, H2, H5, H7 from `docs/tech-debt.md` on confirmed completion; update M3→M5
  status; update `docs/work-log.md`; rewrite `docs/STATUS.md` at milestone close.

**D6 (ops, out-of-band):** operator applies branch protection + performs F2 test merge; scribe records.
