# M36 — Paper soak consecutive-loss-halt relaxation (disable 2-loss day-halt; keep full-day position flow + labeled-outcome collection)

> **Sequencing note:** M36 is a small, surgical paper-soak enablement change in the lineage of the
> M24→M25→M26→M27 data-fix arc and the M29 funnel work. It adds **one** new env flag,
> `PAPER_RELAX_CONSECUTIVE_LOSS_HALT`, that — when active (`EXCHANGE_ENV=paper` **AND** flag=`true`) —
> disables the consecutive-loss halt in both the **live risk gate** and the **shadow virtual ledger**.
> It replicates the exact two-condition pattern already locked for `PAPER_RELAX_MARKET_STRESS`
> (M25, ADR 0042). **Every relaxation is gated on `EXCHANGE_ENV=paper`**; live, testnet, and backtest
> defaults are byte-identical to pre-M36, preserving the live/backtest determinism contract
> (ADR 0029, ADR 0032) and the trading-safety invariants in `CLAUDE.md`. This is a deliberate,
> visible **risk-loosening for exploration data collection only** — not a change to live risk posture.

## Context

The risk gate blocks all new positions for the rest of a UTC day after just **2 consecutive closed
losses** (`CONSECUTIVE_LOSS_HALT_COUNT = 2`, `apps/engine/src/risk/const/riskConsts.ts:46`). The
identical threshold is mirrored on the shadow virtual ledger
(`VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD = 2`, `apps/engine/src/strategy/const/strategyConsts.ts:61`,
and `SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES = 2`, same file line 77), so shadow decisions halt at
the same point on the same tape.

**This is correct for restricted live capital** — after two losses in a day the conservative posture
is to stand down. But during a paper *exploration* soak whose whole purpose is to accumulate labeled
win/loss outcomes, a 2-loss day-halt **starves the data-collection pipeline**:

- Both yesterday and today halted after the **2nd** trade.
- The halt then **blocked 128 entry attempts over 7 days** — every one of those is a missing labeled
  outcome the calibration pipeline never sees.

A 2-loss halt is exactly the kind of threshold that is *protective on live capital* and
*counter-productive in paper exploration*, where some losing trades are the data we are paying to
collect. M36 adds a paper-only opt-out so the soak can run the full day and keep producing outcomes.

### Why the same precedent applies

`PAPER_RELAX_MARKET_STRESS` (M25, ADR 0042) already established the exact pattern this milestone
reuses:

- A flag that is **effective only when `EXCHANGE_ENV=paper` AND the flag is `true`** (two-condition
  gate, ADR 0042 §1).
- Strict boolean parse (exact `'true'`, case-insensitive, trimmed), **default-off** in code.
- A typed getter on `AppConfigService` whose private resolver logs a warning and **neutralizes** the
  flag if it is set under a non-paper env, so a live/testnet boot is byte-identical to before.

M36 clones that machinery for consecutive-loss halts. No new pattern is invented.

### The two enforcement surfaces (read carefully — there are TWO on the shadow side)

| Surface | Where | How it halts | What M36 must do |
|---|---|---|---|
| **Live gate** | `RiskGateService.checkLossWindows()` → `isConsecutiveLossHalt()` → `persistHalt()` | Counts trailing closed-loss streak today; if `>= CONSECUTIVE_LOSS_HALT_COUNT`, writes a durable `consecutive_loss_halt` `risk_state` row and rejects | Skip the `isConsecutiveLossHalt()` check (and therefore its `persistHalt`) when relax is active |
| **Shadow gate (per-call)** | `VirtualPositionLedgerService.evaluateGates()` reads `input.haltAfterConsecutiveLosses` | If `consecutiveLosses >= input.haltAfterConsecutiveLosses` → reject `'halt_after_consecutive_losses'` | Pass a sentinel so the comparison can never trip |
| **Shadow gate (durable arm)** | `VirtualPositionLedgerService.maybeArmConsecutiveLossHalt()`, called inside `tryClose()`, compares the streak against `VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD` and sets `haltedUntilRiskDayUtcDate` | A later `evaluateGates()` then short-circuits via `isHalted()` → reject `'halted'` | **Must ALSO be bypassed** — a sentinel on `evaluateGates` alone is insufficient, because the durable arm would still set the halt flag and `isHalted()` would reject with `'halted'` |

> **Load-bearing subtlety:** suppressing only `evaluateGates`' per-call threshold leaves the shadow
> ledger still arming its durable `haltedUntilRiskDayUtcDate` flag on close — which then rejects via
> the separate `'halted'` path. **Both** the per-call check **and** the durable arm must be neutralized
> for the shadow relaxation to actually take effect. The engine wave must verify this end-to-end, not
> just the `evaluateGates` branch.

## Goal

When `EXCHANGE_ENV=paper` **and** `PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true`, the consecutive-loss halt
is disabled on **both** the live risk gate and the shadow virtual ledger, so a paper soak no longer
day-halts after 2 losses and keeps generating labeled outcomes. In every other env, and whenever the
flag is unset/false, behaviour is **byte-identical to pre-M36**.

## Design decisions to lock

### D1 — Two-condition gate, cloned from M25/ADR 0042 (the only switch)

The relaxation is effective **only** when `EXCHANGE_ENV=paper` **AND**
`PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true`. It is default-off in code, opt-in via the paper `.env`. A
live or testnet boot can never see it on. A non-paper boot is byte-identical to pre-M36.

- New env field `PAPER_RELAX_CONSECUTIVE_LOSS_HALT: boolean = false` on `EnvironmentVariables`, with
  `@IsOptional()` + `@Transform(({ value }) => String(value).toLowerCase().trim() === 'true')` +
  `@IsBoolean()` — **identical decorator stack** to `PAPER_RELAX_MARKET_STRESS`
  (`EnvironmentVariables.ts:270-273`).
- New typed getter `get paperRelaxConsecutiveLossHalt(): boolean` on `AppConfigService`, backed by a
  private resolver `resolvePaperRelaxConsecutiveLossHalt()` that mirrors
  `resolvePaperRelaxMarketStress()` (`AppConfigService.ts:580-593`) exactly: returns
  `flagEnabled && isPaperEnv`, and logs the same "NEUTRALIZED" warning when the flag is set under a
  non-paper env.
- **No risk/strategy service reads `process.env` directly** — everything routes through the typed
  getter (conventions + ADR 0042 §A3).

### D2 — Live gate: skip the consecutive-loss check before `persistHalt`

In `RiskGateService.checkLossWindows()`, when `this.appConfig.paperRelaxConsecutiveLossHalt` is true,
**skip the `isConsecutiveLossHalt()` block entirely** (the `if (await this.isConsecutiveLossHalt(...))`
guard at `RiskGateService.ts:922-926`). Because the skip happens **before** `persistHalt`, no
`consecutive_loss_halt` row is written when the check is skipped (see D5).

- **Daily-loss and weekly-loss limits stay fully active.** The `dailyLossLimitUsdt` check
  (`RiskGateService.ts:909-911`) and the `weeklyLossLimitUsdt` check (`RiskGateService.ts:918-920`)
  are **not** touched. M36 relaxes only the *consecutive-loss-count* halt, never the realized-PnL
  loss windows.
- Cleanest shape: gate just the consecutive-loss `if` block on `!this.appConfig.paperRelaxConsecutiveLossHalt`
  (e.g. an early `if (this.appConfig.paperRelaxConsecutiveLossHalt) return null;` placed **after** the
  daily/weekly checks and **before** the consecutive-loss check, or a guard on the consecutive-loss
  `if`). The engine agent picks whichever keeps `checkLossWindows` readable and one-level-of-abstraction;
  the daily/weekly checks must remain unconditionally evaluated first.

### D3 — Shadow per-call gate: pass a relax sentinel

When relax is active, `ShadowStrategyOrchestratorService` passes a sentinel value as
`haltAfterConsecutiveLosses` to `evaluateGates` (line 265) so the per-call comparison
`consecutiveLosses >= input.haltAfterConsecutiveLosses` can never trip.

- Introduce a **named constant** in `strategyConsts.ts`, e.g.
  `SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL = Number.MAX_SAFE_INTEGER`, with a comment explaining it
  is the paper-relax sentinel (an unreachable streak). **Do not** inline a bare
  `Number.MAX_SAFE_INTEGER` (no magic numbers, conventions §Constants Placement).
- The orchestrator reads `this.config.paperRelaxConsecutiveLossHalt` (it already injects
  `AppConfigService` as `this.config`, constructor line 127) and chooses between
  `SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES` (relax off) and the sentinel (relax on). Threading this
  one extra config read keeps the relaxation decision at the orchestrator (the highest level that knows
  the env), not buried in the ledger — consistent with how `strategyConsts.ts` already documents the
  threshold as "a caller-side update".

### D4 — Shadow durable arm: bypass `maybeArmConsecutiveLossHalt` when relax is active

The `VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD` const (used in `maybeArmConsecutiveLossHalt`,
`VirtualPositionLedgerService.ts:364-377`) **must also be bypassed** when relax is active, otherwise the
durable `haltedUntilRiskDayUtcDate` flag is still armed on close and `evaluateGates` rejects via the
separate `'halted'` path (defeating D3).

**Decision — make the arming threshold a per-call input, not a skip of the arm logic.** The cleanest,
most consistent option is to thread the *effective* consecutive-loss threshold into the ledger the
same way `evaluateGates` already takes `haltAfterConsecutiveLosses` per call:

- Add the effective threshold to the close path so `maybeArmConsecutiveLossHalt` compares the streak
  against the **same** threshold the gate uses (the sentinel when relax is on, `2` when off), rather
  than reading the module-level `VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD` directly.
- Concretely: carry the effective threshold on `IVirtualCloseInput` (or a small ledger-level config set
  once by the orchestrator when it resolves each shadow), so `maybeArmConsecutiveLossHalt` uses
  `streak >= effectiveThreshold`. With the sentinel, the arm can never fire; the durable halt is never
  set; `evaluateGates` never rejects with `'halted'`.
- This keeps the single-source-of-truth principle the const comment already states ("the gate does not
  hold the threshold itself — the gate input does") and avoids a divergent "skip the arm" code path
  that could drift from the gate's own check.

> **Rejected alternative for D4:** a bare `if (relaxActive) return;` at the top of
> `maybeArmConsecutiveLossHalt`. It works, but it introduces a *second* place that knows about the
> relax flag and a second predicate that could drift from `evaluateGates`. Threading one effective
> threshold keeps both surfaces reading the same number. The engine agent may still choose the guard
> if threading the input proves to balloon the change surface — but it must then add a paired test
> proving the durable arm and the per-call gate agree under relax.

### D5 — Persisted halt reason is unchanged; no `consecutive_loss_halt` row is written when skipped

Because D2 skips the consecutive-loss check **before** `persistHalt`, the live path **does not** write
a `consecutive_loss_halt` row to `risk_state` when relax is active. M36 adds **no** new halt reason,
no new `risk_state.halt_reason` value, and no schema change. `RejectReasonEnum.CONSECUTIVE_LOSS_HALT`
stays exactly as-is (still emitted in non-paper envs and whenever the flag is off). The existing
`market_stress:<leg>` suffix machinery is untouched.

### D6 — No shared-package, no migration, no new reject reason

- **No `packages/shared/` change.** No new enum value, no schema change. (`IVirtualCloseInput` /
  `IVirtualGateInput` are engine-internal interfaces under `apps/engine/`, not shared — confirm
  before editing; if either turns out to live in `packages/shared/`, route through
  `bot-shared-maintainer` first per CLAUDE.md hard-rule 5.)
- **No migration.** M36 is migration-free; the only DB interaction is the operational halt-clear at
  deploy (see DB safety).

## Out of scope

- **Daily-loss limit** (`DAILY_LOSS_LIMIT_USDT` / `dailyLossLimitUsdt`) — stays fully active.
- **Weekly-loss limit** (`WEEKLY_LOSS_LIMIT_USDT` / `weeklyLossLimitUsdt`) — stays fully active.
- **Market-stress relaxation** — that is M25 / `PAPER_RELAX_MARKET_STRESS`; M36 does not touch
  `StressHaltEvaluator`, the stress legs, or M23 auto-resume.
- **Cooldown-after-loss** (`COOLDOWN_AFTER_LOSS_MS`), overtrading caps, exposure caps, slot model.
- **Dashboard / UI** — no new surface. (A read-only note may be added later if an operator needs to
  *see* the relax state; defer unless asked.)
- **Shared-package changes** — none (D6).
- **Changing the live default of `2`** — `CONSECUTIVE_LOSS_HALT_COUNT`,
  `VIRTUAL_LEDGER_CONSECUTIVE_LOSS_HALT_THRESHOLD`, and `SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES`
  all stay `2`. M36 only adds a paper-gated *opt-out*, never re-tunes the live threshold.

## Paper-gating semantics (lock before QA)

- **`EXCHANGE_ENV=paper` is the single switch.** The relaxation is a no-op unless `EXCHANGE_ENV=paper`
  **and** `PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true`. Default-off in code.
- **Non-paper boot is byte-identical to pre-M36** — proven against a fixture table (live + testnet),
  asserting the same reject reasons and the same `risk_state` writes as today.
- **Gate path intact.** No relaxation bypasses `RiskGateService` — every intent still flows through
  the gate; M36 loosens one *threshold check*, never the *path*. The "no order path bypasses the risk
  gate" invariant holds.
- **Daily/weekly loss windows untouched** in every env.
- **Typed config only.** The flag is read via `AppConfigService`; no risk/strategy service reads
  `process.env` directly. `validateEnv` covers the new var; string `"false"` is not truthy.

## Change set

| Workspace | Files (representative) | Decision |
|---|---|---|
| `apps/engine/` | `src/config/EnvironmentVariables.ts` (add `PAPER_RELAX_CONSECUTIVE_LOSS_HALT: boolean = false` with the M25 decorator stack) | D1 |
| `apps/engine/` | `src/config/service/AppConfigService.ts` (add `get paperRelaxConsecutiveLossHalt()` + private `resolvePaperRelaxConsecutiveLossHalt()`, cloned from the `paperRelaxMarketStress` pair) | D1 |
| `apps/engine/` | `src/risk/service/RiskGateService.ts` (`checkLossWindows`: skip the `isConsecutiveLossHalt`/`persistHalt` block when relax active; daily/weekly checks unchanged) | D2, D5 |
| `apps/engine/` | `src/strategy/const/strategyConsts.ts` (add `SHADOW_GATE_CONSECUTIVE_LOSS_RELAX_SENTINEL`) | D3 |
| `apps/engine/` | `src/strategy/service/ShadowStrategyOrchestratorService.ts` (choose sentinel vs `SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES` for `haltAfterConsecutiveLosses`, and thread the effective arm threshold) | D3, D4 |
| `apps/engine/` | `src/strategy/service/VirtualPositionLedgerService.ts` (`maybeArmConsecutiveLossHalt` compares against the effective threshold from the close input, not the bare const) | D4 |
| config | `.env.example` (document `PAPER_RELAX_CONSECUTIVE_LOSS_HALT` with the paper-only, default-off caveat, alongside `PAPER_RELAX_MARKET_STRESS`) | D1 |
| `apps/engine/` (tests) | risk-gate + shadow-ledger + config specs (relax on/off; non-paper + testnet unchanged; daily/weekly still halt; durable arm bypassed under relax; `validateEnv` for the new var) | QA |
| docs | `docs/plans/README.md` (add M36 row); `docs/plans/M36.md` (this file) | scribe (README row added with this plan) |

No `packages/shared/` change, no migration, no new reject reason (D6).

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

> **Architect first — this loosens a risk gate.** Per dev-qa-cycle, a risk-gate-loosening change gets
> an architect pass before code. The scope is narrow (clone of an existing pattern), so the architect
> pass is a short **ADR 0042 amendment** rather than a new ADR.

1. **Serial — `bot-architect`**: amend **ADR 0042** (paper exploration profile) to add the
   consecutive-loss relax leg: the two-condition gate (D1), the live-gate skip-before-persist (D2, D5),
   the shadow two-surface bypass (D3 sentinel + D4 durable-arm threshold), and the explicit statement
   that **daily/weekly loss windows and live defaults are unchanged**. Record the per-surface relax
   table (the three rows above) so the bypass cannot silently miss the durable arm.
2. **Parallel after the ADR** (two independent ≤5-file dispatches; they touch disjoint files):
   - **`bot-engine-nestjs` Dispatch A (config plumbing, D1):** add `PAPER_RELAX_CONSECUTIVE_LOSS_HALT`
     to `EnvironmentVariables` + the typed getter/resolver on `AppConfigService` — strict boolean
     parse, default-off, non-paper neutralization warning.
   - **`bot-engine-nestjs` Dispatch B (gate + ledger, D2/D3/D4/D5):** `RiskGateService.checkLossWindows`
     skip; `strategyConsts` sentinel; `ShadowStrategyOrchestratorService` sentinel selection + effective
     arm threshold; `VirtualPositionLedgerService.maybeArmConsecutiveLossHalt` reads the effective
     threshold. (If A and B share the `AppConfigService` getter and would collide, run them serial
     A→B instead.)
   - **`devops`** (parallel, independent file): document `PAPER_RELAX_CONSECUTIVE_LOSS_HALT` in
     `.env.example` with the paper-only / default-off caveat.
3. **Serial — `bot-qa-engineer`**: paired tests per fix item (see Success criteria).
4. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant`. Security/logic own the **paper-gating proof** (no relaxation leaks to live,
   testnet, or backtest; both shadow surfaces actually neutralized). Quant owns whether the relaxed
   profile still yields analyzable data (more outcomes, not garbage). Cycle fix → re-review until zero
   blockers, zero highs, majority mediums.
5. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, `docs/STATUS.md`, the ADR
   0042 amendment link, and the `00-overview.md` RiskModule note (paper exploration profile now also
   relaxes the consecutive-loss halt). **`docs/STATUS.md` is the scribe's job at close — not touched by
   this plan.**

Orchestrator verifies the actual diff after every wave and **explicitly confirms**: (a) the relaxation
is `EXCHANGE_ENV=paper`-gated and default-off — a non-paper/testnet boot is byte-identical to pre-M36;
(b) **both** shadow surfaces (per-call `evaluateGates` and the durable `maybeArmConsecutiveLossHalt`)
are neutralized under relax; (c) daily/weekly loss windows still halt in every env; (d) no
`packages/shared/` change, no migration, no new reject reason.

## Success criteria / acceptance tests

- **Live gate relax on:** `EXCHANGE_ENV=paper` + flag set, a closed-loss streak `>= 2` does **not**
  produce a `CONSECUTIVE_LOSS_HALT` reject and **no** `consecutive_loss_halt` `risk_state` row is
  written.
- **Live gate relax off / non-paper / testnet:** flag unset, or `EXCHANGE_ENV ∈ {live, testnet}` →
  **identical** behaviour to pre-M36 (a 2-loss streak still halts and still writes the
  `consecutive_loss_halt` row). Regression-guarded against a fixture table.
- **Daily/weekly still halt under relax:** with relax active, a breach of `dailyLossLimitUsdt` still
  returns `DAILY_LOSS_LIMIT`, and a breach of `weeklyLossLimitUsdt` still returns `WEEKLY_LOSS_LIMIT`.
- **Shadow per-call gate relax on:** `evaluateGates` does **not** reject with
  `'halt_after_consecutive_losses'` when relax is active (sentinel threshold).
- **Shadow durable arm relax on:** after a 2-loss streak with relax active, `maybeArmConsecutiveLossHalt`
  does **not** set `haltedUntilRiskDayUtcDate`, so a later `evaluateGates` does **not** reject with
  `'halted'`. (This is the load-bearing test for D4 — proves the second surface is neutralized.)
- **Shadow relax off:** the shadow ledger halts at 2 losses exactly as today (both the per-call gate
  and the durable arm).
- **Env validation:** `validateEnv.spec.ts` covers `PAPER_RELAX_CONSECUTIVE_LOSS_HALT`; string
  `"false"` / typos / empty collapse to off; the typed getter neutralizes the flag (with a warning)
  when set under a non-paper env.
- **Gate path intact:** every intent still flows through `RiskGateService` (no bypass).
- **Boot:** engine boots and stays running after the paper `.env` change; 10-min live smoke per
  `feedback-milestone-app-smoke` (fix-and-report any boot error before the scribe).
- **Outcome stream (post-deploy, 24–48h):** the paper soak no longer day-halts after 2 losses; entry
  attempts that were previously blocked by `consecutive_loss_halt` now reach fills, and labeled
  outcomes accrue at a higher daily rate. Read-only DB querying.

## Risk / rollback

- **Default-off, paper-gated.** No live impact: a live or testnet boot can never see the flag on (the
  resolver returns `false` and logs a neutralization warning), so live risk posture is unchanged.
- **Rollback is a config flip.** Removing `PAPER_RELAX_CONSECUTIVE_LOSS_HALT` (or setting it to
  anything but `true`) from the paper `.env` and restarting restores the 2-loss halt immediately — no
  migration to revert, no schema to undo.
- **Backtest unaffected.** The backtest path reads `riskConsts`/`strategyConsts` directly and never
  sets the paper env flag, so M7 replay determinism (ADR 0029, 0032) is preserved.
- **Worst case if mis-deployed to live** is bounded: even if the flag were somehow set under a live
  env, the `AppConfigService` resolver neutralizes it (returns `false`) and warns — the consecutive-loss
  halt stays armed. The two-condition gate is the defense-in-depth.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M36 is migration-free.** The only DB interaction is operational: after deploy, optionally **clear a
stale `consecutive_loss_halt`** for the current UTC day so a pre-M36 halt does not mask the relaxation.
This is a scoped `risk_state` update via the existing `clearHaltForDate` / dashboard Resume path —
**not** a destructive op, no `-v`, no down/revert, no `TRUNCATE`/`DELETE`.

- **Backup first:** before the engine restart **and** before any `clearHaltForDate`, take a routine
  `pg_dump`
  (`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`),
  then prune to the **2 most recent** `backup_` files
  (`ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`). Show the user the dump path and confirm
  before clearing the halt.
- **Evidence-gated clear:** only if the current row is halted with a `consecutive_loss_halt` reason,
  the operator confirms the date, and daily/weekly limits are not themselves breached. Read the
  existing halt first; confirm with the user before the write.

## Post-deploy steps

1. Take `pg_dump` before the engine restart (prune to 2-deep retention); show the user the path.
2. Apply the paper `.env` change (`PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true`); **engine restart** (no
   migration).
3. **Evidence-gated `clearHaltForDate`** for the current UTC day if it is halted on
   `consecutive_loss_halt` (after backup, with user confirmation). Not a routine habit.
4. **10-min live smoke** per `feedback-milestone-app-smoke` — confirm the engine stays running and a
   cleared consecutive-loss halt does not immediately re-assert on the next tick.
5. **Outcome-rate confirmation (24–48h):** confirm the soak no longer day-halts after 2 losses and that
   labeled outcomes accrue at a higher daily rate vs the prior 7 days (the 128 previously-blocked
   attempts is the baseline). Read-only DB querying.

## References

- Precedent (identical two-condition pattern): M25 paper exploration enablement —
  [docs/plans/archive/M25-paper-exploration-enablement.md](archive/M25-paper-exploration-enablement.md)
- Paper exploration profile ADR (to be amended): [docs/architecture/adr/0042-paper-exploration-profile.md](../architecture/adr/0042-paper-exploration-profile.md)
- Risk management + halt legs: [docs/architecture/adr/0004-risk-management.md](../architecture/adr/0004-risk-management.md)
- Shadow ledger / virtual gate: [docs/architecture/adr/0029-*](../architecture/adr/README.md)

### Key source files

| Concern | Path |
|---|---|
| Live consecutive-loss check | `apps/engine/src/risk/service/RiskGateService.ts` (`checkLossWindows`, `isConsecutiveLossHalt`, `persistHalt`) |
| Live threshold const | `apps/engine/src/risk/const/riskConsts.ts` (`CONSECUTIVE_LOSS_HALT_COUNT`) |
| Env field | `apps/engine/src/config/EnvironmentVariables.ts` (clone `PAPER_RELAX_MARKET_STRESS`) |
| Typed getter/resolver | `apps/engine/src/config/service/AppConfigService.ts` (clone `paperRelaxMarketStress`) |
| Shadow thresholds + sentinel | `apps/engine/src/strategy/const/strategyConsts.ts` |
| Shadow per-call gate | `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` (line 265) |
| Shadow durable arm | `apps/engine/src/strategy/service/VirtualPositionLedgerService.ts` (`evaluateGates`, `maybeArmConsecutiveLossHalt`) |
