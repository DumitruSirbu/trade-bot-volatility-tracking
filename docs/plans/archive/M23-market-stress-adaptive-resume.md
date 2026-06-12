# M23 — Market-stress adaptive resume (consecutive-clean-tick auto-resume for breadth halts)

> **Sequencing note:** M23 lands **after** M20/M21/M22 fixed the soak's stress-halt
> miscalibrations (index-shock horizon, breadth distance 30→40, depth floors). With those legs
> now firing on genuine stress rather than normal correlated moves, the **remaining** over-
> conservatism is the *duration* of the penalty: every `market_stress` trip is a full-UTC-day
> lock, even when the triggering signal mean-reverts minutes later. M23 is a standalone
> **risk-loosening** mini-milestone — it shortens the lock for **breadth-triggered** stress halts
> only, replacing the day-lock with an adaptive auto-resume gated on consecutive clean ticks of
> the *global* breadth signal, with hysteresis and a per-day re-halt cap. Loss-based halts and
> all non-breadth stress legs are **untouched** (full-day lock preserved). Decision by architect +
> quant review (both APPROVE-WITH-AMENDMENTS), 2026-06-05.

## Objective

Replace the full-UTC-day lock for **breadth-triggered** `market_stress` halts with an in-process
adaptive auto-resume: once the **global** stress predicate (breadth-only for M23) reads clean for
`MARKET_STRESS_RESUME_CLEAR_TICKS` consecutive decision ticks **and** breadth has re-entered an
inner hysteresis band, trading resumes for the rest of the UTC day — unless the day has already
seen `MARKET_STRESS_MAX_DAILY_REHALT` re-halts, in which case it falls back to the full-day lock.
Loss-based halts, and stress halts triggered by BTC/ETH index-shock, OI, funding, or spread, keep
the existing full-day lock with no auto-resume. M23 ships **paper-mode only**; live activation is
gated on a backtest over the soak window plus accumulated paper-soak expectancy in the unlocked
windows.

## Background / motivation

The global market-stress halt (ADR 0004 §6) persists a `risk_state` row
(`is_halted=true, halt_reason='market_stress'`) for the current UTC day. Once set, the gate's
re-entry block (`RiskGateService.firstFailingHaltCheck`, line 459) returns `GLOBAL_HALT` on every
subsequent decision until UTC rollover — regardless of whether the triggering signal has cleared.

The day-lock is the right shape for a **loss-based** halt: consecutive losses or a daily/weekly
loss-limit breach reflects a persistent edge problem, and a cooling-off period to UTC rollover is
deliberately conservative. It is the **wrong** shape for a **breadth** halt: breadth
(`market_breadth_5m_up_pct`) is a fast mean-reverting count statistic — the fraction of tracked
coins up over 5m — that can collapse to single digits during a momentary correlated flush and
recover to balanced within minutes.

**Concrete example (today, 2026-06-05).** The bot halted at **02:45 UTC** with
`market_breadth_5m_up_pct = 8%` (`|8 - 50| = 42 >= STRESS_BREADTH_DISTANCE_PCT (40)` → breadth
collapse). The tape was calm again well before 07:00 UTC, yet the bot stayed locked for the **rest
of the UTC day** — 4+ hours of immediately-recovered market plus the entire remainder of the day
were forfeited on a single 5-minute breadth spike. Reconstructing the breadth tape further showed
the market **oscillated** between collapse and surge several times that morning — which is itself a
design input (see HIGH 2 below): naive auto-resume would have re-entered each oscillation.

This is the opposite of the conservative, survival-first design intent in two directions at once:
the day-lock is *too punitive* for a transient breadth flush, while a naive resume would be *too
eager* into a chattering regime. M23 threads both needles: shorten the lock for genuinely-recovered
breadth, but with hysteresis and a chatter cap so a thrashing market falls back to the day-lock.

## Quant review summary (pre-implementation)

A pre-implementation quant review shaped the design. The findings folded into this plan:

- **BLOCKER 1 — Per-leg resume predicate, not full `isStressed()`.** The resume check must read
  only the **global** stress legs, never the full disjunction (which includes per-coin funding /
  spread legs). Resolved by a new `isGlobalStressed()` predicate (breadth-only for M23). See
  Architecture §1.
- **BLOCKER 2 — N=3 is not a validated calibration.** N=3 was derived by sampling breadth at fixed
  +5/+10/+15m offsets on a 6-day, 14-event, single-regime, zero-out-of-sample dataset — it does
  **not** demonstrate 3 *consecutive* clean bars. Resolved by shipping N as a **configurable
  constant** (default 3) treated as a starting point pending a proper per-bar analysis + held-out
  validation, not a locked number. See Architecture §2 and Constants.
- **HIGH 1 — Resume check must precede the early return.** The day-halt early return at line 459
  short-circuits before `isStressed()` at line 463 ever runs, so the resume branch must be inserted
  **before** the early return and must branch on whether the halt reason is `market_stress`
  (breadth) vs. a loss-based reason. See Architecture §1 / Implementation scope.
- **HIGH 2 — Hysteresis + per-day re-halt cap.** Engage and resume thresholds must differ
  (hysteresis), and a per-UTC-day re-halt cap must fall back to the full-day lock when the market
  chatters. See Architecture §2/§3.
- **HIGH 3 — Surge auto-resume directional risk.** Re-opening after a surge invites squeeze risk on
  fade/reversion entries. **Deferred to M24** as a post-resume directional cooldown (MEDIUM
  tech-debt) — M23 ships the core mechanism first. See Deferred items.
- **HIGH 4 — Paper-only initially; no position-level backtest of unlocked windows.** No evidence
  yet that the strategy has positive expectancy in the windows now being unlocked. M23 ships
  paper-mode only; live activation is gated. See Architecture §8 and Post-deploy steps.
- **MEDIUM 1 — Signal-dependent N; only breadth gets auto-resume.** BTC/ETH shock, OI, and funding
  are slower / trendier signals with **zero** events in the dataset; their N is unvalidated, so they
  stay full-day locked. Requires recording which leg(s) triggered the halt. See Architecture §4/§5.
- **LOW — `MARKET_STRESS_RESUMED` telemetry event.** Add a symmetric resume event for post-deploy
  soak telemetry. See Architecture / Implementation scope.

## Architecture decisions

### 1. Global vs. per-leg resume predicate (BLOCKER 1 + HIGH 1)

`StressHaltEvaluator.isStressed()` is a disjunction over **global** legs (breadth, BTC 5m shock,
ETH 5m shock, OI 5m, market-wide spread) **and** per-snapshot **coin-specific** legs (funding,
per-coin spread). Reusing the full disjunction for auto-resume fails both ways:

- A single coin's funding/spread breaching threshold would perpetually reset the resume counter
  even though the global breadth cause cleared minutes ago — the bot never resumes.
- Conversely, a breadth halt could auto-resume while OI is still shocked.

**Decision:** introduce a new `StressHaltEvaluator.isGlobalStressed(snapshot)` predicate that
checks **only the global breadth leg** for M23 (the only leg getting auto-resume — see §4). It
reuses the same `isBreadthCollapse` distance logic at the **resume** threshold (see §2) and
preserves **NaN fail-closed** on its consumed inputs: a non-finite breadth (or, for safety, the
BTC/ETH 5m fields that the engage path also reads) is treated **as stressed** → counter reset.
Funding and per-coin spread remain where they already live — at the **per-entry** eligibility gate
(`FUNDING_SUPPRESSED`, `SPREAD_TOO_WIDE`) — and play **no** role in auto-resume.

The resume evaluation must be inserted **before** the day-halt early return in
`firstFailingHaltCheck`, branching on the persisted halt reason (see §7). It cannot live after
line 459 because that return short-circuits before `isStressed()` is ever called.

### 2. Halt vs. resume threshold hysteresis (HIGH 2.1)

Engage threshold ≠ resume threshold, to stop chattering at the boundary:

- **Engage** (unchanged): halt when `|breadth - 50| >= STRESS_BREADTH_DISTANCE_PCT (40)` — i.e.
  breadth `<= 10` (collapse) or `>= 90` (surge).
- **Resume**: require breadth to re-enter the **inner band** —
  `|breadth - 50| <= MARKET_STRESS_RESUME_BREADTH_DISTANCE (30)` — i.e. breadth in **[20, 80]** —
  for `MARKET_STRESS_RESUME_CLEAR_TICKS` **consecutive** decision ticks. A reading in the gap
  `(10, 20)` or `(80, 90)` is **not** clean enough to count toward resume even though it is below
  the engage threshold: it resets the counter. This 10-point gap on each side is the hysteresis
  buffer.

The clear-count is an **in-memory consecutive counter** on `RiskGateService`, incremented on a
clean global tick and **reset to 0** on any non-clean tick (including NaN fail-closed) or when
stress recurs mid-window. It is **not** persisted; on restart it resets to 0 (conservative — one
more full confirmation cycle is required, see §6 and the restart test).

### 3. Per-day re-halt cap (HIGH 2.2)

Chatter is itself a regime signal. Track per-UTC-day **re-halt count** for `market_stress`. If a
breadth halt would engage for the `MARKET_STRESS_MAX_DAILY_REHALT (3)`-th time in one UTC day, the
bot **falls back to the full-day lock** — auto-resume is disabled for the remainder of that UTC
day, and the halt persists exactly like a loss halt until rollover. The re-halt counter is per UTC
day and resets at rollover (same pattern as the existing `stressEmittedForDate` dedup reset, line
445). Today's reconstructed 5-cycle morning is precisely the case this cap is meant to catch.

**Restart semantics (review H3).** The re-halt counter is **in-memory only** — an engine restart
mid-day resets it to 0, so a process that already hit the cap and fell back to the full-day lock
would, after a restart, restore the persisted halt (still locked) but begin counting re-halts
afresh. This is a known **more-permissive** quirk: a restart during a chattering day could allow
the cap to be reached a second time within the same UTC day. M23 **accepts and documents** this
rather than persisting the counter, for three reasons: (1) the persisted day row is still
`is_halted=true`, so a capped+restarted process resumes locked and must re-earn a resume through
the full clean-tick + hysteresis path before it can re-halt at all; (2) there is no migration-free
place to persist a counter (no JSON/metadata column on `risk_state` — see Data model); (3) restarts
are rare operational events, not a tape-driven exploit. The residual is logged as **LOW
tech-debt** ("persist `stress_rehalt_count` once `risk_state.updated_at`/metadata work lands"), to
be revisited with the M11 `updated_at` column rather than bolted on with a varchar hack now. The
clean-tick counter resetting to 0 on restart (§2) is conservative in the **other** direction —
together the restart story is: locked stays locked, resume requires a fresh confirmation cycle,
only the chatter-cap headroom is loosened.

### 4. Which legs get auto-resume (MEDIUM 1)

**Breadth only.** BTC/ETH 5m index-shock is a *price-level* event that can persist as a trend; OI
shocks have delayed structural effects; funding is per-coin. The 14-event dataset contains **zero**
events triggered by BTC/ETH shock, OI, or funding, so their resume-N is entirely unvalidated.
For M23, only a **breadth-triggered** halt is eligible for auto-resume. A halt triggered by any
other leg stays full-day locked. This requires knowing **which leg** triggered the halt (§5).

### 5. Encoding the trigger leg in `halt_reason` (no migration)

`risk_state.halt_reason` is already a free-form varchar written by `persistHalt` (currently the
bare `RejectReasonEnum.MARKET_STRESS = 'market_stress'`). M23 **extends the string format** to
carry the trigger leg as a suffix — **no migration, no new column**:

- `market_stress:breadth` — breadth collapse/surge (eligible for auto-resume)
- `market_stress:btc_shock` / `market_stress:eth_shock` — index shock (full-day lock)
- `market_stress:oi` — OI shock (full-day lock)
- `market_stress:funding` — funding extreme (full-day lock)
- `market_stress:spread` — market-wide spread blowout (full-day lock)
- `market_stress:same_bar` — `same_bar_trigger_count` saturation (full-day lock)
- `market_stress:invalid` — NaN fail-closed engage (full-day lock — conservative)
- `market_stress:multi` — **two or more** global legs engaged on the same snapshot (full-day lock)

The auto-resume branch parses the suffix; **only** `:breadth` is resume-eligible. Any
`market_stress` reason **without** a recognised resume-eligible suffix (including a legacy bare
`market_stress` written before M23, the `:same_bar` pseudo-leg, and the `:multi` marker) defaults
to **full-day lock** (fail-safe: unknown → no auto-resume). This keeps backward compatibility with
rows already in the soak DB.

**Leg-classifier completeness and multi-leg precedence (review H2).** The engage disjunction in
`isStressed()` covers more legs than the breadth leg M23 unlocks — the classifier MUST enumerate
**every** engage path, not just the resume-eligible one, so no engage is silently misclassified:
invalid-inputs, BTC/ETH index shock, breadth, `same_bar_trigger_count`, OI, funding, spread.
**Multi-leg rule: most-conservative-leg-wins.** A snapshot is tagged `:breadth` (resume-eligible)
**only when breadth is the sole engaging global leg**. If breadth engages *alongside* any other
global leg on the same snapshot, the halt is tagged `:multi` and stays full-day locked. This is
the survival-first default: auto-resume loosens the penalty, so it applies only when the cause is
unambiguously the single fast mean-reverting signal. The classifier returns the single canonical
suffix; the ADR §6 amendment fixes the exact enumeration so the engage writer, the resume parser,
and the alert/telemetry vocabulary stay in sync.

> **Interaction with `HaltStateRestoreService` — double-prefix bug (review H1, MUST-FIX).** The
> restore path applies the in-memory flag as `this.haltFlag.halt(\`${resolution.source}:${resolution.reason ?? 'restored'}\`)`
> (`HaltStateRestoreService.ts:165`). With the new encoding, `resolution.source` resolves to
> `market_stress` (via `resolveProgrammaticSource`, which splits on the **first** colon and maps
> the `market_stress` prefix to `HaltSourceEnum.MARKET_STRESS`) **and** `resolution.reason` is the
> full persisted string `market_stress:breadth` — so the naive concatenation produces the corrupt
> in-memory flag **`market_stress:market_stress:breadth`**. This MUST be fixed before the engine
> wave. The canonical contract (locked in ADR 0004 §6):
>
> - **`risk_state.halt_reason`** is the single source of truth and stores the full string
>   `market_stress:<leg>` (e.g. `market_stress:breadth`). `persistHalt` writes exactly this.
> - **`resolveProgrammaticSource`** keeps splitting on the first colon → prefix `market_stress` →
>   `HaltSourceEnum.MARKET_STRESS`. Unchanged; the suffix is ignored for source resolution.
> - **The restore flag string must not re-prefix.** When `resolution.reason` already begins with
>   the source token (`market_stress:`), restore passes the reason **as-is** to `haltFlag.halt(...)`
>   rather than re-concatenating `source:reason`. The in-memory flag therefore reads
>   `market_stress:breadth`, identical to the persisted row — a clean round-trip.
> - **`HaltFlagService.haltedLeg`** holds the **leg token alone** (`breadth`), parsed from the
>   suffix — not the full string — so a `getHaltedLeg()` query returns `breadth`, never
>   `market_stress:breadth`. The full reason remains available via the existing reason accessor.
>
> A `persist → restart/restore → flag` round-trip test (Test plan) asserts the flag reads
> `market_stress:breadth` and `getHaltedLeg()` returns `breadth` — never the double-prefixed form.
> **Lock the canonical strings in the ADR before the engine wave so the gate writer, the restore
> reader, and the flag service do not drift.**

### 6. In-process (not cron) confirmation window

The consecutive-clean-tick counter is advanced **in-process on each decision tick** that reaches
the gate — it is **not** a wall-clock timer or a cron job. This preserves the determinism
invariant (no `Date.now()`-driven control flow, no scheduler): given the same ordered sequence of
snapshots, the resume decision is identical in live and backtest. "Tick" means a gate evaluation;
N consecutive clean **gate evaluations** in the inner band trigger resume. (Decision cadence is
already ~5m-aligned to the breadth field, so N=3 ≈ ~15m of confirmation, but the mechanism counts
**ticks**, not minutes — a deliberate determinism choice.)

### 7. Loss-based halts: full-day lock untouched

The branch placement in `firstFailingHaltCheck`, inserted **before** the existing line-459 early
return:

- `state.today.isHalted && haltReason starts with 'market_stress' && leg == breadth` → run resume
  evaluation (global breadth-only predicate). On a successful resume, clear the persisted halt for
  the day (see Data model), increment nothing, and continue to the fresh `isStressed()` engage
  check below (so a same-tick re-stress can immediately re-halt and bump the re-halt counter).
- `state.today.isHalted && haltReason starts with 'market_stress' && leg != breadth` → keep the
  existing `GLOBAL_HALT` early return (non-breadth stress stays full-day locked).
- `state.today.isHalted && haltReason is a loss-based reason` (`consecutive_loss_halt`,
  `daily_loss_limit`, `weekly_loss_limit`, `model_divergence_halt`) → keep the existing
  `GLOBAL_HALT` early return. **Loss halts never auto-resume, regardless of clear count.**

### 8. Paper-first rollout gate (HIGH 4) + code-level enforcement (review H4)

**Code-enforced, not policy-only.** The review correctly flags that "paper-only" as written was
review governance, not enforced behaviour: deploying M23 to the (already paper) soak engine
activates the new auto-resume path immediately, so "paper-only" really means "do not flip to live
until the gates pass" — but nothing in code prevented a future live deploy from inheriting an
unvalidated loosening. M23 closes this with a **boot-time enable flag**:

- A new boolean config `MARKET_STRESS_AUTO_RESUME_ENABLED` gates the entire resume branch. When
  `false`, `firstFailingHaltCheck` keeps the existing line-459 day-lock for **all** stress halts
  (M23 is inert — identical to pre-M23 behaviour). When `true`, the breadth auto-resume branch runs.
- **Default is derived from `EXCHANGE_ENV`, fail-safe to off:** enabled by default in **paper**,
  disabled by default in **live**. Live can only enable auto-resume by an **explicit** operator
  override after the gates below pass — a deliberate second action, never an accidental inheritance.
- This is a config flag read once at boot, not per-tick wall-clock state, so it does **not** touch
  the determinism invariant: within a run the flag is constant, and a backtest sets it explicitly.

Live activation is gated on **both** (in addition to the flag being explicitly enabled):

1. A `BacktestRunnerService` run over the soak window **with auto-resume enabled**, reporting
   trade count / win rate / profit factor / max drawdown specifically for trades **opened within
   30 minutes of an auto-resume**. If those windows show negative expectancy, M23 does **not** go
   live — revert or raise N.
2. Accumulated **14-day paper-soak** evidence showing non-negative expectancy in the auto-resume
   windows, plus a re-halt-cycle count that stays under the cap most days.

The 14-day M21/M22 slippage telemetry is still running; M23's gate composes with it — neither
unlocks live alone.

## Data model changes

**No migration.** All changes are to the in-memory gate state and the **encoding** of an existing
column:

- `risk_state.halt_reason` (existing `varchar`): extend the written value to `market_stress:<leg>`
  (see §5). No schema change — same column, richer string. Legacy bare `market_stress` rows are
  read as full-day-lock (no resume).
- **Clearing a resumed halt for the day.** On a successful breadth auto-resume the gate must mark
  the day **not halted** so subsequent ticks do not re-trip the day-lock early return. This reuses
  the existing `upsertDay` path (the inverse of `persistHalt`): write `is_halted=false,
  halt_reason=null` for the UTC day, preserving the PnL/exposure/trade counters (mirror
  `emptyDay`'s field-preservation discipline). Idempotent on the UTC-day key, replay-safe.
- `HaltFlagService` gains a `haltedLeg` field (nullable string) tracking the leg of the **current**
  in-memory halt, set on `halt()` and cleared on `resume()`, so the process-wide flag and the
  persisted row agree on the trigger leg. (Command-Query Separation preserved — `halt`/`resume`
  stay state-changers; a new `getHaltedLeg()` query reads it.)
- **In-memory only** (not persisted): the consecutive clean-tick counter and the per-UTC-day
  re-halt counter live on `RiskGateService` (same lifecycle as `stressEmittedForDate`). Both reset
  at UTC rollover; the clean-tick counter also resets to 0 on restart.

## Implementation scope (files to touch)

| Workspace | File | Change |
|-----------|------|--------|
| `apps/engine/` | `src/risk/const/riskConsts.ts` | Add `MARKET_STRESS_RESUME_CLEAR_TICKS`, `MARKET_STRESS_RESUME_BREADTH_DISTANCE`, `MARKET_STRESS_MAX_DAILY_REHALT` with rationale comment blocks. |
| `apps/engine/` | config (env schema) | Add `MARKET_STRESS_AUTO_RESUME_ENABLED` boolean (§8): default derived from `EXCHANGE_ENV` — on in paper, off in live; explicit override required to enable on live. Read once at boot; gates the whole resume branch. |
| `apps/engine/` | `src/risk/service/StressHaltEvaluator.ts` | Add `isGlobalStressed(snapshot)` (breadth-only at the **resume** distance) with NaN fail-closed; add a leg-classifier that enumerates **every** engage path (invalid, btc/eth shock, breadth, same_bar, oi, funding, spread) and returns the single canonical suffix — `:breadth` only when breadth is the **sole** engaging leg, `:multi` when 2+ legs engage (§5). Do not change `isStressed()` engage semantics. |
| `apps/engine/` | `src/risk/service/RiskGateService.ts` | Insert the auto-resume branch **before** the line-459 early return (§7), gated on `MARKET_STRESS_AUTO_RESUME_ENABLED`; track the in-memory clean-tick counter + per-day re-halt counter (UTC-rollover reset like `stressEmittedForDate`); write `market_stress:<leg>` in `persistHalt`; clear the day-halt on resume; emit `MARKET_STRESS_RESUMED`. Verify the resume→re-engage path's interaction with `stressEmittedForDate` dedup (review M1) so a same-day re-halt after a resume still emits a fresh halt event. |
| `apps/engine/` | `src/common/service/HaltFlagService.ts` | Add nullable `haltedLeg` (holds the **leg token alone**, e.g. `breadth`) + `getHaltedLeg()`; set on `halt()`, clear on `resume()`. |
| `apps/engine/` | `src/bootstrap/HaltStateRestoreService.ts` | Fix the **double-prefix bug** (review H1): when `resolution.reason` already begins with the source token, pass it to `haltFlag.halt(...)` as-is instead of re-concatenating `source:reason` (avoid `market_stress:market_stress:breadth`). On a `market_stress` restore, ensure the in-memory clean-tick counter starts at **0**. Confirm the new `halt_reason` suffix does not break `resolveProgrammaticSource` first-colon parsing (§5). |
| `packages/shared/` | new `IMarketStressResumedEvent` interface + `MARKET_STRESS_RESUMED_EVENT` constant | Symmetric to `IRiskHaltEvent` / `RISK_HALT_TRIGGERED_EVENT`. Route through `bot-shared-maintainer` (wave 1). |
| `apps/engine/` | alert/event-bus wiring | Emit `MARKET_STRESS_RESUMED` on resume with: clear-count, breadth value at resume, the original trigger leg (`breadth`), the re-halt count for the day, the `utcDateString`, and a `nearReHaltCap` boolean (review M3 — aids soak dashboards in spotting days approaching the cap). Wire the Telegram/notification consumer symmetrically to the existing halt alert. |

> **Shared-contract first.** The new event interface + constant is a `packages/shared/` change —
> dispatch `bot-shared-maintainer` in **wave 1** (serial) before the engine wave, per CLAUDE.md.

## Constants to introduce (with rationale)

```
// --- market-stress adaptive resume (§6, M23) ---

// Consecutive clean global-breadth decision ticks (breadth in the inner hysteresis band)
// required before a breadth-triggered market_stress halt auto-resumes. Default 3 — a STARTING
// POINT pending a proper per-bar consecutive-clean-bar analysis with held-out validation, NOT a
// validated calibration (the original N=3 was sampled at fixed +5/+10/+15m offsets, not from the
// full per-bar series). Operators tune this against the post-deploy paper soak.
export const MARKET_STRESS_RESUME_CLEAR_TICKS = 3;

// Inner hysteresis band for resume. Halt ENGAGES at |breadth - 50| >= STRESS_BREADTH_DISTANCE_PCT
// (40, i.e. breadth <= 10 or >= 90). Resume requires re-entering |breadth - 50| <= 30 (breadth in
// [20, 80]). The 10-point gap on each side is the hysteresis buffer that prevents chattering at
// the engage boundary — a reading in (10,20) or (80,90) does NOT count toward resume.
export const MARKET_STRESS_RESUME_BREADTH_DISTANCE = 30;

// Per-UTC-day cap on market_stress re-halts. On the 3rd breadth re-halt in one UTC day the bot
// falls back to the FULL-DAY LOCK (auto-resume disabled for the rest of the day). Chatter is
// itself a regime signal — a market oscillating between collapse and surge is exactly when the
// conservative day-lock should reassert. Resets at UTC rollover.
export const MARKET_STRESS_MAX_DAILY_REHALT = 3;
```

```
// --- code-level rollout gate (§8, M23) — env config, NOT a riskConsts constant ---

// Master switch for breadth auto-resume. When false, the resume branch is inert and ALL stress
// halts keep the pre-M23 full-day lock. Default derived from EXCHANGE_ENV — ON in paper, OFF in
// live — and an explicit operator override is required to enable on live AFTER the backtest +
// 14-day paper-soak gates pass. Read once at boot (constant within a run → determinism preserved).
MARKET_STRESS_AUTO_RESUME_ENABLED: boolean   // env-driven; paper=true, live=false (default)
```

## Post-deploy verification steps (same pattern as M21/M22)

1. **`pg_dump` before any restart** into gitignored `backups/`
   (`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`),
   then prune to the **2 most recent** `backup_` files. Show the user the dump path before
   restarting.
2. **Stale-halt inspection (bare AND suffixed — review M5).** If `risk_state` for today shows
   `is_halted=true` and the tape is now calm, clear it via `clearHaltForDate` (same step as M21).
   This covers **both** a bare legacy `market_stress` row **and** a new `market_stress:breadth` row
   left blocked because it was written before the resume branch was live (or because the day already
   hit the re-halt cap). Match with `halt_reason LIKE 'market_stress%'`, not `= 'market_stress'`.
   Read-only first; clear only on confirmation.
2a. **Analysis/dashboard query audit (review M2, read-only).** Audit `halt_reason` consumers —
   notably `packages/analysis/src/query/selectHaltState.ts` and any funnel SQL — for an exact-match
   `halt_reason = 'market_stress'` filter that would silently drop suffixed rows. Convert to
   `LIKE 'market_stress%'` or a prefix parse. No dashboard code change is required if consumers
   already prefix-match; this is a verification step, not a planned edit.
3. **Engine restart** (no migration). Confirm the clean-tick counter starts at 0 post-restart.
4. **`BacktestRunnerService` run over the soak window with auto-resume enabled** — report trade
   count / win rate / profit factor / max drawdown for trades opened **within 30 min of an
   auto-resume**. This is the primary live-activation gate (HIGH 4). Read-only.
5. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report any boot error before
   the scribe. Confirm the engine boots, stays running, and (if a breadth halt fires during the
   smoke) that the resume branch is reachable.
6. **14-day paper soak.** Gate live activation on **non-negative expectancy in the auto-resume
   windows** plus a re-halt-cycle count that stays under `MARKET_STRESS_MAX_DAILY_REHALT` on most
   days. If the unlocked windows produce losses, revert or raise N.
7. **Daily monitoring.** Watch `MARKET_STRESS_RESUMED` events and the per-day re-halt-cycle count.
   A day that repeatedly hits the cap is a signal to tighten N or widen the hysteresis band.

## Tech-debt / deferred items

- **Post-resume directional cooldown (deferred to M24, MEDIUM → escalate conditionally).** After a
  **surge**-triggered auto-resume, suppress fresh fade/reversion entries on the surged cohort for M
  bars (squeeze risk); after a **collapse**-triggered resume, suppress fresh long entries similarly.
  Distinct from the halt mechanism — a post-resume guard. Out of M23 scope to ship the core
  mechanism first (HIGH 3). Surge auto-resume into a fade strategy is the **riskiest** resume path;
  M23's hysteresis + re-halt cap mitigate *chatter* but not *directional* squeeze risk. Per the
  review, this is logged MEDIUM but is **escalated to HIGH** the moment the paper soak shows entries
  opening within minutes of a surge-resume event — the scribe must watch `MARKET_STRESS_RESUMED`
  events with a surge breadth value and check for near-term fade entries.
- **Single merged "breadth-stress calibration" tech-debt row (review M6).** To avoid three
  overlapping MEDIUM lines (the M22 scribe lesson), `docs/tech-debt.md` carries **one** breadth
  calibration row with sub-bullets, merging the existing breadth-distance validation debt with the
  two M23 additions: (a) `MARKET_STRESS_RESUME_CLEAR_TICKS = 3` from the full per-bar
  consecutive-clean-bars-until-next-breach distribution with a held-out sub-period (BLOCKER 2
  residual — N ships as a tunable starting point, not a validated number); (b) the resume hysteresis
  inner band (30) validated against per-bar breadth autocorrelation after a 30–60 day soak (the
  resume band reuses the old M19 engage value, so it must be confirmed, not assumed). Signal-
  dependent N for non-breadth legs is a separate sub-bullet, not its own row.
- **Signal-dependent N for BTC/ETH shock, OI, funding legs (deferred, MEDIUM).** Those legs stay
  full-day locked in M23 because their resume-N is unvalidated (zero events in the dataset). Revisit
  once real events exist and a per-bar analysis per leg is possible. Filed as a sub-bullet of the
  merged breadth-calibration row above.
- **Persist `stress_rehalt_count` (deferred, LOW — review H3).** The per-day re-halt cap counter is
  in-memory, so a mid-day restart resets the chatter cap (more-permissive quirk, §3). No
  migration-free home exists today; revisit alongside the `risk_state.updated_at`/metadata work.
- **`risk_state.updated_at` column (M11 TODO, LOW/structural).** Needed for the true newer-wins
  timestamp compare in `HaltStateRestoreService` (currently a "halt-wins" tie-break). Unchanged by
  M23 but called out because M23's restore path depends on the same service, and because persisting
  the re-halt counter would naturally land with it.

## Test plan (QA must cover)

- **Breadth halt auto-resumes** after `MARKET_STRESS_RESUME_CLEAR_TICKS` consecutive clean ticks
  (breadth in [20, 80]); the day-halt is cleared and the next entry is admitted.
- **Non-breadth stress halt stays full-day locked** — a `market_stress:btc_shock` (or `:oi`,
  `:funding`, `:spread`) halt returns `GLOBAL_HALT` on every subsequent tick regardless of breadth.
- **Legacy bare `market_stress` stays full-day locked** (unknown/missing suffix → no resume).
- **Counter resets on mid-window recurrence** — a clean tick streak interrupted by a breadth breach
  resets to 0; resume requires a fresh full streak.
- **Hysteresis lower edge** — breadth `= 11%` (below the engage threshold of `<=10` but **outside**
  the inner band `[20,80]`) does **not** advance the counter; resume waits for breadth `>= 20`.
- **Hysteresis upper edge** — breadth `= 89%` does **not** advance the counter; resume waits for
  breadth `<= 80`.
- **Per-day re-halt cap** — the `MARKET_STRESS_MAX_DAILY_REHALT`-th breadth re-halt in one UTC day
  freezes auto-resume for the day (full-day lock); a fresh UTC day re-arms it.
- **Loss-based halts never auto-resume** — `consecutive_loss_halt` / `daily_loss_limit` /
  `weekly_loss_limit` / `model_divergence_halt` stay locked regardless of clean-tick count.
- **Restart resets counter to 0** — after `HaltStateRestoreService` restores a breadth halt, the
  clean-tick counter is 0 (a full fresh confirmation cycle is required).
- **NaN fail-closed in resume snapshot** — a non-finite breadth (or BTC/ETH 5m field) on a resume
  tick resets the counter (treated as stressed).
- **`MARKET_STRESS_RESUMED` event fires on auto-resume** with clear-count, breadth at resume, the
  original trigger leg, the day's re-halt count, `utcDateString`, and `nearReHaltCap` — and does
  **not** fire on a loss-halt clear or on operator resume.
- **Determinism** — the same ordered snapshot sequence yields the same resume decision across two
  runs (no wall-clock dependence); a backtest replay reproduces the live resume tick exactly.
- **Backtest replay parity (review M4)** — a dedicated, non-mocked replay test: ordered snapshots
  driving breadth collapse → recovery → resume tick → entry admitted, run through the same
  `RiskGateService` branch the live path uses, proving the determinism claim beyond unit mocks and
  that `BacktestRunnerService` exercises the auto-resume branch (not a parallel code path).
- **Leg-scoped resume with another leg still shocked (review critique #2)** — a `market_stress:breadth`
  halt resumes after a clean breadth streak **even if** BTC 5m is still shocked, because the halt
  was breadth-sole; conversely a snapshot where breadth **and** BTC shock engage together is tagged
  `:multi` and never auto-resumes.
- **Leg-classifier coverage for every engage path (review H2)** — a unit test per engage leg
  (invalid, btc_shock, eth_shock, breadth, same_bar, oi, funding, spread) asserts the correct
  canonical suffix; a multi-leg snapshot asserts `:multi`; only the breadth-sole case is
  resume-eligible.
- **Same-tick resume → re-halt emits a fresh halt event (review M1)** — resume on tick T then
  breadth back to 8% on the same evaluation: the halt re-engages, the re-halt counter increments,
  the `RISK_HALT_TRIGGERED` event still fires (the `stressEmittedForDate` dedup must **not** suppress
  the re-halt alert after a resume cleared `is_halted`), and there is no spurious duplicate emit.
- **`halt_reason` round-trip + no double-prefix (review H1)** — `persistHalt` writes
  `market_stress:breadth`; the resume branch parses it correctly; after a restart,
  `HaltStateRestoreService` restores the in-memory flag as `market_stress:breadth` (NOT
  `market_stress:market_stress:breadth`), `getHaltedLeg()` returns `breadth`, and
  `resolveProgrammaticSource` still maps the leading `market_stress` token to
  `HaltSourceEnum.MARKET_STRESS`.
- **Auto-resume disabled flag (review H4)** — with `MARKET_STRESS_AUTO_RESUME_ENABLED=false`, a
  breadth halt stays full-day locked regardless of clean-tick count (M23 inert / pre-M23 behaviour).

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`**: amend **ADR 0004 §6 in place** with: the breadth-only auto-resume
   mechanism; the hysteresis band (engage 40 / resume 30); the per-day re-halt cap and its
   **in-memory restart quirk** (review H3); the `market_stress:<leg>` `halt_reason` encoding — the
   **single canonical written string** plus the explicit **no-double-prefix** restore/flag contract
   and that `haltedLeg` holds the leg token alone (review H1); the **full leg-classifier
   enumeration** including `:same_bar`, `:invalid`, and the `:multi` most-conservative-leg-wins rule
   (review H2); the breadth-only scope with non-breadth legs full-day locked; the
   `MARKET_STRESS_AUTO_RESUME_ENABLED` boot flag and paper-default/live-off enforcement (review H4);
   the paper-first live-activation gate; and the in-process (not cron) determinism note. Lands
   **before** the engine code so the const values and §6 agree.
2. **Serial — `bot-shared-maintainer`**: add `IMarketStressResumedEvent` + `MARKET_STRESS_RESUMED_EVENT`
   to `packages/shared/`. Before engine/dashboard per CLAUDE.md.
3. **Serial — `bot-engine-nestjs`**: implement per Implementation scope (the resume branch,
   `isGlobalStressed`, counters, `halt_reason` suffix, `HaltFlagService.haltedLeg`, restore-counter
   reset, event emit). Split across ≤5-file dispatches if needed; the `RiskGateService` branch is
   the load-bearing change.
4. **Serial — `bot-qa-engineer`**: the full Test plan above, paired per fix item — happy resume,
   each fail-mode (non-breadth lock, loss lock, hysteresis edges, cap, NaN, restart, legacy row),
   the event-emit test, and the determinism/replay test.
5. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   **`bot-review-quant`**. The quant reviewer owns: hysteresis-band soundness, the re-halt cap, the
   breadth-only scope, and that N=3 is documented as a tunable starting point (not a calibration)
   with the per-bar analysis logged as residual debt. Cycle fix → re-review until zero blockers,
   zero highs, majority mediums.
6. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` RiskModule note (breadth-stress adaptive resume), and `docs/tech-debt.md`
   — recorded as **one merged breadth-calibration MEDIUM row** with sub-bullets (review M6: N, resume
   hysteresis band, signal-dependent N), the M24 surge-cooldown MEDIUM (escalate to HIGH if soak shows
   surge-resume entries), and the persist-`stress_rehalt_count` LOW. Confirm the ADR 0004 §6 amendment
   is linked. Record the stale-halt / restart outcome and the dump path.

Orchestrator verifies the actual diff after every wave — and explicitly diffs the new constants,
the `RiskGateService` branch placement (must be **before** the line-459 early return), and the
`halt_reason` written string against the §6 amendment.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M23 is migration-free** — no schema change, no new column, no `strategy_versions` write. The
`halt_reason` change is a **richer string in the existing varchar**; the counters are in-memory.
Picking up the change requires only an **engine restart**.

- **Take a `pg_dump` before the restart** (and before any `clearHaltForDate` on a stale breadth
  halt), into gitignored `backups/`; prune to the 2 most recent. Show the user the dump path and
  get confirmation before restarting.
- The only write M23 performs at runtime is the existing idempotent `upsertDay` (now also writing
  `is_halted=false` on resume) on the UTC-day key — no bulk write, no destructive operation.

## Success criteria

- A breadth-triggered `market_stress` halt auto-resumes after `MARKET_STRESS_RESUME_CLEAR_TICKS`
  consecutive clean global-breadth ticks in the inner hysteresis band — proven by paired tests.
- Non-breadth stress legs and all loss-based halts remain full-day locked — proven by paired tests.
- Hysteresis (engage 40 / resume 30) and the per-day re-halt cap (3) behave per the test plan.
- `halt_reason` carries the `market_stress:<leg>` suffix; legacy bare rows default to full-day lock;
  `HaltStateRestoreService` round-trips correctly.
- The clean-tick counter resets to 0 on restart and on NaN/recurrence.
- `MARKET_STRESS_RESUMED` event fires on auto-resume only.
- The change is deterministic (in-process tick counting, no wall-clock control flow) and replays
  identically in backtest.
- M23 is migration-free and ships **paper-mode only**, **code-enforced** by
  `MARKET_STRESS_AUTO_RESUME_ENABLED` (paper-default-on, live-default-off, explicit override to
  enable live); live activation is gated on the backtest + 14-day paper soak.
- The `halt_reason` round-trip produces no double-prefix (`market_stress:breadth`, never
  `market_stress:market_stress:breadth`); `getHaltedLeg()` returns the bare leg token.
- The leg classifier covers every engage path; only a breadth-sole halt is resume-eligible
  (`:multi` and all non-breadth legs stay full-day locked).
- Zero blockers, zero highs at close; majority of mediums resolved or logged as deferred debt.

## Explicitly deferred

- **Post-resume directional cooldown** (surge → suppress fades/shorts on the surged cohort;
  collapse → suppress longs) — **M24**, MEDIUM tech-debt (HIGH 3); **escalate to HIGH** if the
  paper soak shows entries opening within minutes of a surge-resume event.
- **Signal-dependent N for BTC/ETH shock, OI, funding legs** — deferred until events exist; those
  legs stay full-day locked (MEDIUM 1).
- **N from the full per-bar series + held-out validation** — N=3 ships as a tunable starting point;
  the calibration analysis is owed (BLOCKER 2 residual, MEDIUM — merged into the breadth-calibration
  tech-debt row per review M6).
- **Persist `stress_rehalt_count`** — in-memory cap resets on mid-day restart (LOW, review H3);
  revisit with `risk_state.updated_at`/metadata.
- **`risk_state.updated_at`** — M11 TODO; enables a true newer-wins restore compare (LOW/structural).

## Independent review adjudication

Adjudication of the Composer independent review (`docs/archive/independent-analysis/composer/M23-market-stress-adaptive-resume-review.md`),
2026-06-05. Verdicts: APPLIED / PARTIAL / REJECTED.

### Must-fix (review H-series)

| # | Finding | Verdict | Rationale |
|---|---------|---------|-----------|
| H1 | Canonical `halt_reason`/`HaltFlagService` string contract — restore path double-prefixes to `market_stress:market_stress:breadth`. | **APPLIED** | Confirmed against `HaltStateRestoreService.ts:165`; §5 now mandates pass-reason-as-is on restore, `haltedLeg` holds the leg token alone, and a no-double-prefix round-trip test is added. |
| H2 | Leg-classifier completeness — `same_bar_trigger_count`/invalid omitted; multi-leg tie-break unspecified. | **APPLIED** | Classifier now enumerates every engage path; added `:same_bar` and `:multi`; adopted most-conservative-leg-wins (breadth-sole → resume-eligible, else full-day lock), with per-leg classifier tests. |
| H3 | Re-halt counter restart semantics — in-memory reset bypasses chatter cap. | **APPLIED (accept-and-document)** | Adopted the review's recommended option (1): documented the more-permissive restart quirk in §3, mitigated by the persisted lock + fresh resume requirement, and logged persisting `stress_rehalt_count` as LOW tech-debt — no varchar hack now. |
| H4 | Paper-only enforcement — no code-level mode gate. | **APPLIED** | Added `MARKET_STRESS_AUTO_RESUME_ENABLED` boot flag (review's safer option a): paper-default-on, live-default-off, explicit override to enable live; constant within a run so determinism is preserved. |

### Should-fix (review M-series)

| # | Finding | Verdict | Rationale |
|---|---------|---------|-----------|
| M1 | `emitMarketStressIfTransitioning` dedup may suppress a same-day re-halt alert after auto-resume. | **APPLIED** | Engine scope now requires verifying the `stressEmittedForDate` interaction; added a same-tick resume→re-halt test asserting a fresh `RISK_HALT_TRIGGERED` still fires. |
| M2 | Analysis/dashboard `halt_reason = 'market_stress'` exact-match queries miss suffixed rows. | **APPLIED (audit step)** | Added a read-only post-deploy audit step for `selectHaltState.ts` and funnel SQL to prefix-match; no planned code edit unless a consumer uses exact match. |
| M3 | `MARKET_STRESS_RESUMED` payload should add `utcDateString` and cap-proximity. | **APPLIED** | Payload extended with `utcDateString` and a `nearReHaltCap` boolean; reflected in the event-wiring scope row and the event test. |
| M4 | Dedicated backtest replay parity test beyond unit mocks. | **APPLIED** | Added a non-mocked replay test (collapse → recovery → resume → entry admitted) through the same `RiskGateService` branch to prove `BacktestRunnerService` exercises auto-resume. |
| M5 | Stale-halt procedure must cover suffixed reasons, not just bare. | **APPLIED** | Post-deploy step 2 now matches `halt_reason LIKE 'market_stress%'`, covering both bare and `market_stress:breadth` rows. |
| M6 | Merge overlapping breadth-calibration tech-debt rows. | **APPLIED** | Deferred-items and scribe wave now specify a single merged breadth-calibration row with sub-bullets (N, resume hysteresis band, signal-dependent N). |

### Decision-critique amendments (review §§1–10)

| Critique | Finding | Verdict | Rationale |
|----------|---------|---------|-----------|
| #1 | Leg classifier must cover `same_bar`; document multi-leg precedence. | **APPLIED** | Same resolution as H2 (most-conservative-leg-wins, `:multi`). |
| #2 | Add integration test: breadth halt + BTC still shocked → resume allowed (leg-scoped). | **APPLIED** | Added to the test plan, plus the conjugate `:multi` no-resume case. |
| #3 | Hysteresis inner band (30) reuses old M19 engage value — validate after longer soak. | **APPLIED** | Logged as a sub-bullet of the merged breadth-calibration tech-debt row (validate against per-bar autocorrelation after 30–60 day soak). |
| #4 | N=3 acceptable to ship as default; add telemetry on `clearCountAtResume` for tuning. | **PARTIAL** | N=3-as-starting-point already in plan; clear-count is already in the `MARKET_STRESS_RESUMED` payload and daily-monitoring step, which gives the tuning telemetry — no further change needed. |
| #5 | Re-halt cap restart reset is a gap. | **APPLIED** | Same resolution as H3. |
| #6 | Suffix encoding — canonical strings + double-prefix fix. | **APPLIED** | Same resolution as H1. |
| #7 | In-process tick counting correct; document "~15 min at normal cadence" operator-facing. | **APPLIED** | ADR §6 amendment scope now carries the operator-facing wall-clock note; plan §6 already frames ticks-not-minutes. |
| #8 | Paper-only enforcement via env flag (option a). | **APPLIED** | Same resolution as H4. |
| #9 | Defer surge cooldown to M24; escalate to HIGH if soak shows surge-resume entries. | **APPLIED** | Deferred item + scribe wave now carry the conditional HIGH escalation tied to `MARKET_STRESS_RESUMED` surge events. |
| #10 | Same-tick resume→re-halt control flow correct; add dedup-emit QA case. | **APPLIED** | Same resolution as M1; QA case added. |

### Out-of-scope items (review §"Consciously out of scope") — agreed

Post-resume directional cooldown (M24), auto-resume for non-breadth legs, N calibration from the
full per-bar series, `risk_state.updated_at` (M11), and dashboard UI changes are all confirmed
out of M23 scope, consistent with the review. No rejections recorded — every Must-fix and
Should-fix was applied (H3/M2 as accept-and-document / audit-step variants), and the one PARTIAL
(#4) is already satisfied by existing telemetry hooks.
