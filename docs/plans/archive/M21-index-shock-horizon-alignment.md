# M21 — Index-shock horizon alignment (BTC/ETH to the 5-minute leg)

> **Sequencing note:** M21 lands **after** the three operational stress fixes already shipped
> directly to the running soak engine (2026-06-03/06-04): `STRESS_BREADTH_DISTANCE_PCT` raised
> 30 → 40 (halt at ≥90% / ≤10% breadth instead of ≥80% / ≤20%), and the
> `stress_same_bar_trigger_count` strategy param raised 5 → 50 (DB update). Both are live in the
> running engine. M21 closes the **last** miscalibration item from that soak review — the
> index-shock horizon mismatch — and is the architect's chosen **Option B: align both BTC and
> ETH to the 5-minute horizon** (decision 2026-06-04).

## Context

During the M19/M20 paper-soak window (2026-06-03 → 2026-06-04) the engine sat permanently
halted on miscalibrated market-stress thresholds. Two of the three contributing causes —
the dead/over-tight breadth distance and the too-sensitive same-bar trigger count — were
hot-fixed straight into the soak engine. The remaining cause is an **index-shock horizon
mismatch** baked into `StressHaltEvaluator.isIndexShock`:

- **BTC** is checked on the **1-minute** leg: `btc_1m_move_pct` against the strategy param
  `params.stress_btc_1m_shock_pct` (1.0% threshold). Over **5 days** of soak the 1m leg has
  **never fired** — its observed peak was **0.56%**, only 56% of the threshold. The 1m BTC leg
  is empirically non-functional as a stress signal at this granularity.
- **ETH** is checked on the **5-minute** leg: `eth_5m_move_pct` against the engine const
  `STRESS_ETH_5M_SHOCK_PCT` (2.0%). The reason BTC and ETH ended up on different horizons is a
  documented historical accident, annotated in `riskConsts.ts`.

The two index legs therefore measure **different time windows** — a structural inconsistency
that makes the BTC stress gate both slower to reason about and, at 1m, effectively inert. The
soak data gives us a clean calibration basis to fix it.

**Decision (architect, 2026-06-04) — Option B, align both legs to the 5m horizon:**

- Switch BTC from `btc_1m_move_pct` → `btc_5m_move_pct`. The 5m field **already exists** on the
  snapshot contract (`IMarketSnapshot`, mapped in `marketSnapshotMapper.ts:36`, declared on
  `IVolatilityDetectedEvent.ts:36`) — **no new field wiring** is needed.
- New engine-side const `STRESS_BTC_5M_SHOCK_PCT = 1.5`. Calibrated: the soak's `btc_5m_move_pct`
  peak was **1.04%**; 1.5% gives a real buffer above observed normal-market movement while still
  catching a genuine index shock.
- Raise `STRESS_ETH_5M_SHOCK_PCT` **2.0 → 2.5**. Calibrated: the **only** observed near-event was
  **2.12%** (single occurrence in 5 days); 2.5% lifts the gate above that one-off, and the
  breadth halt covers the same kind of market-wide event as a backup.

> **Two different changes, not one (all three independent reviews flagged this — keep them
> distinct when reasoning about calibration):** the BTC leg is **not** a "loosen halts" change —
> the old 1m leg never fired in soak (peak 0.56% vs 1.0% floor), so moving BTC to **5m @ 1.5%**
> *activates a previously inert stress sensor* with a new measurement window and a new control
> knob (engine const, not strategy param). Expect **more** BTC-driven index halts than the soak
> implied on volatile macro/liquidation weeks — that is the intended trade for having a
> non-dead BTC leg, not a regression. Only the **ETH** change (5m @ 2.0 → 2.5) is a classic
> false-positive reduction (raising a floor above an observed near-event). The post-deploy
> telemetry below exists precisely because BTC 1.5% is a *reasonable first cut on five calm
> days*, not a statistically proven optimum.

**Threshold confidence (synthesised from all three independent reviews):** ETH 2.0 → 2.5 is
endorsed by all three as a good survival-first decision — it aligns with ETH's ~1.2–1.5×
short-horizon beta to BTC (a beta-consistent ETH floor against BTC 1.5% lands ~1.8–2.25%, so 2.5%
is *slightly conservative* — appropriate when the penalty is a **full UTC-day** halt of all
mean-reversion entries) and fixes the demonstrated 2.0% false positive. BTC 1.5% is endorsed as a
*reasonable first cut* (a ~1.5% rolling-5m BTC move is multi-σ in the compressed post-ETF vol
regime, i.e. genuine stress not microstructure noise) but **not** proven optimal from five calm
days. **Do not re-tighten ETH toward 2.0% without new evidence** (that would repeat the soak
failure mode). If post-deploy telemetry shows the BTC leg firing too often on days with no
co-incident breadth/OI/spread stress, the next band to consider is **1.75–2.0% BTC** before
touching ETH again; if too quiet, **1.25%** — but not below soak peak + epsilon without longer
telemetry (incorporated from independent review).
- `stress_btc_1m_shock_pct` and `stress_eth_1m_shock_pct` strategy params become **deprecated**
  (comment-only annotation in `strategyParamsSchema.ts`). **No schema removal** — historical
  replay/backtest must keep reading these JSON keys without a validation error.

This continues M19/M20's **code-only, migration-free** discipline: the change is a const swap
plus an evaluator-field swap plus deprecation comments. No DB write, no schema change. Only an
engine restart is required to pick it up.

## Scope

1. **Switch the BTC index-shock leg to the 5m horizon** in `StressHaltEvaluator`, reading the
   new const `STRESS_BTC_5M_SHOCK_PCT = 1.5` against `btc_5m_move_pct`.
2. **Raise the ETH 5m threshold** `STRESS_ETH_5M_SHOCK_PCT` 2.0 → 2.5.
3. **Atomic fail-closed swap (CRITICAL):** `hasInvalidStressInputs` must move its BTC NaN/finite
   guard from `btc_1m_move_pct` → `btc_5m_move_pct` **in the same commit** as `isIndexShock`.
   See "Critical implementation note" below.
4. **Deprecate** `stress_btc_1m_shock_pct` / `stress_eth_1m_shock_pct` in
   `strategyParamsSchema.ts` via comment-only annotation (keys retained, still validated/readable).
5. **ADR 0004 §6 → add §6c** documenting the horizon alignment, the calibration evidence, and the
   flash-crash blind-spot deferral. §6c **supersedes** (replaces, not appends) the §6 threshold
   bullets that still describe `stress_btc_1m_shock_pct` as the active BTC shock path — see §6c
   content requirements below (all three reviews: §6 prose is stale pre-M21).
6. **Tech-debt entries:** flash-crash sub-minute blind spot (MEDIUM); deprecated-param removal
   (LOW); orphan `tieringConsts` shock-const drift (MEDIUM — see item 8).
7. **Downstream test/fixture sweep (CRITICAL for correctness — all three reviews):** stress is
   exercised via `btc_1m_move_pct` in suites beyond `StressHaltEvaluator.spec.ts`. After M21 a
   shocked 1m with a calm 5m must **no longer** halt on the index leg; those fixtures must migrate
   to `btc_5m_move_pct` / `eth_5m_move_pct` or they silently encode the **old** contract. See the
   QA wave and "Test blast radius" below.
8. **Orphan `tieringConsts` shock constants (MEDIUM tech-debt, log only — not a code change this
   milestone):** `apps/engine/src/market-data/const/tieringConsts.ts` defines a **different**
   `BTC_5M_SHOCK_PCT = 3` / `ETH_5M_SHOCK_PCT = 4` used only by the unused
   `MarketContextService.stressInputs()` — they do **not** drive `StressHaltEvaluator`. They are
   left untouched by M21 but invite operator confusion (two "BTC 5m shock" numbers coexisting:
   1.5 vs 3). Scribe logs this as MEDIUM tech-debt to align-or-delete after M21 (incorporated from
   independent review).

**Out of scope:** any new snapshot field (5m already exists); re-tuning OI/funding/spread/breadth
thresholds (breadth and same-bar already hot-fixed; spread untouched); removing the deprecated
param keys from the schema (LOW, future cleanup); `classifyFlowType` / flow-routing changes; any
DB migration or `strategy_versions` write.

## Critical implementation note — two-edit atomicity

`StressHaltEvaluator` has **two** places that reference the BTC index leg, and they must change
**together in one commit**:

- `isIndexShock()` — reads `btc_5m_move_pct` against `STRESS_BTC_5M_SHOCK_PCT` (the new behavior).
- `hasInvalidStressInputs()` — the fail-closed NaN/non-finite guard that forces a halt when a
  stress input is unparseable.

Today `hasInvalidStressInputs` guards `btc_1m_move_pct`. If `isIndexShock` is switched to
`btc_5m_move_pct` but the guard is **not** switched in the same change, the fail-closed
guarantee **silently breaks**: a NaN/garbage `btc_5m_move_pct` would flow into `isIndexShock`
without being caught by the input-validity halt — the gate would no longer fail closed on a
malformed BTC 5m value. The two edits are a single logical change; the QA wave must include a
paired test (`NaN btc_5m_move_pct → halts via hasInvalidStressInputs`) that would fail if the
guard edit is dropped.

## Boundary and measurement semantics (lock before QA)

- **Inclusive boundary (`>=`):** both index legs use `>=` today (`Math.abs(...) >= threshold` →
  stressed). M21 keeps that convention. State explicitly so QA uses the same boundary as the
  existing ETH tests: **at exactly the const → stressed; just below → silent** (all three reviews
  asked for this to be locked in the plan and in §6c).
- **Rolling-window, not candle close-to-close:** `btc_5m_move_pct` / `eth_5m_move_pct` are the
  **rolling N-minute tape move at bar-close** sourced from `MarketContextService` (`referenceMove`,
  5m window) — the same rolling-window semantics the idiosyncrasy numerator uses at trigger time,
  **not** OHLC close-to-close. §6c must say this in words so an operator calibrating from a candle
  chart does not misread the peaks (incorporated from independent review — Composer).

## Test blast radius — fixtures still on BTC 1m (CRITICAL)

The QA wave must reach **beyond** `StressHaltEvaluator.spec.ts`. The following suites drive stress
via `btc_1m_move_pct` and will, after M21, either pass while asserting the **old** contract or fail
without a clear migration story:

- `apps/engine/tests/risk/service/RiskGateService.spec.ts` (integration-style stress → halt
  persistence; uses `btc_1m_move_pct: 2.0` / `5.0`)
- `apps/engine/tests/risk/adversarial/M4-adversarial.spec.ts` (`btc_1m_move_pct: 5.0`)
- `apps/engine/tests/risk/RiskGateService.bus.spec.ts` and its `.bus.adversarial.spec.ts` variant

These must migrate index-stress triggers to `btc_5m_move_pct` (and `eth_5m_move_pct` at the 2.5
boundary). The `describe('BTC 1m shock trigger')` block in `StressHaltEvaluator.spec.ts` is renamed
to 5m semantics. This is the highest-confidence finding across all three independent reviews — do
not scope QA to a single spec file.

## Change set

| Workspace | Files (representative) | Item |
|-----------|------------------------|------|
| `packages/shared/` | `src/schema/strategyParamsSchema.ts` (deprecation comments on `stress_btc_1m_shock_pct` / `stress_eth_1m_shock_pct`; keys retained) | 4 |
| `apps/engine/` | `src/risk/const/riskConsts.ts` (add `STRESS_BTC_5M_SHOCK_PCT = 1.5`; raise `STRESS_ETH_5M_SHOCK_PCT` 2.0 → 2.5; update the historical-accident annotation); `src/risk/service/StressHaltEvaluator.ts` (`isIndexShock` BTC leg → 5m; `hasInvalidStressInputs` guard → 5m, **same commit**) | 1,2,3 |
| `apps/engine/` (tests) | `tests/risk/service/StressHaltEvaluator.spec.ts` (BTC 5m fires/silent at the new threshold; ETH at 2.5; NaN-btc_5m_move_pct fail-closed) | QA |
| docs | ADR 0004 §6c amendment; `docs/tech-debt.md` (flash-crash MEDIUM, deprecated-param LOW) | 5,6 |

No dashboard work this milestone (no new reject reason, no new funnel surface). No `apps/mcp` /
`apps/agent` touch.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`**: amend **ADR 0004 §6 → §6c**. §6c must **supersede** the §6
   threshold bullets that still describe `stress_btc_1m_shock_pct` as the active BTC shock path
   (replace, do not append ambiguously). §6c records:
   - Both index legs now on the **5m horizon**, engine consts `STRESS_BTC_5M_SHOCK_PCT = 1.5` /
     `STRESS_ETH_5M_SHOCK_PCT = 2.5`.
   - Calibration evidence (BTC 5m peak 1.04% → floor 1.5; ETH only event 2.12% → floor 2.5; BTC 1m
     never fired in 5 days, peak 0.56%).
   - **Inclusive `>=` boundary** and **rolling-window (not candle close-to-close) measurement**
     semantics in words (so operators calibrating from candle charts read peaks correctly).
   - `btc_1m_move_pct` **remains on the snapshot** for telemetry/idiosyncrasy but **exits the
     stress-halt contract** entirely (including its fail-closed guard — see §M3 rationale) so a
     future engineer does not "restore" it without a consumer.
   - The **flash-crash sub-minute blind spot** as an accepted deferral with rationale (the 1m leg
     was empirically non-functional; spread-widening + same-bar trigger are the better fast-stress
     proxies).
   Locked-decision / threshold change → architect runs **before** any code lands.
2. **Serial — `bot-shared-maintainer`**: deprecation comments on `stress_btc_1m_shock_pct` and
   `stress_eth_1m_shock_pct` in `strategyParamsSchema.ts`. **Comment-only — keys stay in the
   schema and stay readable** (historical replay must not error on these keys).
3. **Serial — `bot-engine-nestjs`**: `riskConsts.ts` (`STRESS_BTC_5M_SHOCK_PCT = 1.5`; raise
   `STRESS_ETH_5M_SHOCK_PCT` → 2.5; update annotation) **and** `StressHaltEvaluator.ts`
   (`isIndexShock` BTC → 5m **and** `hasInvalidStressInputs` guard → 5m **in the same commit** —
   carry the atomicity note above into the dispatch). Single engine dispatch; two tightly-coupled
   files, well under the cap.
4. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - BTC index shock on `btc_5m_move_pct`: **fires** at / above 1.5% (inclusive `>=`), **silent**
     just below (boundary at the const); confirm the old 1m field no longer drives the decision.
   - ETH index shock at the raised **2.5%** floor: fires at/above, silent just below (and the
     prior 2.12% event no longer halts on the ETH leg alone).
   - **Contrast test (horizon-swap proof — all three reviews):** shocked `btc_1m_move_pct` with a
     **calm** `btc_5m_move_pct` → **not** index-stressed; shocked `btc_5m_move_pct` with a calm
     1m → **stressed**. This is the test that catches a half-applied swap.
   - **Fail-closed (the atomicity proof):** `NaN` / non-finite `btc_5m_move_pct` →
     `hasInvalidStressInputs` true → halt. This test fails if the guard edit is dropped.
   - **Downstream fixture migration (do not skip — see "Test blast radius"):** migrate index-stress
     scenarios in `RiskGateService.spec.ts`, `M4-adversarial.spec.ts`, and the bus specs from
     `btc_1m_move_pct` to `btc_5m_move_pct` / `eth_5m_move_pct` at the new constants. Add **at least
     one RiskGateService-level case**: calm 1m + shocked 5m → `MARKET_STRESS` halt persisted.
   - Update any fixture/comment that referenced `btc_1m_move_pct` or the old ETH 2.0 threshold, and
     **refresh the stale `STRESS_BREADTH_DISTANCE_PCT` comment in `StressHaltEvaluator.spec.ts`**
     (header says 30; live const is **40** after the June hotfix) while the file is open.
5. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code`
   + **`bot-review-quant`** (the quant reviewer owns the threshold calibration: 1.5/2.5 vs the
   observed 1.04% / 2.12% / 0.56% soak peaks, and the blind-spot trade-off). The quant reviewer
   must also **confirm the backtest stress path uses the same `StressHaltEvaluator` semantics after
   M21** — `BacktestRunnerService` sets `btc1mMovePct: 0` and populates `btc5mMovePct`, so M21
   *improves* BTC index-shock fidelity on replay (was effectively ETH-only + other legs). Historical
   replays with real BTC bars may show **changed (higher) index-halt frequency** — this is expected,
   not a regression; flag it so replay reviewers are not surprised (cf. M19's backtest breadth-seeding
   blocker). Cycle fix→re-review until zero blockers, zero highs, majority mediums.
6. **Serial — `bot-scribe`**: `docs/milestone-log.md` (include the **expected changed BTC
   index-halt frequency on historical replay** so future regression-debuggers expect it),
   `docs/work-log.md`, CLAUDE.md status line, `docs/plans/00-overview.md` RiskModule note (BTC/ETH
   both 5m), `docs/tech-debt.md` (flash-crash MEDIUM, deprecated-param LOW, **orphan
   `tieringConsts` 3%/4% shock-const drift MEDIUM — align-or-delete after M21**), record the
   **stale-halt rollout outcome** (whether today's `risk_state` needed a `clearHaltForDate`), and
   confirm the ADR 0004 §6c amendment is linked.

Orchestrator verifies the actual diff after every wave (agent summaries describe intent, not
reality) — and **explicitly diffs `hasInvalidStressInputs` alongside `isIndexShock`** to confirm
the atomic swap actually landed.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M21 is code-only and migration-free** — no schema change, no `strategy_versions` write, no DB
touch at all. The deprecated params are annotated, not removed, so no data is rewritten. Picking
up the change requires only an **engine restart**. No `-v`, no down/revert on the live soak.

**Backup rotation:** before the engine restart, take a routine `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`,
into the gitignored `backups/` folder). **Keep the 3 most recent `backup_` files; prune older
ones** to bound disk use. Show the user the dump path before restarting.

### Stale-halt rollout step (HIGH — all three reviews; same class as M19)

M21 is picked up by **engine restart only**, and `RiskGateService` short-circuits on the persisted
day-halt **before** re-evaluating stress (`if (state.today.isHalted) return GLOBAL_HALT;`). A row
already flipped under the **old** ETH 2.0% floor (or any other stress leg) will **survive the
restart** until UTC rollover — M21 stops *new* false index halts but does **not** auto-clear an
existing one. This is the exact M19 operational-follow-up pattern.

**Rollout procedure (after the restart, read-only first):**

1. Inspect today's `risk_state` row.
2. If it is **not** halted, nothing to do.
3. If `is_halted = true` and `halt_reason = market_stress`, **distinguish the two failure modes**
   before acting: (a) a **stale persisted halt** from yesterday's/old-threshold logic, vs (b) the
   **new** thresholds still firing on a genuinely stressed live tape. Check that live snapshots are
   calm under the **new** floors (`btc_5m_move_pct` < 1.5, `eth_5m_move_pct` < 2.5, no other stress
   leg active).
4. Only if it is a confirmed **stale** false halt on a calm tape: clear **today's** row via
   `clearHaltForDate` — **dump first + explicit user confirmation in the same turn** per CLAUDE.md
   #8/#9 (never a blanket clear; today only). The alternative, if the operator prefers, is to simply
   **wait for UTC rollover** and judge trade flow on the next clean day.

This step is part of M21's definition of done — without it, the 30-minute calm-market check below
could measure a row halted *yesterday* rather than the new logic.

## Verification

- **Unit:** `rtk jest` for `risk/service/StressHaltEvaluator` green; full `src/risk` suite green;
  shared schema tests green (deprecated keys still parse).
- **Atomic-swap proof (the load-bearing test):** the new `NaN btc_5m_move_pct → halt` case is
  present and green; it would fail if `hasInvalidStressInputs` were left on the 1m field.
- **Threshold behaviour:** BTC fires at ≥1.5% 5m and is silent below; ETH fires at ≥2.5% and is
  silent at the prior 2.12% level on the ETH leg alone.
- **Boot:** engine boots and stays **running** after restart (no validation error from the
  retained-but-deprecated params; no DI/boot error). 10-min live app smoke per
  `feedback-milestone-app-smoke` — fix-and-report any boot error before the scribe.
- **Live operation:** **no market-stress false halt in the first 30 minutes** of live operation
  on a calm market (the soak's normal `btc_5m_move_pct` ~≤1.04% and `eth_5m_move_pct` stay under
  the new floors). `risk_state.is_halted` not flipped by either index leg on a calm tape.
  **Run this check only after the stale-halt rollout step above** so it measures the new logic, not
  a row halted yesterday.
- **Post-deploy calibration telemetry (read-only; part of the milestone, not optional — all three
  reviews):** for **14 days** after deploy, log the daily max `|btc_5m_move_pct|` /
  `|eth_5m_move_pct|` from `decisions.market_snapshot`, and count index-leg halts. Track the
  **near-miss bands** `|btc_5m| ∈ [1.2, 1.5)` and `|eth_5m| ∈ [2.0, 2.5)`. If the index leg fires
  on days with **no** concurrent breadth / OI / spread co-stress (a sign of remaining
  miscalibration), revisit the floors **before any cloud-soak scale-up** — and revisit with that
  distribution, not another short calm soak. BTC 1.5% is a *first cut*, validated on the first
  active macro week, not declared optimal from five calm days. (Read-only DB query — no write, no
  CLAUDE.md #8/#9 concern.)

## Success criteria

- BTC and ETH index-shock legs both evaluate on the **5-minute** horizon; the inconsistency is gone.
- Thresholds are calibrated to soak evidence (BTC 1.5% vs peak 1.04%; ETH 2.5% vs lone 2.12% event).
- The fail-closed guard moved to `btc_5m_move_pct` **in the same commit** as `isIndexShock`; the
  NaN-halt test proves it.
- Deprecated 1m params remain readable for historical replay (no validation break).
- Engine boots running; no market-stress false halt in the first 30 min of live operation.
- ADR 0004 §6c records the horizon change, calibration evidence, inclusive `>=` boundary,
  rolling-window measurement semantics, and the documented blind-spot — **superseding** the stale
  §6 BTC-1m threshold bullets.
- Downstream stress fixtures (`RiskGateService`, `M4-adversarial`, bus specs) migrated off
  `btc_1m_move_pct`; the horizon-contrast test (1m-shock/5m-calm → not stressed) is present.
- Stale-halt rollout step executed: today's `risk_state` inspected after restart and cleared only
  if it was a confirmed stale false halt on a calm tape (dump + user confirm), else UTC-rollover wait.
- 14-day post-deploy near-miss telemetry plan recorded for calibration close.
- Zero blockers, zero highs, majority mediums resolved at close. M21 is migration-free.

## Explicitly deferred

- **Flash-crash sub-minute detection (MEDIUM tech-debt).** A spike that blows out and recovers
  **within** a 5-minute window is invisible to the 5m gate. Accepted for now: the 1m BTC leg it
  replaces was empirically non-functional (never fired in 5 days, peak 0.56%), and spread-widening
  + the same-bar trigger count are better fast-stress proxies. Logged as MEDIUM for a future
  dedicated fast-stress signal, not a go-live blocker.
- **Removal of the deprecated params (LOW).** `stress_btc_1m_shock_pct` /
  `stress_eth_1m_shock_pct` stay in the schema (annotated) so historical replay keeps reading
  them. Physical removal is a future cleanup once no retained backtest fixture references them.

---

## Review Synthesis

Three independent reviews of this plan were read in full and synthesised here: GBT
(`docs/archive/independent-analysis/gbt/`), Gemini (`docs/archive/independent-analysis/gemini/`), and Composer
(`docs/archive/independent-analysis/composer/`). All three returned **approve-with-amendments** — no code
blockers, agreement that Option B is the right structural fix, the atomic `isIndexShock` +
`hasInvalidStressInputs` swap is load-bearing, and the milestone is correctly migration-free.

### Incorporated (unanimous — all three reviewers)

- **Stale-halt rollout step (H1/HIGH).** Added a dedicated "Stale-halt rollout step" under DB
  safety and a success criterion. M21 stops *new* false halts but does not clear a row already
  halted under old thresholds (`RiskGateService` short-circuits on the persisted day-halt) — same
  class as the M19 follow-up. Procedure distinguishes "stale persisted halt" from "new thresholds
  still firing" and clears today's row only on a confirmed false halt (dump + user confirm).
- **Wider test/fixture sweep (H2).** Added the "Test blast radius" section and expanded the QA
  wave to migrate `RiskGateService.spec.ts`, `M4-adversarial.spec.ts`, and the bus specs off
  `btc_1m_move_pct`, plus a RiskGateService-level "calm 1m + shocked 5m → halt" case and a
  horizon-contrast test. Without this, suites pass while encoding the old contract.
- **§6c supersedes §6** (does not append). Architect wave now spells out the full §6c content set.
- **Inclusive `>=` boundary** locked in the plan and §6c.
- **Intentionally drop `btc_1m_move_pct` from `hasInvalidStressInputs`** — documented in §6c so a
  future engineer does not restore it without a consumer.
- **Post-deploy near-miss telemetry** (14-day max-move + `[1.2,1.5)` / `[2.0,2.5)` bands) added to
  Verification as part of the milestone, not optional.
- **Breadth comment drift** (`STRESS_BREADTH_DISTANCE_PCT` header says 30; live is 40) — QA refreshes it.
- **Threshold confidence framing.** All three split M21 into two distinct changes (BTC = activating
  an inert leg + new knob; ETH = false-positive reduction) and endorsed ETH 2.5 strongly and BTC
  1.5 as a reasonable-but-monitored first cut. Folded into Context with the beta reasoning
  (~1.2–1.5× ETH beta → beta-consistent ETH floor ~1.8–2.25%, so 2.5% is slightly conservative)
  and an explicit "don't re-tighten ETH; next BTC band 1.75–2.0% / 1.25%" guidance.

### Incorporated (two of three)

- **Backtest/replay halt-frequency change** (Composer M5 + Gemini #4). Quant reviewer now must
  confirm backtest uses the same `StressHaltEvaluator` semantics; scribe records the expected
  higher BTC index-halt frequency on historical replay so it is not mistaken for a regression.

### Incorporated (one reviewer, judged valid on merit)

- **Rolling-window vs candle close-to-close measurement semantics** (Composer). §6c must state the
  fields are the rolling 5m tape move at bar close — a real operator-calibration trap worth one
  sentence. Added to Boundary/measurement semantics and the §6c content list.
- **Orphan `tieringConsts` shock-const drift** (Composer): `BTC_5M_SHOCK_PCT = 3` /
  `ETH_5M_SHOCK_PCT = 4` in an unused `MarketContextService.stressInputs()` path. Logged as MEDIUM
  tech-debt (align-or-delete) — not touched by M21 code, but two "BTC 5m shock" numbers coexisting
  invites confusion.

### Consciously rejected / already covered

- **Re-opening Option B or the BTC/ETH numbers.** Not reopened — the architect locked Option B and
  the floors on 2026-06-04; all three reviews *endorse* them. The plan strengthens the *reasoning*
  and adds monitoring rather than changing the decision.
- **Re-tightening ETH toward 2.0%.** Explicitly rejected (all three warn this repeats the soak
  failure mode); the plan now says so in writing.
- **Flash-crash sub-minute blind spot.** A conscious deferral, not an oversight — all three
  reviewers agree it is acceptable given the 1m leg was empirically dead and spread/same-bar are
  better fast proxies. Left as MEDIUM tech-debt as already planned; reasoning unchanged.
- **Any schema migration / param-key removal.** Out of scope by design (migration-free, replay-safe);
  no reviewer asked to add one.
- **Optional hardening to validate both 5m fields only in `hasInvalidStressInputs`** (GBT M3,
  Gemini #3) — this is the natural consequence of the swap (replace, not append), already captured
  by the atomicity note and §6c "exits the stress contract" wording; no extra plan change needed.
