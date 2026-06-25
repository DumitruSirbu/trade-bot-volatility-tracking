# M47 — Risk:Reward geometry fix (structurally inverted SL/TP across all strategy cores)

**Status:** Planned (queued behind the active milestone; see `docs/plans/README.md`).
**Scope:** Geometry fixes (engine cores + risk gate + one shared-schema/enum addition + a JSON-merge DB migration backfilling new params and adding geometry-coupled version rows v1.1/v2.1/v3.1) **+ MFE/MAE excursion fix** (close the async seed-timing race that starves the existing per-tick tracking — seeded synchronously from `ExecutionService` before the first await + best-effort historical backfill) **+ signal-quality data foundation** (read-only `position_segment_stats` analytics view for M48, partitioned by `strategy_versions_id`). Strategy-math change — pure, deterministic, live/backtest parity preserved (the gate R:R check anchors to the signal reference price in both live and backtest). **Non-rolling deploy** (stop → migrate → start; the `.strict()` schema forbids a partial-deploy window). The data-infrastructure additions touch no trade path and carry no live-trading risk.
**Owner modules:** StrategyModule (`momentumCore.ts`, `meanReversionCore.ts`, `computeStops.ts`), RiskModule (`RiskGateService.ts`), ExecutionModule (`ExecutionService.ts` — Task 5a seed call site, now injects `PositionInstrumentor`), PositionModule (`PositionInstrumentor.ts`), `packages/shared` (`RejectReasonEnum`, `strategyParamsSchema`).
**Related:** M43 (D2 long-TP cost-floor anchor — same `resolveTakeProfitDistance` seam), M38 (ADR 0045 — momentum TP fill-rebase, the seam Bug 2 lives on), M35 (trade-record integrity, MAE/MFE seeding), tech-debt **M7** (MAE/MFE seed-timing gap).
**ADRs touched:** 0003 (strategy contract — SL/TP coupling), 0045 (exit geometry — single-leg rebase), 0004 (risk gate — new R:R backstop). All amendments, not contradictions; architect re-blesses before the implementation wave.

---

## 1 — Problem statement

The bot loses money consistently. The root cause is **structurally inverted Risk:Reward geometry**: across every strategy core the protective stop (SL) and the take-profit (TP) are anchored to *independent* price references, so the realized SL distance routinely exceeds the TP distance. The trade is shaped to lose before any signal-quality consideration enters.

Quantified from the live closed-position record:

- **205 closed live positions, −259 USDT total realized PnL, 29.8% win rate.**
- **85% of trades enter with R:R < 1.0; 92% with R:R < 1.5; 95% with R:R < 2.0.**
- **85% of the total loss (−212 of −259 USDT) sits in the R:R < 1.0 bucket** — the inverted-geometry trades.
- Breakeven at the *average observed R:R* requires a **~61–80% win rate**; actual is **29.8%**. The geometry alone guarantees the strategy is a net loser at any realistic hit rate.

Two distinct bugs produce the inversion:

- **Bug 1 — Uncoupled SL/TP anchors** (all cores). SL and TP are computed from unrelated reference levels; nothing forces `tp_dist ≥ MIN_RR × sl_dist`. Large spikes blow out the SL while the TP stays fixed → R:R → 0.
- **Bug 2 — Asymmetric fill rebase** (momentum only, `momentumCore.ts:73` / ADR 0045 §D1). At fill time the TP is rebased to the actual fill price while the SL stays pinned at the static VWAP. A trade that passed the intent-time geometry check can finish with wrong-side or negative R:R after the rebase. This is the source of the negative-R:R rows in the DB.

---

## 2 — Root cause analysis

### Bug 1 — Uncoupled SL/TP anchors

**Momentum (`momentumCore.ts` → `buildMomentumExit`):**
- SL = `event.vwapSession` (the session VWAP). Its distance from entry is `|reference − vwap|`, which scales with the **spike size** — a big move puts VWAP far away, making the stop wide.
- TP = `entry ± atrTarget`, where `atrTarget` is `atr14 × multiplier` (SHORT) or `max(atr14 × longMult, costFloor)` (LONG, M43 D2). This is a **fixed ATR distance**, independent of how far VWAP sits.
- The two anchors never see each other. On a large spike `sl_dist ≫ tp_dist` → R:R collapses toward 0. The VWAP stop is correct as a *thesis-invalidation* level (a reversion back to VWAP kills the momentum thesis) — it must not be tightened. The error is that the TP is not widened to keep pace.

**Mean-reversion (`meanReversionCore.ts` → `buildMeanReversionExit`):**
- SL = `computeStructuralStop(...)` — just beyond the deviation wick, hard-capped at `entry × (1 ± hardCap%)` (`computeStops.ts`). A wide wick pushes the stop out to the hard cap.
- TP = `computeMeanReversionTakeProfit(...)` — a half-retrace toward VWAP (`vwap + (price − vwap) × OFFSET`). This is intentionally conservative and *inherently reachable*.
- Again independent. A wide structural stop against a conservative half-retrace TP yields R:R < 1 with no coupling to stop it.

### Bug 2 — Asymmetric fill rebase (momentum)

ADR 0045 §D1 makes the momentum TP `tpRebaseEligible: true` — the execution layer re-anchors it from the signal-time reference to the actual fill price (`takeProfit = fill ± atrDistance`). The SL, however, is the static `event.vwapSession` and is **not** rebased. So after a fill at a price different from the signal-time reference, the TP moves but the SL does not. The intent-time geometry guarantee is **void the instant a fill lands at a different price** — the R:R the gate approved is not the R:R the position holds. Single-leg rebase is the structural defect.

### Why the risk gate did not catch either bug

The gate (`RiskGateService.evaluateEntry`, lines ~465–477) runs three geometry checks:
1. `clampStopInsideLiquidation` → `SL_OUTSIDE_LIQUIDATION` — checks the stop is *inside liquidation*, says nothing about TP.
2. `isWrongSideTakeProfit` → `TP_WRONG_SIDE` — checks TP sign only.
3. `isTakeProfitBelowCost` → `TP_BELOW_COST` — checks `tp_dist > round-trip cost`, an *absolute* floor, **not** a ratio against `sl_dist`.

**None of the three compares `sl_dist` to `tp_dist`.** A trade with `sl_dist = 3%` and `tp_dist = 1.2%` passes all three (stop inside liq, TP correct side, TP clears cost) while carrying R:R = 0.4. Bad geometry is invisible to the gate.

### Exit-reason autopsy (the smoking gun)

| exit_reason | n   | avg SL dist% | avg TP dist% | avg PnL |
|-------------|-----|--------------|--------------|---------|
| stop_loss   | 26  | 1.17%        | 2.11%        | −5.04   |
| take_profit | 49  | 3.46%        | 1.11%        | +2.88   |
| time_stop   | 121 | 3.18%        | 1.45%        | −2.21   |

Two structural reads:
- **The time-stop is the dominant exit (121/205, 59%).** Wide SL + near TP means the trade rarely reaches either barrier inside the time window; it expires having realized a partial adverse move. Average time-stop PnL is negative.
- **Where SL is wide and TP is near (`take_profit` and `time_stop` rows: SL ≈ 3.2–3.5%, TP ≈ 1.1–1.5%), R:R is inverted at entry.** Even the *winning* `take_profit` rows have SL_dist > TP_dist — they only paid off because price happened to reach the near TP first. The expected value is negative across the board.

This is consistent with Bug 1: the SL is set by spike-driven anchors (VWAP / wick) and the TP by a fixed near distance, so the realized SL/TP ratio is inverted before the trade even begins.

---

## 3 — Scope

### In scope — eliminate inverted geometry

- Couple TP to SL at signal time in **both** cores so no trade is *shaped* with R:R below the core target (`min_rr`, provisionally 1.5).
- Fix the momentum single-leg rebase (Bug 2) so the geometry guarantee survives the fill.
- Add an independent **risk-gate backstop** (`RR_TOO_LOW`) at a *loose* floor (provisionally 1.0) that catches anything slipping past the cores — and binds every future strategy, not just today's two.
- Make `min_rr` a versioned, replayable strategy param so live and backtest agree and the value can be re-tuned.
- **Populate MFE/MAE excursion data** so `min_rr` can be validated empirically *post-deploy* (the per-tick tracking already exists; M47 closes the race that starves it):
  - **Fix the async seed-timing race** (Task 5a) — the per-tick MFE/MAE tracking already runs (`PositionInstrumentor.onPriceUpdate` → `applyTick`), but the accumulator is seeded via an async `POSITION_OPENED_EVENT` handler that does a DB round-trip, so entry-window ticks are silently dropped (tech-debt M7). Seed synchronously at open time so the entry-instant peak-risk window is captured. Signed convention preserved: `mfe_pct ≥ 0`, `mae_pct ≤ 0`.
  - **Best-effort historical backfill** — a one-shot harness that replays exchange OHLCV over each closed position's window to compute max favorable / adverse move (Task 5b). Best-effort because tick data may be unavailable for some symbols; partial backfill still feeds the `min_rr` baseline.
- **Signal-quality data foundation** (Task 5c) — a read-only `position_segment_stats` Postgres view that segments closed positions by `flow_type`, `symbol`, `strategy_version`, `side`, and `hour_of_day` with win rate / avg PnL / avg R:R / avg MFE / avg MAE / trade count per segment. This is the *data plumbing* M48 needs; it is **not** signal-quality logic and touches no strategy or trade path.

### Explicitly NOT in scope

- **Win-rate / signal-quality *fixes*.** At 29.8% win rate **every** R:R bucket loses money; the bucket distribution just controls *how much*. Fixing geometry stops the bleed from inverted trades; it does **not** make the strategy profitable. Entry confirmation, regime filtering, and signal-scoring *logic* are a **separate future milestone** (M48 — signal-quality / win-rate workstream). **Note:** M47 *does* build the read-only data foundation (Task 5c `position_segment_stats`) that M48 will query — the *fixes* are out of scope, the *data plumbing* is now in.
- **Profitability guarantee.** M47's success bar is "no trade enters with inverted geometry," not "the bot makes money."
- **SL philosophy changes.** The momentum VWAP stop and the mean-reversion structural stop are *correct as invalidation levels*; M47 does not move them except where the mean-reversion stop must be tightened to satisfy the ratio (Task 3). Momentum SL is never tightened (Section 5, Task 2 rationale).

---

## 4 — Critical sequencing

The coupling work (Tasks 2–4) is **void** unless prerequisites land in order. Two hard dependencies:

1. **Task 1 (shared schema + enum) lands first**, and a **DB param migration (JSON-merge, with `down()`) backfills `min_rr`/`entry_pct_floor`/`atr_floor_multiplier`/`max_tp_dist_factor` onto all existing strategy-version param rows AND adds the new geometry-coupled version rows (v1.1/v2.1/v3.1) before the engine deploys** (see Task 1) — otherwise persisted version rows fail the `.strict()` schema on load. **Non-rolling deploy: stop engine → run migration → start new engine.**
2. **Bug 2 (asymmetric rebase) is fixed (Task 0) before Tasks 2 and 4.** If the momentum TP rebases on fill while the SL does not, any geometry coupling done at signal time is destroyed the moment a fill lands off-reference. **Task 0 gates Task 2** (the momentum TP coupling is meaningless if it is rebased away at fill) **and Task 4** (the gate validates pre-fill geometry on `intent.proposedExit`; that check is only correct if the TP is frozen at signal time, i.e. Option B — see Task 4). Task 0 is therefore a prerequisite for both, not just Bug 2 remediation.
3. **Task 4 requires the backtest gate-geometry anchor to be the signal reference, not `nextBarOpen` (BLOCKER 1).** The gate R:R check must measure `sl_dist` / `tp_dist` against the **signal reference price** in both live and backtest, or live and backtest yield different R:R for the same signal (invariant 7 breaks). Live already sets `intent.entryPrice = reconstructReferencePrice(event)` (`StrategyService.ts:214`); backtest sets `intent.entryPrice = ctx.nextBarOpen` (`BacktestOrchestrator.ts:274`), a fill-price estimate. **Confirm a `referencePrice` (or equivalent signal-reference value) is available on the gate intent at intent-creation time in `BacktestOrchestrator`, carried separately from the `nextBarOpen` fill price**, before Task 4 is implemented. `nextBarOpen` may continue to feed PnL/sizing; it must not feed the gate geometry anchor.

**MFE/MAE excursion data (Task 5) is in-scope.** The per-tick tracking already runs (`PositionInstrumentor.onPriceUpdate` → `applyTick` → `updateMfePct`/`updateMaePct`); the columns read near-zero because of the **async seed-timing race** (tech-debt **M7**): the accumulator is seeded via an async `POSITION_OPENED_EVENT` → DB-round-trip handler, so entry-window ticks arrive before `positionsBySymbol` is populated and are silently dropped. M47 addresses this in three sub-parts:

- **Task 5a (fix the async seed-timing race)** runs **alongside the engine tasks** — it is an engine change in `PositionInstrumentor`'s position-open seeding path, touching a different service than the geometry tasks (no contention). It seeds the accumulator synchronously at open time so entry-window ticks are captured. After deploy, every new closed position carries real excursion data.
- **Task 5b (historical backfill)** runs **after positions close post-deploy** (and over the pre-deploy closed set, best-effort) to establish a baseline. True validation of the *new* geometry requires post-deploy trades (pre-M47 rows had inverted geometry), so `min_rr = 1.5` ships provisional and is confirmed or re-tuned in the first post-deploy review (see Section 8).
- **Task 5c (`position_segment_stats` view)** is a standalone DB migration + analytics view with no dependency on the geometry tasks; it can land in parallel any time after Task 1.

Sequencing (engine, in this order):

1. **Task 1 (shared schema + enum)** — add `min_rr`, `entry_pct_floor`, `atr_floor_multiplier`, `max_tp_dist_factor`; add `RR_TOO_LOW`.
2. **DB param migration** — JSON-merge backfill onto existing rows + add new version rows (v1.1/v2.1/v3.1); with a `down()` that JSON-removes the keys and drops the new rows. **Non-rolling deploy.**
3. **Task 0 (rebase, Option B mandatory)** — momentum `tpRebaseEligible: false`; architect re-blesses ADR 0045.
4. **Task 2 (momentum TP)** — add `rrFloor` to the `max()`, **capped** at `max_tp_dist_factor × atr14` (BLOCKER 5), with a degenerate-TP skip; thread `tpDist` into `takeProfitPrice` and `atrDistance`.
5. **Task 3 (mean-reversion SL)** — compute `tpDist` first, then `slCap = tpDist / min_rr`, then the **ATR-relative** `slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry)` (HIGH 1); refactored signature / DTO (HIGH 2); skip-as-degenerate when `slCap < slFloor`.
6. **Task 4 (gate backstop)** — `isRewardRiskTooLow` anchored to the **signal reference price** (BLOCKER 1, not `nextBarOpen`/`intent.entryPrice`), with a **div-by-zero guard** rejecting `sl_dist == 0` (BLOCKER 6), reading the clamped SL.

Parallel with the engine wave:
- **Task 5a (seed-race fix)** — engine change spanning `ExecutionService` (inject `PositionInstrumentor`; seed at **~:1056**, before the first await) + `PositionInstrumentor` (`applyEntryTick`). Touches a different open-path seam than the geometry tasks (no contention), but is **not** a pure `PositionInstrumentor`-only change (BLOCKER 2).
- **Task 5c (`position_segment_stats` view)** — standalone migration; **verify `stop_loss_price`/`take_profit_price`/`entry_price` columns exist first** (HIGH 6); partition by `strategy_versions_id` (BLOCKER 4).

Late:
- **Task 5b (historical backfill)** — post-deploy, after positions close under the new geometry (best-effort over the pre-deploy set for a baseline only).

---

## 5 — Fix design (detailed, sequenced)

### Task 0 — Fix asymmetric fill rebase (Bug 2, momentum) — PREREQUISITE
**Owner:** bot-engine-nestjs. **Touches:** `momentumCore.ts`, the execution rebase seam (ADR 0045 §D1), arm/backtest seams. **Contract touch → architect re-blesses ADR 0045 first.**

The momentum TP must not be rebased independently of the SL. **Option B is mandatory** — Option A is dropped from consideration:

- **Option B (no rebase) — REQUIRED.** Mark momentum TP `tpRebaseEligible: false`. Both legs stay at their signal-time price levels (TP at `reference ± atrTarget`, SL at VWAP). Geometry is fixed at signal time and never mutated. If the fill drifts materially from reference, the TP is no longer `fill ± atrTarget` — but the M38 fill-acceptance guard already rejects over-slippage fills (ADR 0045 §D2), bounding the drift.
- **Option A (rebase both legs) — NOT VIABLE, do not pursue.** At fill, re-anchoring *both* TP and SL from the actual fill price would preserve the signal-time distances, but the **gate validates pre-fill geometry** (Task 4 runs at intent time on `intent.proposedExit`) and **cannot be moved to fill-acceptance time without restructuring the gate architecture**. Under Option A the gate would approve a signal-time geometry that does not match what the position holds after the rebase. Option A also re-opens the "is the momentum stop a level or a distance" question that ADR 0003 settled, and a distance-preserved SL can land on the wrong side of the now-irrelevant VWAP. **Drop Option A from consideration.**

The invariant is: **no single-leg rebase, and no fill-time rebase at all for momentum.** Both legs stay frozen at signal time (Option B). Task 0 amends ADR 0045 §D1 to set momentum `tpRebaseEligible: false`; architect re-blesses.

Paired test: a fill at a price ≠ signal reference must yield a position whose `(sl_dist, tp_dist)` ratio is **unchanged from** the signal-time ratio (TP and SL both frozen) — and is never negative or wrong-side.

**Rebase-path audit (confirmed):** traced — only `ExecutionService.ts:1051` and `BacktestOrchestrator.ts:452` consume `tpRebaseEligible`. All other paths already set `false`. Setting momentum to `false` (Option B) fully closes the rebase path. No SL-update path during the position lifecycle re-introduces drift, so once both legs are frozen at signal time the geometry the gate approved is the geometry the position holds for its entire life.

**Audit completeness note (M2 — do not mistake `atrDistance` for dead code post-Option-B).** `BacktestOrchestrator.ts:187` (`applyTargetTpSlRatioOverride`) reads `proposedExit.atrDistance` directly **without** checking `tpRebaseEligible`. After Option B, `atrDistance` is still set — it equals the coupled `tpDist` (Task 2) — and the sweep tool needs it for momentum reference-reconstruction (HIGH 5). This is **intentional, not a bug.** Document so a future reader does not remove `atrDistance` thinking it is dead now that the fill-time rebase is gone. `atrDistance` survives as the single-composite-distance carrier (ADR 0045 §D1.2) and as the sweep-tool reference seed; only the *fill-time rebase consumption* of it is removed.

### Task 1 — Shared schema + enum (bot-shared-maintainer, serial, FIRST)
**Touches:** `packages/shared/src/enum/RejectReasonEnum.ts`, `packages/shared/src/schema/strategyParamsSchema.ts`.

- Add `RR_TOO_LOW = 'rr_too_low'` to `RejectReasonEnum`.
- Add the following **base (non-optional) params** to `baseSchema` in `strategyParamsSchema.ts` — every version carries them, they are versioned and replayable, and live/backtest read the identical value. (Note: `min_rr` is the *core target*; the gate's loose floor is a separate engine constant — see Task 4 — so that the binding constraint stays in version params while the backstop stays a code-level safety net.)
  - `min_rr: z.number().positive()` — the core R:R target (provisionally 1.5).
  - `entry_pct_floor: z.number().positive()` — the percent-of-entry noise floor for the mean-reversion SL (HIGH 1). **Unit convention: percent-number, not fraction** (e.g. `0.3` = 0.3%), to match the existing `structural_stop_hard_cap_pct` (which is `2.0` = 2%). Default `0.3`.
  - `atr_floor_multiplier: z.number().positive()` — the ATR-relative noise floor multiplier for the mean-reversion SL (HIGH 1). Default `0.3`. This is the **binding** noise-floor constraint for most signals; `entry_pct_floor` is the sanity bound for zero-ATR edge cases.
  - `max_tp_dist_factor: z.number().positive()` — caps the momentum `rrFloor` TP distance at `max_tp_dist_factor × atr14` to prevent an unreachable or negative TP on extreme spikes (BLOCKER 5). Default `5.0`.
  - **Naming note:** the fixed `min_sl_floor` param named in earlier drafts is **removed** — it is replaced by the ATR-relative pair (`atr_floor_multiplier`, `entry_pct_floor`) per HIGH 1. Do not reintroduce `min_sl_floor`.
- **DB param migration (separate from the seeder, runs FIRST; JSON-merge, never full-blob overwrite).** Strategy-version params are persisted rows validated on load against a `.strict()` schema. Adding these keys as non-optional means **every existing persisted version row fails schema validation the instant the new code deploys** unless the values are backfilled first.
  - The migration `up()` must be a raw SQL **JSON merge** that adds only the new keys, leaving every other key (including any production-tuned values) untouched:
    `UPDATE "strategy_versions" SET "params" = "params" || '{"min_rr": 1.5, "entry_pct_floor": 0.3, "atr_floor_multiplier": 0.3, "max_tp_dist_factor": 5.0}'::jsonb;`
    This is **NOT** the seeder. **The seeder must NOT be re-run against the live DB after M47 goes live** — `SeedStrategyVersions.ts` uses `ON CONFLICT DO UPDATE SET params = EXCLUDED.params`, a full-blob overwrite that would clobber production-tuned params back to `BASE_PARAMS`. Document in the runbook: **the seeder is CI/dev-bootstrap only post-M47.**
  - The migration `down()` must JSON-remove the new keys so a revert to the old schema is safe:
    `UPDATE "strategy_versions" SET "params" = "params" - 'min_rr' - 'entry_pct_floor' - 'atr_floor_multiplier' - 'max_tp_dist_factor';` and additionally drop the new version rows added below (v1.1, v2.1, v3.1).
- **New strategy version rows (BLOCKER 4 — clean partition key).** The coupling change is a behavioral change to v1/v2/v3. **M47 requires new strategy version rows for each version that receives geometry coupling — bump v1 → v1.1, v2 → v2.1, v3 → v3.1 (or the project's equivalent next-version numbering).** Old rows remain **immutable and read-only** (historical replay of pre-M47 inverted-geometry trades). The new rows carry `min_rr`, `entry_pct_floor`, `atr_floor_multiplier`, and `max_tp_dist_factor` in their params. The version bump is the clean partition key — it makes Task 5c's aggregates and Section 7's success metrics correct *by construction*, without relying on a fragile deploy-date window. (The JSON-merge backfill above still runs against the old rows so they continue to load under the new `.strict()` schema for replay.)
- **Version activation (do not silently nullify the milestone).** After inserting v1.1/v2.1/v3.1 rows, the migration must also set the `active` flag (or equivalent version-selection mechanism) to the new rows and clear it from the old rows. Verify how version selection works today (DB `active` column, engine config, or operator step) and document the exact activation step in the M47 deploy runbook. The bot must not trade under old uncoupled version rows after M47 deploys.
- **Non-rolling deploy required.** The `.strict()` schema makes a partial/rolling deploy unsafe: an un-migrated row fails on load and crashes strategy resolution. **M47 deploys non-rolling: stop engine → run param migration → start new engine binary.** Document this explicitly in the M47 deploy runbook.
- Seed the new params into the version seeder (`SeedStrategyVersions.ts`) **for the new version rows only**, so dev/CI bootstrap creates them with the defaults. This is the forward-looking complement to the migration, not a replacement for it — and it is **dev/CI-only post-M47** (see overwrite warning above). This is a contract + data change — route through bot-shared-maintainer and surface to the orchestrator.

> Per `dev-qa-cycle.md` §1.3: this is a contract touch. bot-shared-maintainer runs **before** engine work; the architect blesses the schema addition (does any ADR 0003 param-list clause need amending?).

### Task 2 — Momentum TP hybrid floor (bot-engine-nestjs)
**Touches:** `momentumCore.ts` (`resolveTakeProfitDistance` / `buildMomentumExit`). **Depends on Task 0 + Task 1.**

Add an R:R floor leg to the existing `max()` so the TP is *widened* (never the SL tightened) when the ATR leg would otherwise produce R:R below the core target:

```
slDist       = |reference − vwapSession|              # existing momentum stop distance
atrLeg       = atr14 × multiplier                     # existing ATR leg
costFloorLeg = round-trip cost + margin               # existing (M43 D2, LONG)
rrFloorRaw   = slDist × min_rr                         # NEW: couples TP to SL
rrFloor      = min(rrFloorRaw, max_tp_dist_factor × atr14)   # NEW: cap (BLOCKER 5)
tpDist       = max(atrLeg, costFloorLeg, rrFloor)      # add capped rrFloor to the existing max()
```

- The VWAP stop is the thesis invalidation — **do NOT tighten it** (rules out the "cap the SL" approach for momentum). The fix only ever *widens* the TP.
- Applies to both SHORT (currently bare `atr14 × mult`) and LONG (currently `max(atrLeg, costFloorLeg)`) — `rrFloor` joins the `max()` on both sides.
- `min_rr` and `max_tp_dist_factor` come from `params` (Task 1), read at the strategy layer (cores read strategy params, never risk params — preserve that boundary).
- **`rrFloor` cap (BLOCKER 5 — unbounded TP can go negative).** `rrFloorRaw = slDist × min_rr` is unbounded: on an extreme spike where VWAP sits 40%+ from reference, an uncapped SHORT TP (`reference − rrFloor`) can become negative or absurdly small, and a LONG TP can run to an unreachable distance. **Cap `rrFloor = min(slDist × min_rr, max_tp_dist_factor × atr14)`** where `max_tp_dist_factor` (default 5.0) is the versioned param added in Task 1.
- **Cap-bound sub-`min_rr` skip (BLOCKER 5, Invariant 1).** After the cap binds, check: if `tpDist / slDist < min_rr` (cap-bound sub-target — TP is valid but the cap prevented reaching the core R:R target), skip the signal as degenerate via `isDegenerateMomentumGeometry`. The core must refuse it; do not rely on the loose gate to catch a cap-bound sub-`min_rr` trade. This is the only way to preserve Invariant 1 when the cap applies.
- **Momentum degenerate-geometry skip (BLOCKER 5).** After capping, if the resulting TP price is still degenerate — `≤ 0` for a SHORT, or placed at an absurd multiple of entry for a LONG — **skip the signal as degenerate geometry**, mirroring `isDegenerateReversionGeometry` in mean-reversion. Add an `isDegenerateMomentumGeometry` (or equivalent) check in the momentum core. Do not ship a position with a non-positive or unreachable TP.
- The widened `tpDist` must be threaded verbatim into both `takeProfitPrice` and `atrDistance` (the M38 single-composite-distance invariant, ADR 0045 §D1.2 — computed once, never re-derived at the arm/backtest seams).
- **Sweep-tool note (HIGH 5).** `BacktestOrchestrator.applyTargetTpSlRatioOverride` (line 187) reads `proposedExit.atrDistance` to reconstruct the signal reference and re-derive the stop for an R:R sweep. **For momentum this works post-Task 2** — `atrDistance` now equals the coupled `tpDist` (including `rrFloor`), so the override reconstructs the correct reference. **For mean-reversion `atrDistance` is `null`** (Task 3 carries no ATR distance), so the override silently no-ops (line 191 guard). **Document: this sweep tool is momentum-only.** Mean-reversion `min_rr` sweeps require a different mechanism; do **not** use `targetTpSlRatioOverride` to validate `min_rr` empirically on reversion trades.

Paired test: a large-spike input where `atrLeg / slDist < min_rr` produces `tpDist == slDist × min_rr` (rrFloor binds); a small-spike input where `atrLeg / slDist ≥ min_rr` leaves the ATR leg unchanged (rrFloor inert); an extreme-spike input where `slDist × min_rr > max_tp_dist_factor × atr14` produces `tpDist` capped at `max_tp_dist_factor × atr14` (cap binds); an even-more-extreme input where the capped TP price would still be `≤ 0` (SHORT) is **skipped as degenerate** (no negative-TP position emitted). An extreme-spike input where `slDist × min_rr > max_tp_dist_factor × atr14` AND capped `tpDist / slDist < min_rr` → signal is **skipped** (not opened, not gate-rejected). Boundary: `capped tpDist / slDist == min_rr` exactly → passes (cap binds but ratio meets target). Both SHORT and LONG covered.

### Task 3 — Mean-reversion SL cap (bot-engine-nestjs)
**Touches:** `meanReversionCore.ts` (`buildMeanReversionExit`) and/or `computeStops.ts` (`computeStructuralStop`). **Depends on Task 1.**

The half-retrace TP is inherently reachable — **do NOT widen it**. Instead cap the structural stop by the TP:

```
tpDist  = |computeMeanReversionTakeProfit − reference|   # existing
slCap   = tpDist / min_rr                                  # NEW: max allowed stop distance
slDist  = min(structuralStopDist, slCap)                  # tighten stop when geometry demands
```

- `computeStops.ts` already hard-caps the structural stop at `entry × (1 ± hardCap%)`. Task 3 tightens it *further* when `tpDist / min_rr` is below the existing hard cap — an extension of the existing cap mechanism, not a new stop philosophy. Note the existing hard cap is an **upper** bound on `slDist`; it does nothing to stop the new cap going *too tight* — that is what the SL floor below guards.
- **Prescriptive computation order + signature refactor (HIGH 2).** `isDegenerateReversionGeometry` currently takes only `(event, tradeSide)` and has no access to `tpDist` / `min_rr` / `slCap`. The plan therefore prescribes:
  1. In `evaluateMeanReversion`, **compute `tpDist` first** (`|computeMeanReversionTakeProfit − reference|`), then `slCap = tpDist / min_rr`, then the noise floor (below).
  2. Pass `slCap` (and the noise-floor result) **into** `buildMeanReversionExit` and into the degeneracy check. `isDegenerateReversionGeometry` gains a new `slCap` parameter for the noise-floor case.
  3. If the signature change pushes any function past 2 args, group the related values into a `MeanReversionGeometryContext` DTO per clean-code F-rule (one named object, not a flat arg list).
  4. Pass `slCap` into `computeStructuralStop` via the widened signature (or DTO) so the `Money.min` / `Money.max` decimal math stays centralized in `computeStops.ts`. **The cap must always be computed downstream of `tpDist`** — never apply it inside `computeStructuralStop` alone without the TP context, because `slCap` cannot be known until `tpDist` exists.
- **Minimum SL floor — ATR-relative (HIGH 1).** On a small reversion opportunity `tpDist` can be tiny, so `tpDist / min_rr` could place the SL inside market noise — a hair-trigger stop that normal volatility trips immediately. The noise floor is the **larger** of an ATR-relative bound and a percent-of-entry sanity bound:
  ```
  slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor / 100) × entry)
  ```
  - `atr_floor_multiplier` (default 0.3) is the **binding** constraint for most signals — the SL must clear `0.3 × atr14` of noise.
  - `entry_pct_floor` (default 0.3, a **percent-number** matching `structural_stop_hard_cap_pct`'s `2.0`) is the sanity bound for zero-ATR / degenerate-ATR edge cases. It is divided by 100 to convert to a fraction of entry. **Unit convention: percent-number throughout** (Task 1) — do not mix fractions.
  - Both are **versioned params** (added in Task 1). The fixed `min_sl_floor` from earlier drafts is removed.
  - If `slCap` (`tpDist / min_rr`) falls **below** `slFloor`, **skip the trade as degenerate geometry** via `isDegenerateReversionGeometry` rather than ship a noise-tight stop.
- The existing degenerate-geometry skip (wrong-side VWAP) stays and is *extended* with the SL-floor case above — Task 3 operates only on geometrically valid fades.

Paired test: a wide-wick input where `structuralStopDist > slCap` (and `slCap` is above `slFloor`) yields `slDist == slCap` (cap binds, R:R == min_rr); a tight-wick input leaves the structural stop unchanged (cap inert); a tiny-`tpDist` input where `slCap` falls below `slFloor` is **skipped as degenerate** (no hair-trigger stop shipped). Boundary: `structuralStopDist == slCap` exactly, and `slCap == slFloor` exactly. Cover both the ATR-binding case (`atr_floor_multiplier × atr14` is the larger floor) and the pct-binding case (zero/near-zero ATR → `(entry_pct_floor / 100) × entry` is the larger floor).

### Task 4 — Risk-gate R:R backstop (bot-engine-nestjs)
**Touches:** `RiskGateService.ts` (insert check after `isTakeProfitBelowCost`, ~line 477), a new engine const `MIN_RR_GATE_FLOOR` in the risk const folder. **Contract touch (ADR 0004) → architect re-blesses first.**

- Add `isRewardRiskTooLow(intent)` → returns true when `tp_dist / sl_dist < MIN_RR_GATE_FLOOR` (**strict less-than**, so a trade exactly at the floor passes — see M1 below). Insert in `evaluateEntry` **after** `isTakeProfitBelowCost` and before `reserveAndApprove`; reject with `RejectReasonEnum.RR_TOO_LOW`.
- **Anchor the R:R distances to the signal reference price, NOT to `intent.entryPrice` (BLOCKER 1 — live/backtest anchor mismatch).** Live `StrategyService.ts:214` sets `intent.entryPrice = reconstructReferencePrice(event)` (the signal reference), but backtest `BacktestOrchestrator.ts:274` sets `intent.entryPrice = ctx.nextBarOpen` (a *fill-price estimate*). If the gate measured distances against `intent.entryPrice`, live and backtest would compute **different R:R for the same signal**, breaking invariant 7. The fix:
  - The gate R:R anchor is the **signal reference price** — the same anchor the cores used when they computed the SL and TP. Both `clampedExit.stopLossPrice` and `intent.proposedExit.takeProfitPrice` are already anchored to that reference, so the distances are well-defined relative to it.
  - Derive the distances from the SL and TP levels and the reference, **never from `nextBarOpen`**. Concretely, for a LONG: `sl_dist = referencePrice − stopLossPrice`, `tp_dist = takeProfitPrice − referencePrice` (mirror for SHORT). The `referencePrice` is the signal reference, available on the gate intent (live: equals `intent.entryPrice`; backtest: must be set to the reference — see below), **not** the fill estimate.
  - **`nextBarOpen` is a fill-price estimate for PnL/sizing — it must not pollute geometry anchors.** In backtest, the `intent.entryPrice` (or a dedicated `referencePrice` field carried on the intent) used for the gate geometry must be aligned to `reconstructReferencePrice(event)` at the strategy-evaluation stage, **separate** from the `nextBarOpen` fill price used by the sizer. `BacktestOrchestrator.ts:274` currently sets only `entryPrice = ctx.nextBarOpen`; it must additionally surface the signal reference for the gate geometry (carry a `referencePrice` on the intent, or set the gate-geometry anchor explicitly), so live and backtest measure the identical R:R.
  - **Implementation requirement:** confirm a signal-reference value is available on the gate intent at intent-creation time in *both* paths. In live it is `reconstructReferencePrice(event)`; in backtest it must be added alongside (not replacing) the `nextBarOpen` fill estimate. If no reference field exists on the intent contract, route the addition through bot-shared-maintainer with the other Task 1 contract changes.
- Compute `sl_dist` from the **clamped** exit (`clampedExit` — the gate may have already tightened the SL via `clampStopInsideLiquidation`), so the backstop sees the SL the position will actually hold, not the pre-clamp intent. Use `clampedExit.stopLossPrice` for SL and `intent.proposedExit.takeProfitPrice` for TP, **both measured against the signal reference price** (above). **Under Task 0 Option B the TP is never rebased, so the intent TP and the held TP are identical** — the gate therefore reads the clamped (already tightened, worst-case) SL plus the frozen intent TP, which is exactly the geometry the position will hold. This is why the check is sound under Option B.
- **Division-by-zero guard (BLOCKER 6).** The check computes `tp_dist / sl_dist`. If `sl_dist == 0` (VWAP == reference for momentum, or a degenerate wick for mean-reversion), this divides by zero. **Do not rely on `clampStopInsideLiquidation` (line 465) rejecting `sl_dist == 0` first — add a defensive check:** if `sl_dist == 0`, reject with `RR_TOO_LOW` (R:R is undefined / infinite-risk — the stop sits at the reference, which is degenerate). This guard is the reason the paired test for `sl_dist == 0` asserts a **reject**, not a divide-by-zero error.
- **Validity depends on Task 0 Option B (hard prerequisite).** This check is valid only because the TP is frozen at signal time. If the TP were rebased at fill (Option A), the gate would approve a geometry that does not reflect the held position — the gate runs pre-fill and cannot see the post-fill rebase. **Task 0 (Option B) is therefore a hard prerequisite for Task 4's correctness guarantee, not merely for Bug 2 remediation.**
- The comparator is deliberately strict `<` (at-floor passes), inconsistent with `isTakeProfitBelowCost`'s `≤` (at-cost rejects). This is intentional: the R:R floor is a *soft* backstop that should not reject borderline-acceptable trades, whereas the cost floor is a *hard* economic limit. Document this rationale in ADR 0004.
- The gate floor is a **loose backstop** (`MIN_RR_GATE_FLOOR ≈ 1.0`), **not** the core target (`min_rr ≈ 1.5`). The cores are the binding constraint that *shapes* geometry; the gate only catches pathological cases that slip through (e.g., post-clamp tightening that inverts a marginal trade). This separation is deliberate — see Section 9 (over-tightening risk).
- Gate floor lives as an engine const (code-level safety net), distinct from the version-param `min_rr` (the tunable target). Document the two-tier design in ADR 0004.
- This is a **defense-in-depth, strategy-agnostic** check: every future strategy core passes through it, so a new core that forgets to couple its legs cannot reach execution with inverted geometry.

Paired test: an intent with `tp_dist / sl_dist` just below `MIN_RR_GATE_FLOOR` rejects with `RR_TOO_LOW`; just above passes; boundary at exactly the floor passes (strict `<`). **Clamp-interaction tests (HIGH 3 — corrected).** The earlier "clamp widens the SL enough to invert the R:R" test is **impossible and is removed** — `clampStopInsideLiquidation` can only *tighten* the SL (move it toward the reference), which *improves* R:R; a widening clamp cannot occur. Replace with two correct cases:
- A trade whose SL is already inside liquidation (no clamp fires) but with R:R just below `MIN_RR_GATE_FLOOR` → `RR_TOO_LOW` reject.
- A trade with SL outside liquidation (clamp tightens it, *improving* R:R above the floor) → **passes** the R:R gate — the improvement is the intended behavior, and the gate reads the clamped (tightened) SL.

Plus the div-by-zero case (BLOCKER 6): an intent with `sl_dist == 0` (VWAP == reference) → `RR_TOO_LOW` reject, **not** a divide error. And the anchor-parity case (BLOCKER 1): the same signal through live and through the backtest seam yields the **identical** `tp_dist / sl_dist` at the gate, because both anchor to the signal reference price and neither uses `nextBarOpen`.

### Task 5 — MFE/MAE excursion data (INCLUDED — first-class, no longer deferred)
Relates to tech-debt **M7**. Three sub-parts: fix the async seed-timing race (5a), historical backfill baseline (5b), and the signal-quality data view (5c). Together they make the excursion data self-sustaining and trustworthy for a post-deploy `min_rr` review, and lay the data foundation for M48 without a separate plumbing milestone. (The per-tick MFE/MAE tracking already exists — 5a fixes the seeding race that starves it, it does not add tracking.)

#### Task 5a — Fix the async seed-timing race in `PositionInstrumentor` (root cause of tech-debt M7) (bot-engine-nestjs)
**Touches:** `apps/engine/src/position/service/PositionInstrumentor.ts` (add `applyEntryTick` or equivalent) + `apps/engine/src/execution/service/ExecutionService.ts` (inject `PositionInstrumentor`; call `onPositionOpened` + `applyEntryTick` synchronously at **~:1056**, immediately after `createPositionFromFill` returns and before `await recordEntryTransactionOrEscalate` (the next await on the open path)) + `ExecutionModule` (import `PositionModule` / `forwardRef` if cyclic). **Closes tech-debt M7's seed-timing gap for all new trades.**

**Decision note (insertion-point realism).** The INSERT performed by `createPositionFromFill` is the unavoidable first await on the open path — the position row does not exist before it. PRICE_UPDATE ticks arriving during that single sub-millisecond INSERT window are an accepted residual gap (Option A). Pre-registering a provisional in-memory stub before the INSERT (Option B) is explicitly out of scope unless post-deploy excursion data shows INSERT-window ticks are material.

**The tick-tracking code already exists and is not the problem.** `PositionInstrumentor` already subscribes to `PRICE_UPDATE_EVENT` (`onPriceUpdate`) and already calls `updateMfePct` / `updateMaePct` per tick (`applyTick`). Do **not** add "tick tracking" or "update `mfe_pct`/`mae_pct` on each price tick" — that is live and working. The signed-convention helpers in `instrumentationMath.ts` are also already correct: `mfe_pct ≥ 0` (favorable, updated by `max`) and `mae_pct ≤ 0` (adverse, **non-positive**, updated by `min`). Task 5a must not touch or re-derive this convention — corrupting it (e.g. treating MAE as a positive magnitude) would invert every adverse-excursion read.

**The actual root cause (tech-debt M7):** the accumulator is seeded via an `async` handler — `onPositionOpenedEvent` (`@OnEvent(POSITION_OPENED_EVENT)`) → `seedFromRow` → `await positions.findById`. That handler does a DB round-trip before it inserts the position into `positionsBySymbol`. Any `PRICE_UPDATE_EVENT` arriving during that async window hits `onPriceUpdate`, finds no entry in `positionsBySymbol`, and is **silently dropped** (the `positionIds === undefined` early-return). For a volatility-spike strategy the entry instant *is* the peak-excursion window, so the most important first-second samples are systematically lost — which is why `mfe_pct` / `mae_pct` read near-zero today.

**The fix — exact insertion point matters (BLOCKER 2).** The fix is **NOT** to add tick-tracking (it already exists) and it is **NOT** to merely replace the async event with a direct call at the current emit site. `POSITION_OPENED_EVENT` is emitted at `ExecutionService.ts:1144`, **after two awaited I/O round-trips** (`recordEntryTransactionOrEscalate` at ~:1087, `protectiveAttacher.attach` at ~:1106). A direct call at :1144 would insert the seed *after* both awaits, leaving the drop-race exactly as-is. The seed must go immediately after `createPositionFromFill` returns and before `await recordEntryTransactionOrEscalate` (the next await on the open path):

- **Insertion point: `ExecutionService.ts:~1056`, immediately after `createPositionFromFill` returns and BEFORE `await recordEntryTransactionOrEscalate` (~:1087).** Call `positionInstrumentor.onPositionOpened(positionRow)` synchronously there. `createPositionFromFill` already returns the freshly-written row in memory; seeding from it registers the symbol in `positionsBySymbol` before control yields to any *subsequent* await, so no `PRICE_UPDATE_EVENT` arriving during the subsequent awaits is silently dropped.
- **Seed the entry-tick excursion immediately at open time.** `onPositionOpened` only *registers* the symbol; it does **not** call `applyTick`. Registering at :1056 closes the drop-race but does not capture an entry-tick excursion sample. So immediately after `onPositionOpened`, call `positionInstrumentor.applyEntryTick(positionRow)` (or equivalent) that applies the entry/mark price as the initial excursion sample, yielding `mfe_pct = 0, mae_pct = 0` (excursion is zero at open because mark ≈ entry at that instant). This is the correct initial value under the signed convention.
- **Seed values are signed percentages, not price levels.** Seed `mfe_pct = 0, mae_pct = 0`. **Do NOT seed the entry price into these columns** — they are signed percentages (`mfe_pct ≥ 0`, `mae_pct ≤ 0`), not price levels. Corrupting the convention would invert every adverse-excursion read.
- **NestJS DI (BLOCKER 2).** `ExecutionService` (execution module) does **not** currently inject `PositionInstrumentor` (position module). Adding this injection creates a new module dependency. **Verify `ExecutionModule` imports `PositionModule` before implementation; if a cycle exists, use `forwardRef`** (note `PositionInstrumentor` already uses `forwardRef(() => RiskGateService)`, so the module topology has cycles — check carefully). DI/module-registration bugs are invisible to unit tests — **add a live-app smoke test at milestone close.**
- Keep the existing async re-seed branches (adoption-ack, reconcile-recover via `seedFromRow`) — those are recovery paths, not the open path, and are not the M7 race. The async `onPositionOpenedEvent` handler may remain for any non-open consumers, but it is no longer the open-path seeder. Only the open path moves to synchronous seeding.
- The signed convention is preserved verbatim (`mfe_pct ≥ 0` via `max`, `mae_pct ≤ 0` via `min`). Money math stays `decimal`. No new event, no strategy-logic touch, no risk-gate touch.
- **Why this is mandatory:** until the seed race is closed, every position opened after M47 deploys still loses its entry-window samples and the excursion columns stay near-zero — 5b's backfill alone would not make the data self-sustaining. Closing the race is what makes forward excursion data trustworthy.

Paired test (see Task 6 — must be `ExecutionService`-level): with the synchronous-seed path, a price tick delivered in the same logical instant as position-open is **captured** (not dropped) and updates the accumulator — assert the pre-fix behavior (tick dropped because `positionsBySymbol` not yet populated until after the two awaits) fails and the post-fix behavior records the entry-window excursion. Plus: the entry-tick seed yields `mfe_pct = 0, mae_pct = 0` at open; a subsequent sequence of ticks that move favorably then adversely yields `mfe_pct` == the peak favorable move (≥ 0) and `mae_pct` == the peak adverse move (≤ 0) — monotonic, never reset mid-position; both correct for LONG and SHORT `side`. Boundary: a flat tick stream leaves both at the seeded `0`.

#### Task 5b — Historical backfill harness (bot-engine-nestjs, best-effort)
**Touches:** a one-shot backfill script (analysis/ops harness) — no live trade path. Uses `context7-mcp` for the exchange OHLCV-fetch API before calling it.

- Replay exchange OHLCV over each closed position's `[opened_at, closed_at]` window and compute max favorable / max adverse move, writing `mfe_pct` / `mae_pct` onto the historical closed-position rows.
- **Best-effort:** tick/kline data may be unavailable or coarse for some symbols or older windows — record which positions were backfilled vs skipped; partial backfill is better than none. Do not fail the run on per-symbol gaps.
- **Purpose — establish a baseline, NOT validate the new geometry.** Be honest about what this can and cannot prove: **pre-M47 closed positions had inverted geometry**, so their realized MFE/MAE tells you about *badly-shaped* trades, not the correctly-shaped ones M47 produces. 5b therefore **establishes a baseline** and confirms the excursion pipeline works end-to-end; it does **not** validate `min_rr` for the new geometry. **True validation requires post-deploy trades opened under the new coupling — that is a follow-up review, not an in-milestone deliverable.** `min_rr = 1.5` ships as **provisional** and is confirmed or re-tuned in the first post-deploy review using the now-self-sustaining forward excursion data (5a).
- Read-only against live state except for the `mfe_pct` / `mae_pct` backfill writes on closed rows; never touches open positions (5a owns those) and never the trade path.

Paired test (harness-level): a closed position with a known synthetic OHLCV window produces the expected `mfe_pct` / `mae_pct`; a position whose symbol has no available kline data is skipped and logged, not errored.

#### Task 5c — Signal-quality data infrastructure: `position_segment_stats` view (bot-engine-nestjs migration + bot-scribe docs)
**Touches:** a DB migration adding a Postgres view (or materialized view) `position_segment_stats`. **No strategy logic, no trade path, no risk-gate change — read-only analytics infrastructure.**

- The view segments **closed positions** by `flow_type`, `symbol`, `strategy_versions_id`, `side`, and `hour_of_day`, exposing per segment: **win rate, avg PnL, avg R:R, avg MFE (`mfe_pct`), avg MAE (`mae_pct`), trade count.**
- **Partition by `strategy_versions_id` is the clean pre/post-M47 split (BLOCKER 4).** Because M47 bumps the geometry-coupled versions (v1→v1.1, v2→v2.1, v3→v3.1 per Task 1), the view partitions pre-M47 inverted-geometry trades (old version IDs) from post-M47 coupled-geometry trades (new version IDs) **by construction**, with no deploy-date arithmetic. Old version IDs are the baseline; new version IDs are the measurement set. Both are visible in the view simultaneously. Without the version bump, the `avg_rr` aggregate would silently mix old and new geometry under one ID, making Task 5c's M48 purpose (win rate by flow_type on *coupled-geometry* trades) dead on arrival.
- **Column-existence precondition (HIGH 6).** The `avg_rr` aggregate derives from price levels: `(take_profit_price − entry_price) / (entry_price − stop_loss_price)` for LONGs and the mirror for SHORTs. **Verify the `positions` table persists `stop_loss_price`, `take_profit_price`, and `entry_price` (or their equivalents) as columns before writing the view.** If any is missing, add it in the M47 migration. **Do not ship a view with a silently-null `avg_rr` column.** Verify column existence as the first step of Task 5c (it can otherwise run in parallel with the engine wave). Document in the view schema which anchor `avg_rr` uses (fill-anchored via `entry_price`). If signal-anchored R:R is needed for precise gap-band monitoring, add `signal_reference_price` to the `positions` table in the same migration.
- **Purpose:** after M47 deploys and new positions accumulate, query which flow types / symbols / trading sessions are profitable vs. losing **without writing ad-hoc SQL each time**. This is the *data plumbing* M48's signal-quality workstream needs — M47 builds the foundation so M48 needs no separate data-plumbing milestone.
- **Owner:** bot-engine-nestjs writes the migration; bot-scribe documents the view schema (segment keys + exposed aggregates + materialized-vs-plain choice and refresh cadence if materialized) in `docs/architecture/data-model.md`.
- `hour_of_day` derives from the position's open timestamp (document the timezone basis — UTC — in the schema doc so segment reads are unambiguous).
- Because it depends on `mfe_pct` / `mae_pct` being populated, **`avg_mfe_pct` and `avg_mae_pct` in the view are only meaningful after Task 5a fixes the seed-timing race** — until then the underlying columns read near-zero (the entry-window samples are dropped), so the aggregate excursion columns will read near-zero too. Note this dependency explicitly in the schema doc. (`avg_mae_pct` aggregates a non-positive column, `mae_pct ≤ 0` — do not present it as a positive magnitude.)

Paired test (migration-level): against a seeded fixture of closed positions spanning ≥2 `flow_type`s and ≥2 hours, the view returns one row per occupied segment with correct win-rate / avg-PnL / avg-R:R / avg-MFE / avg-MAE / count aggregates; an empty positions table yields zero rows (not an error).

### Task 6 — QA wave (bot-qa-engineer)
Per `dev-qa-cycle.md` §2: happy path is the floor, **adversarial is the bar**. Each fix item gets a paired test (fails before / passes after). Required coverage:

- **Per-task paired tests** (Tasks 0, 2, 3, 4 above) — boundary at exactly `min_rr` / `MIN_RR_GATE_FLOOR`.
- **Adversarial geometry:** zero ATR, zero deviation, VWAP == reference (degenerate), enormous spike (SL ≫ ATR), fill far off reference (Bug 2 regression), negative/wrong-side inputs.
- **Anti-coverage:** assert a trade with inverted geometry is **never** approved (gate rejects), and the cores **never** emit a signal-time R:R below `min_rr`.
- **Live/backtest parity:** the same input through the strategy core and through the backtest seam yields identical `(sl_dist, tp_dist)` — the M38/ADR 0029 determinism invariant.
- **Contract-violation simulation:** a fill that lands off-reference (crash/slippage window) does not produce a single-leg-rebased position.
- **MFE/MAE seed-timing race (Task 5a) — must be `ExecutionService`-level (BLOCKER 2 / HIGH 4):** the regression test must be at the **`ExecutionService` integration level, NOT the `PositionInstrumentor` unit level.** Assert `onPositionOpened` is called after `createPositionFromFill` returns and before `await recordEntryTransactionOrEscalate` and before `await protectiveAttacher.attach` — not at the :1144 event-emit site. A `PositionInstrumentor` unit test that delivers ticks in a chosen order does **not** reproduce the real async race (the two awaited round-trips between :1056 and :1144) and cannot serve as a regression guard. The key paired test: a price tick delivered at the same logical instant as position-open is **captured, not dropped** (pre-fix: dropped because `positionsBySymbol` not yet populated until after the two awaits; post-fix: synchronous seed at :1056 registers the symbol first). Plus: entry-tick seed yields `mfe_pct = 0, mae_pct = 0`; monotonic behavior under favorable-then-adverse tick sequences (`mfe_pct ≥ 0` via `max`, `mae_pct ≤ 0` via `min` — assert the signed convention is not inverted), LONG vs SHORT direction, flat-stream boundary leaves both at the seeded `0`; assert never reset mid-position. Add a **live-app smoke test** at milestone close to catch the new `ExecutionService → PositionInstrumentor` DI/module-registration wiring (invisible to unit tests).
- **Backfill harness (Task 5b):** known-OHLCV window → expected excursion; missing-kline symbol is skipped-and-logged, not errored (best-effort guarantee).
- **`position_segment_stats` view (Task 5c):** correct aggregates over a multi-segment fixture; empty-table → zero rows; segment keys partition without overlap.

Adversarial failures route to the **architect** (not the developer) per §2.2.

### Task 7 — Reviewer wave (parallel)
`bot-review-security` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-quant`, in parallel. **quant is the lead reviewer here** — the change is strategy-PnL math: verify the coupling direction (widen TP / tighten SL, never the reverse), verify the gate uses the clamped SL, verify live/backtest parity, verify the provisional `min_rr` rationale. Round-2+ reviewers resumed via `SendMessage` with the prior `agentId` (§3.1). Cycle until zero blockers, zero highs, majority of mediums resolved (§6.3).

### Task 8 — Scribe close-out (bot-scribe)
ADR amendments (0003 SL/TP coupling + the ATR-relative noise-floor params `atr_floor_multiplier` / `entry_pct_floor` + new geometry-coupled version rows v1.1/v2.1/v3.1, 0045 momentum-rebase resolution = Option B / `tpRebaseEligible: false` + `max_tp_dist_factor` cap, 0004 R:R backstop + two-tier design + the strict-`<` vs `≤` comparator rationale + the signal-reference anchor (not `nextBarOpen`) + the `sl_dist == 0` div-by-zero reject), **`docs/architecture/data-model.md` (Task 5c `position_segment_stats` view schema — segment keys, aggregates, materialized-vs-plain choice, UTC `hour_of_day` basis, MFE/MAE dependency on 5a/5b, `avg_mae_pct ≤ 0` sign note)**, `docs/work-log.md`, `docs/milestone-log/archive/M47.md` + index row (test counts, reviewer rounds, bugs caught, the deploy order migration→engine, and that `min_rr = 1.5` ships provisional with the empirical review deferred to a post-deploy follow-up — **not** confirmed in-milestone), `docs/STATUS.md` rewrite, `docs/plans/README.md` status flip (ACTIVE→DONE), `CLAUDE.md` status pointer, **tech-debt update (mark M7 MFE/MAE seed-timing race RESOLVED by Task 5a; record the `position_segment_stats` foundation as the M48 enabler; record the post-deploy `min_rr` review as a follow-up)**. Per `dev-qa-cycle.md` §8, scribe is the **single writer** of working-memory docs.

> Every dispatch carries the `dev-qa-cycle.md` quick-reference boilerplate: ≤5 files/items, paired tests, architect on contract touches, reviewer continuity, orchestrator verifies every diff.

---

## 6 — Key invariants post-fix

After M47 lands, all of the following must hold permanently (assert each as a regression test):

1. **No trade enters with signal-time R:R < `min_rr`** (core target, provisionally 1.5) — both cores shape geometry, never emit a sub-target signal. Enforced by: (a) the core's coupling logic (rrFloor, slCap), (b) the cap-bound degenerate skip when the cap prevents reaching `min_rr`, and (c) the gate backstop as a last line of defence. All three are required — the gate alone cannot be the binding constraint for Invariant 1.
2. **No trade reaches execution with R:R < `MIN_RR_GATE_FLOOR`** (gate floor, provisionally 1.0) — the backstop rejects with `RR_TOO_LOW`, computed on the *clamped* SL.
3. **No rebase for momentum** — both legs stay frozen at signal-time price levels (Task 0 Option B, mandatory). No single-leg rebase and no fill-time rebase. The signal-time geometry guarantee survives the fill, which is what makes the Task 4 pre-fill gate check sound.
4. **The momentum VWAP stop is never tightened** to satisfy R:R — only the TP is widened.
5. **The mean-reversion half-retrace TP is never widened** to satisfy R:R — only the structural stop is tightened (capped).
6. **The gate backstop is strategy-agnostic** — every current and future strategy core passes through `isRewardRiskTooLow`; a new core cannot reach execution with inverted geometry.
7. **`min_rr` is versioned and replayable, and the gate R:R check is anchored identically in live and backtest** — both read the identical `min_rr` from version params, AND both compute `sl_dist`/`tp_dist` against the **signal reference price** (never `nextBarOpen`/the fill estimate), so the same signal yields the identical gate R:R in live and backtest (BLOCKER 1). Geometry is reproducible.
8. **Entry-window MFE/MAE is captured, not dropped** — `onPositionOpened` + `applyEntryTick` are called synchronously in the open path **after `createPositionFromFill` returns, before `recordEntryTransactionOrEscalate`** (`ExecutionService.ts:~1056`), so no entry-window tick arriving during the subsequent awaits is silently dropped. The signed convention holds: `mfe_pct ≥ 0`, `mae_pct ≤ 0`, seeded at `0` at open (BLOCKER 2).
9. **Pre/post-M47 trades are partitioned by `strategy_versions_id`** — geometry-coupled trades carry the new version rows (v1.1/v2.1/v3.1); pre-M47 inverted-geometry trades carry the old IDs. Success metrics and the segment-stats view read the split by version ID, not by deploy date (BLOCKER 4).

---

## 7 — Success metrics (how we know M47 worked)

Measured on **post-M47** closed positions, partitioned by **strategy version ID** (the new v1.1/v2.1/v3.1 rows from Task 1 BLOCKER 4) — **not** by a deploy-date window. The version bump is the clean partition key; pre-M47 inverted-geometry rows carry the old version IDs and post-M47 coupled rows carry the new IDs, so the read is correct by construction without date arithmetic:

- **R:R distribution shift (measured by version ID, BLOCKER 4):** share of trades entering with R:R ≥ 1.5 rises from ~8% (old version IDs) toward ~100% of *opened* trades on the new version IDs; share with R:R < 1.0 drops to ~0%. Query `positions` for `(tp_dist, sl_dist)` at entry, bucket the ratio, and **filter by `strategy_versions_id`** to compare the old (pre-M47) version IDs against the new (post-M47) version IDs. Note: `positions.entry_price` is the fill price; `stop_loss_price`/`take_profit_price` are signal-time levels (Option B). Success metrics here use fill-anchored R:R. Drift between fill-anchored and signal-anchored R:R is bounded by the M38 fill-acceptance guard. If false canary alarms occur due to fill drift, persist a `signal_reference_price` column and recompute the canary from it.
- **Gate rejection accounting:** `RR_TOO_LOW` rejection count is **low and bounded** in steady state (the cores shape geometry; the gate only catches edge cases). A *high* `RR_TOO_LOW` count signals the cores aren't coupling correctly — a regression flag. Break out via `getFunnelSummary` by reject reason.
- **Gap-band canary (core-coupling regression detector):** trades *entering* with R:R in `[MIN_RR_GATE_FLOOR, min_rr)` (between the gate floor 1.0 and the core target 1.5) should be **~0 in steady state**. The cores are supposed to shape every trade to R:R ≥ `min_rr`; anything landing in this band passed the loose gate but missed the core target, which means the cores are **not coupling correctly** and the fix has a hole. The `RR_TOO_LOW` rejection count alone is blind to this 1.0–1.5 gap (it only sees trades below the *gate floor*), so this band is the canary the rejection count cannot give you. Query `positions` (filtered on the new strategy version IDs) for entry R:R in `[1.0, 1.5)`; a non-zero rate is a regression flag. **Minimum-N gate (M1):** this canary fires as a regression alert only after **N ≥ 20** post-M47 trades — below 20 trades the band count is statistical noise, not a signal.
- **Backtest distribution shift:** re-run the backtest over a fixed window pre/post change; the R:R histogram shifts right with no live/backtest divergence (parity check).
- **Exit-reason mix:** the time-stop share (currently 59%) should *not* worsen catastrophically — wider TPs raise fill-probability risk (Section 9), so a moderate rise is expected and acceptable; a runaway rise toward ~100% time-stops signals TPs widened past reachability and needs `min_rr` re-tune.
- **Bleed elimination (the charter metric):** the R:R < 1.0 loss bucket (currently −212 USDT) goes to ~0 because no such trades are opened on the new version IDs. Measured by filtering `positions` on the new strategy version IDs (BLOCKER 4), not a deploy-date window. This is the bar — **not** net profitability (Section 3).
- **MFE/MAE populated and non-trivial (Task 5a):** with the seed-timing race fixed, `mfe_pct` and `mae_pct` are **non-null and capture the entry-window excursion on all new closed positions** post-deploy (signed convention intact: `mfe_pct ≥ 0`, `mae_pct ≤ 0`). The historical closed set is backfilled where exchange data exists (5b, best-effort — record coverage %). Query `positions` for null-count of both columns on the post-deploy window → expect zero, and spot-check that entry-window samples are no longer dropped (values are not near-zero).
- **`min_rr` review scheduled, not closed in-milestone (post-deploy):** M47 ships `min_rr = 1.5` provisional and produces trustworthy forward excursion data (5a) plus a baseline (5b). The empirical confirm-or-re-tune is a **post-deploy review** on trades opened under the new geometry; its outcome is recorded in the milestone log. M47 does not claim 1.5 is validated.
- **`position_segment_stats` exists and is correct (Task 5c):** the view returns correct per-segment aggregates (win rate / avg PnL / avg R:R / avg MFE / avg MAE / count) over the closed-position set, verified against a direct query on a sample segment. This is the M48 data-foundation gate.

---

## 8 — Configuration (proposed defaults — provisional)

| Param | Where | Default | Status |
|-------|-------|---------|--------|
| `min_rr` (core target) | `strategyParamsSchema` (version param, replayable) | **1.5** | **Provisional — ships at 1.5; confirmed or re-tuned in the first post-deploy review using forward excursion data. 5b establishes a baseline only.** |
| `atr_floor_multiplier` (mean-reversion noise floor, ATR-relative — **binding**) | `strategyParamsSchema` (version param, replayable) | **0.3** | **Provisional** — HIGH 1; `slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry)`; when `tp_dist/min_rr` falls below `slFloor` the trade is skipped as degenerate |
| `entry_pct_floor` (mean-reversion noise floor, %-of-entry — sanity bound) | `strategyParamsSchema` (version param, replayable) | **0.3** (percent-number = 0.3%, matching `structural_stop_hard_cap_pct`) | **Provisional** — HIGH 1; sanity bound for zero/near-zero ATR edge cases |
| `max_tp_dist_factor` (momentum `rrFloor` cap) | `strategyParamsSchema` (version param, replayable) | **5.0** | **Provisional** — BLOCKER 5; caps `rrFloor` at `max_tp_dist_factor × atr14` so an extreme spike cannot place the TP at a negative/unreachable price |
| `MIN_RR_GATE_FLOOR` (gate backstop) | engine const (`riskConsts.ts`) | **1.0** | **Provisional** — loose floor; cores are the binding constraint |

- **Unit convention (HIGH 1):** `entry_pct_floor` and `structural_stop_hard_cap_pct` are **percent-numbers** (`0.3` = 0.3%, `2.0` = 2%) — divide by 100 before applying to a price. `min_rr`, `atr_floor_multiplier`, and `max_tp_dist_factor` are plain multipliers. Do not mix the fraction (`0.003`) and percent-number (`0.3`) forms; the plan uses percent-number for percent-of-entry quantities throughout.
- **Deploy + versioning (BLOCKER 3/4):** the four version params are backfilled via a **JSON-merge** migration (never a full-blob seeder re-run) onto existing rows, and the geometry-coupled versions are bumped to **v1.1/v2.1/v3.1** new rows. Deploy is **non-rolling** (stop → migrate → start). Old rows stay immutable for replay.
- The **core target (1.5)** is the binding constraint that shapes geometry; the **gate floor (1.0)** is a loose safety net for edge cases. They are intentionally different — the gate must not duplicate the core's job (a 1.5 gate would be a kill-switch, see Section 9).
- `min_rr = 1.5` ships as a **provisional** starting default. **It is not validated within M47.** Pre-M47 closed positions had inverted geometry, so their backfilled MFE/MAE (Task 5b) describes badly-shaped trades, not the correctly-shaped ones M47 produces — 5b therefore only establishes a baseline and proves the excursion pipeline works. True validation requires post-deploy trades opened under the new coupling, which is a **follow-up post-deploy review**. If that review shows a different optimum, `min_rr` is re-tuned via a **targeted JSON-merge param-row UPDATE on the new version rows** (NOT a seeder re-run — the seeder full-blob overwrite is forbidden post-M47, BLOCKER 3) + engine restart (no code deploy — see Section 9 fast-revert). The provisional-vs-confirmed status is recorded in ADR 0003/0004 and the milestone log.

---

## 9 — Risk and mitigations

- **Over-tightening / kill-switch risk.** A *hard gate* at `min_rr = 1.5` would reject **92% of historical signals** — that is a kill-switch, not a filter, and it would starve the bot of trades (and of the labeled-outcome data the soak needs). **Mitigation:** the gate floor is loose (1.0); the cores *shape* geometry at signal time (widen TP / tighten SL) rather than *reject*. Trade frequency is preserved; the geometry is corrected in-place.
- **Fill-probability cost of wider TPs (momentum).** Widening the momentum TP to satisfy `rrFloor` makes the target harder to reach, so more trades will exit on the time-stop rather than the TP. **Mitigation:** this is an accepted trade-off — a time-stop on a correctly-shaped trade has neutral-to-mildly-negative EV, vs the *guaranteed* loss of an inverted-geometry trade. The success-metric exit-reason mix monitors for runaway time-stops (a re-tune trigger).
- **Time-stop frequency may rise short-term.** Directly follows from wider TPs. Monitored (Section 7); a moderate rise is expected, a runaway rise (→100%) triggers a `min_rr` re-tune.
- **Momentum rebase eliminated (Option B mandatory).** Option A (rebase both legs) is dropped — it would put a pre-fill gate check (Task 4) at odds with post-fill geometry, and re-open the "SL as level vs distance" question ADR 0003 settled. Option B freezes both legs at signal time; the M38 fill-acceptance guard (ADR 0045 §D2) bounds fill drift. No semantic change to the VWAP stop.
- **Mean-reversion stop tightened into noise.** Capping `sl_dist ≤ tp_dist / min_rr` could put the stop close enough to entry that normal noise stops the trade out. **Mitigation:** the existing structural-stop hard cap remains the outer *upper* bound, and Task 3 adds a *lower* ATR-relative `slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry)` (HIGH 1) — when `tp_dist / min_rr` would fall below `slFloor` the trade is **skipped as degenerate** rather than shipped with a hair-trigger stop. The ATR-relative form adapts the floor to current volatility; the %-of-entry form bounds the zero-ATR edge case. Monitored via the stop_loss exit-reason share.
- **`min_rr` starting value not yet empirically grounded.** The coupling eliminates inverted geometry at *any* reasonable `min_rr`, so 1.5 is a safe starting default — the exact value is not a correctness blocker for the geometry fix. M47 ships it **provisional**; 5a (seed-race fix) makes forward excursion data trustworthy and 5b establishes a baseline, but the value is confirmed or re-tuned in a **post-deploy review** using trades opened under the new geometry (Section 8). Re-tune is a param-row update + restart (fast-revert path below).
- **Backfill coverage may be partial (Task 5b).** Exchange OHLCV may be missing/coarse for some symbols, so the historical baseline runs on whatever set is recoverable. **Mitigation:** with the seed-timing race fixed (5a), forward excursion data is complete and self-sustaining going forward, so even a sparse backfill becomes a complete dataset as new trades close — the post-deploy review strengthens over time without further milestone work.
- **M47 does not make the bot profitable.** Explicitly reasserted: at 29.8% win rate every bucket loses. M47 stops the inverted-geometry bleed and lays the signal-quality data foundation (Task 5c); profitability needs the separate M48 signal-quality *fixes* (Section 3). Framing this honestly in the milestone log prevents a false "we fixed it" read post-deploy.
- **Fast revert path (no code deploy).** If post-deploy time-stop frequency exceeds [X]% of exits (wider TPs pushed targets past reachability), **lower `min_rr` to 1.0 via a targeted JSON-merge param-row UPDATE on the new version rows + engine restart** (NOT a seeder re-run, which would clobber the whole params blob — BLOCKER 3) — `min_rr` is a version param, so no code deploy is needed. **Asymmetry to document:** the gate floor `MIN_RR_GATE_FLOOR` is an engine const, so lowering *it* requires a code deploy. The tunable target is hot-adjustable; the safety-net floor is not. This is by design (the floor should be hard to weaken).

---

## 10 — Out of scope

- **Win-rate / signal-quality *fixes*** (entry confirmation, regime filtering, signal scoring) — the separate M48 milestone that actually targets profitability. M47 is geometry + data-foundation only. **The data infrastructure (Task 5c `position_segment_stats`) enables M48's signal-quality work without needing another data-plumbing milestone first** — only the *fixes* are out of scope, not the data plumbing.
- **Trailing stops / dynamic exits / partial take-profit** — exit-policy changes beyond static SL/TP coupling. Not pulled in.
- **Time-stop duration recalibration** — `time_stop_minutes` tuning to offset the wider-TP fill-probability cost is a *separate* tuning question; M47 leaves it untouched and only monitors the exit-reason mix.
- **New strategy cores / slot-C correlated strategy** (tech-debt M23) — the gate backstop will bind them when they ship, but M47 builds no new core.
