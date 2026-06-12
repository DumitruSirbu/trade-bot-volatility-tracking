# M29 — Paper funnel diagnosis + first-fill enablement (idiosyncratic edge prerequisite)

> **Sequencing note:** M29 sits at the hinge of the paper-soak arc. M24–M28 made paper fills
> *mechanically possible* (M24 open-fill wiring, M25 strategy activation + stress relaxation, M26
> shadow counterfactual, M27 decision schema, M28 same-bar recalibration). The WIP
> `docs/wip/slot-model-and-correlated-leg-gaps.md` asks whether to build the **correlated slot-C
> strategy leg** next. **The DB answer is an unambiguous no — not yet.** The WIP's own stated
> prerequisite ("Is the idiosyncratic leg producing edge? Zero trades have closed… this is the
> prerequisite") is still 100% unmet: across the full 11-day soak the gate has approved **zero**
> opens, opened **zero** positions, and recorded **zero** transactions. M29 does not build the
> correlated leg. M29 makes the **first idiosyncratic paper fill possible** by diagnosing and
> unblocking the gate funnel, and instruments the funnel so we can finally answer the edge question.
> **Code + config + ADR only — no schema migration, no shared-package change.** An engine restart
> (and a paper-`.env` change) picks it up. CLAUDE.md DB-safety invariants (#8/#9) still apply to the
> pre-restart pg_dump even though there is no migration.

## Goal

Get the bot to open its first idiosyncratic paper position by finding and removing the funnel
choke-point(s) that reject **every** open intent, then instrument the funnel so the idiosyncratic
edge (the WIP's locked prerequisite for any slot-C work) can be measured. M29 is deliberately
**diagnostic-first and minimum-touch**: it changes operator-level config and adds observability; it
introduces no new strategy behaviour and does not relax any safety floor that protects survival.

## Problem

The WIP frames the next step as the correlated slot-C leg. The soak DB says the upstream system
has never produced a single fill, so building slot C now would add a second untested,
unattributable path on top of an idiosyncratic path that has never traded once. Build order is
wrong until the funnel produces fills.

### Code-verified + DB-verified current state (soak window 2026-05-30 → 2026-06-09)

**The funnel terminates at zero.** Queried against the running soak Postgres:

| Metric | Value |
|---|---|
| `positions` rows (any state) | **0** |
| `transactions` rows | **0** |
| `decisions.action='open'` rows | 539 |
| `open` rows with `gate_allowed=true` | **0** (510 NULL pre-M27-stamp, 29 `false`) |
| `open` rows with `position_id` set | **0** |
| `risk_state.open_exposure` max / `trades_count` max | 0 / 0 |

**Every open intent is rejected.** Reject-reason distribution across all 539 `open` decisions:

| Reason | Count | Reachable when not halted? |
|---|---|---|
| `global_halt` | 283 | — (day already halted) |
| `sl_outside_liquidation` | 66 | **yes — #1 reachable blocker** |
| `market_stress` | 48 | yes (per-decision stress leg) |
| `coin_book_too_thin` | 46 | yes (depth floor) |
| `no_eligible_slot` | 38 | yes (idiosyncrasy < min) |
| `exposure_cap_per_coin` | 36 | **yes — fires with ZERO open positions** |
| `btc_correlated_not_best_candidate` | 20 | yes (correlated batch losers) |
| `below_universe_floor` | 2 | yes |

Of 539 open attempts, **283 hit a day that was already globally halted**; the other **256 reached
the per-decision checks and were each rejected** by one of the reasons above. **Not one passed.**
The dominant *reachable* blockers are `sl_outside_liquidation` (66), `coin_book_too_thin` (46),
`no_eligible_slot` (38), and `exposure_cap_per_coin` (36).

### Root cause #1 (highest-value): `exposure_cap_per_coin` is a single-order sizing-vs-cap conflict, not a portfolio cap

`exposure_cap_per_coin` fired **36 times** while `risk_state.open_exposure` was **always 0** and
there were **zero** concurrent same-bar same-symbol duplicates (verified: no `(ts, symbol)` group
has count > 1 among open attempts). With no open positions and no competing reservation, the only
term that can breach the cap is **the intent's own `notional`**. `RiskGateService.checkExposureCaps`
computes `sumNotionalForSymbol(open, active, symbol).plus(intent.sizing.notional)` and rejects when
that exceeds `maxExposurePerCoinUsdt`. With open=∅ and active=∅, the predicate reduces to
`intent.sizing.notional > maxExposurePerCoinUsdt`.

`PositionSizer.size` produces `baseNotional = (allocatedCapital × RISK_PER_TRADE_PCT) / (atr14 ×
atrStopMultiplier) × entryPrice`, clamped only to `allocatedCapital × MAX_LEVERAGE`. With the
current paper `.env` (`ACCOUNT_CAPITAL_USDT=1500`, `RISK_PER_TRADE_PCT=0.01` → $15 risk,
`MAX_LEVERAGE=3` → $4,500 notional ceiling) and `MAX_EXPOSURE_PER_COIN_USDT=500`, **any coin whose
ATR-stop fraction is small enough that $15/stopDistance×price > $500 is rejected outright** — i.e.
the lower the coin's volatility, the larger the risk-targeted notional, the more certain the
per-coin cap rejects it. The sizer's risk target ($15 = 1% of $1,500) and the per-coin notional cap
($500) are in direct tension: the cap is binding *before a position exists*, so the bot can never
open. This is a **risk-config calibration conflict**, not a bug in either component — both behave
exactly as specified in ADR 0004 §8.

### Root cause #2: `sl_outside_liquidation` is the #1 reachable rejection (66)

**Corrected mechanism (per all three independent reviews — verified at `RiskGateService.ts`
1056–1100).** The gate does **not** reject for "stop too far." `clampStopInsideLiquidation`:

- computes `safeDistance = entryPrice × (1/leverage − maintenanceMarginRate) ×
  LIQUIDATION_SAFETY_BUFFER_FACTOR (0.8)`;
- if the (correct-side) stop distance exceeds `safeDistance`, it **tightens the stop to
  `safeDistance` and approves** (`tightenStop`) — a wide-but-correct-side VWAP stop is silently
  pulled in, not rejected;
- it returns `null` → `SL_OUTSIDE_LIQUIDATION` reject **only** when: leverage ≤ 0 or > `MAX_LEVERAGE`,
  the liquidation fraction `(1/leverage − maintenanceMarginRate)` ≤ 0 (over-levered vs maintenance
  margin), `safeDistance` ≤ 0, or the stop is on the **wrong side** of entry (`isWrongSideStop`: a
  LONG stop ≥ entry, or a SHORT stop ≤ entry).

The active strategy is now v2 momentum (`ACTIVE_STRATEGY_VERSION_ID=3`), whose stop is **structural —
placed at the session VWAP** (`momentumCore.buildMomentumExit` → `stopLossPrice = event.vwapSession`,
`StopTypeEnum.STRUCTURAL`). A momentum *follow* entry is, by construction, a move *away from* VWAP, so
the VWAP stop normally sits on the protective (correct) side and a wide one is **tightened-and-
approved** — it would not appear in the 66 rejects. The plausible cause of the 66 is therefore
**wrong-side VWAP geometry** (e.g. a LONG reconstructed with `vwapSession ≥ entryPrice` because of an
inconsistent deviation sign or event geometry) or **over-leverage** relative to maintenance margin —
**not** narrative stop distance. This is the #1 reachable funnel loss after D2. M29 **diagnoses and
quantifies** it via decision forensics (entry vs stop vs side on the rejected rows); it does **not**
redesign the stop (a strategy/quant decision, out of scope — see D5). The exact split (wrong-side vs
over-levered vs already-tightened-and-approved) is an open question recorded below, to be resolved
from soak `decisions` rows before any "change the VWAP stop" milestone is opened.

### Root cause #3: the correlated slot-C path is *plumbed* but its strategy is undifferentiated

The WIP says "nothing emits `correlation_mode = correlated`." Code-verified, this is **half true and
the nuance matters for the build-order call:**

- `marketSnapshotMapper.resolveCorrelationMode` **does** emit `CORRELATED` when
  `abs(btc_5m_move_pct) >= params.btc_correlated_move_threshold_pct` (=1.5%). The DB shows the
  `correlation_mode` *snapshot* field empty on open decisions because the persisted
  `market_snapshot` predates the field being stamped, **but the live mapper sets it**.
- `StrategyService` **does** buffer correlated-mode opens per bar and select a single best candidate
  (the 20 `btc_correlated_not_best_candidate` rejects on Jun 7 22:15 — 20 coins including BTC at one
  timestamp — are exactly this batching firing).
- `SlotManager.assignCorrelated` **does** assign slot C and enforce `BTC_CORRELATED_SLOT_TAKEN`.

What is genuinely **missing** is a *differentiated correlated strategy*: the buffered correlated
winner is evaluated by the **same** `momentumCore`/reversion logic as an idiosyncratic trade —
there is no trend-following entry/exit, no regime classifier, no correlated-specific sizing. So the
WIP's "build slot C" is really "design a new strategy," and that is unbuildable-with-confidence
until the idiosyncratic path produces attributable fills. **M29 confirms this state with a test and
defers the correlated strategy in full.**

### Why this blocks the WIP entirely

All three of the WIP's open questions resolve to "we have no data":

1. *Is the idiosyncratic leg producing edge?* — **Cannot be answered: zero fills.** This is the
   gate M29 exists to open.
2. *What is the regime classifier?* — Premature: defining "BTC is trending" before the idiosyncratic
   path trades risks designing against noise.
3. *Does the $cap + position limit need relaxing first?* — **Yes, and M29 proves it with the
   `exposure_cap_per_coin` root-cause above** — but the fix is to reconcile the sizer-vs-cap tension
   conservatively, not to blanket-raise caps.

## Independent Review Synthesis

Three independent LLM reviews (Cursor, GBT, Gemini) read this plan against the codebase on
2026-06-10, and a quant review subsequently audited the milestone (1 HIGH + 3 MEDIUM, all
incorporated below: stale `riskPerTradeUsdt` denominator → `effectiveRiskUsdt`,
`sl_outside_liquidation` sub-cause split, slot-C minimum closed-trade floor, same-config-source
parity assertion). All three LLM reviews reach the same verdict: **approve with plan amendments
before dispatch.** The
findings below are reconciled against the actual code (`StrategyService.ts:216`,
`BacktestOrchestrator.ts:205`, `RiskGateService.clampStopInsideLiquidation` at 1056–1100,
ADR 0042 §4 line 200) — each consensus item was verified, not taken on the reviewer's word.

### (a) Consensus findings (all three reviewers)

1. **Sequencing (D1), root cause #1 (D2 math), and the clamp direction are correct.** Unanimous.
   D2 (clamp to the per-coin cap, never raise it) is graded the highest-value, lowest-risk change.
   The empty-book reduction `intent.sizing.notional > maxExposurePerCoinUsdt` is code-accurate.
2. **Implementation step 2 names the wrong call site (BLOCKER).** `RiskGateService` **never** calls
   `PositionSizer.size`. Sizing happens in `StrategyService.buildOrderIntent`
   (`StrategyService.ts:216`) and `BacktestOrchestrator` (`BacktestOrchestrator.ts:205`). The cap
   must be threaded into **both** sizing call sites for live/backtest determinism parity; failing to
   update the backtest path silently diverges replay from live. `RiskGateService.checkExposureCaps`
   stays unchanged (final authority / defence in depth) — verified.
3. **Root cause #2 mischaracterizes `sl_outside_liquidation` (correction).** The gate does **not**
   reject for "stop too far." `clampStopInsideLiquidation` **tightens** a correct-side stop that
   exceeds `safeDistance` and **approves** it; it returns `null` → reject only on a **wrong-side
   stop** (`isWrongSideStop`), invalid/over-max leverage, or non-positive liquidation fraction
   (verified at lines 1056–1086). So the 66 rejects are most plausibly **wrong-side VWAP** geometry
   or over-leverage, not narrative distance. A wide-but-correct-side VWAP stop is silently
   tightened-and-approved and never appears in the 66.
4. **ADR 0042 §4 must be amended explicitly (BLOCKER).** Line 200 locks "No `PositionSizer` code
   change. P3b is config-only." D2 reverses this. Amending only ADR 0004 §8 leaves an undocumented
   ADR reversal that logic/clean-code reviewers will flag. Both ADRs must be amended.
5. **First fill is not guaranteed by D2 alone (expectation-setting).** D2 clears at most the ~36
   empty-book `exposure_cap_per_coin` rejects; ~220 reachable rejects remain
   (`sl_outside_liquidation` 66, `market_stress` 48, `coin_book_too_thin` 46, `no_eligible_slot` 38).
   Code-complete ≠ deploy-acceptance. The binary signal (`positions` 0 → ≥1) is correct but may need
   multiple sessions + a stale-halt clear.
6. **Funnel rollup must split `gate_allowed` three ways (D3 nuance).** `true` / `false` / `NULL`
   (510 pre-M27 rows are "unknown / pre-stamp", **not** rejected). Use `reason = 'global_halt'` on
   `action='open'` for the halted-vs-reachable split (not calendar-day `is_halted`), and
   `LIKE 'market_stress%'` for suffixed legs. Implement as a query function in `packages/analysis`;
   any future endpoint delegates to it.
7. **D4 should extend existing specs, not greenfield (process).** Partial coverage already exists
   (`StrategyService.spec.ts` correlated buffer, `BacktestOrchestrator.spec.ts` O7
   `resolveCorrelationMode`). Add the 1.5% mapper boundary + the "same strategy core" gap lock as
   deltas.
8. **D6 covers both `.env` and `.env.example` (verified).** `.env.example` shows
   `MAX_OPEN_POSITIONS=1` at line 218 with a commented paper `=3` block at line 291. Fix both files.

### (b) What was incorporated

- **Step 2 / scope item 2 rewritten** to thread the cap through `StrategyService.buildOrderIntent`
  and `BacktestOrchestrator` (both sizing call sites), with a backtest/live parity test; explicit
  note that `RiskGateService` has no sizing call (consensus #2).
- **Root cause #2 corrected** to the actual tighten-vs-reject mechanism; tech-debt entry (b)
  reworded to "wrong-side / over-levered structural stop forensics," not "stop too far" (consensus
  #3).
- **ADR step expanded** to amend **ADR 0042 §4** alongside ADR 0004 §8 (consensus #4).
- **Success criteria qualified** — code-complete vs deploy-acceptance distinction (consensus #5).
- **D3 rollup spec hardened** — three-way `gate_allowed` bucket, `global_halt`-reason split,
  `packages/analysis` query function (consensus #6).
- **D4 reworded** to "extend existing suites" (consensus #7); D6 explicitly names both files
  (consensus #8). New "Open Questions / Risks" section added.

### (c) What was deliberately NOT incorporated (and why)

- **No change to the VWAP structural stop, depth floor, or idiosyncrasy threshold** — every reviewer
  agreed with D5's refusal to hand-edit these. The corrected root-cause #2 reinforces this: the SL
  fix is forensics + backtest in a future milestone, not an M29 tweak.
- **No same-direction-cap clamp added to scope.** GBT (F) / Gemini (B) suggested a sanity *fixture*
  only; under paper `.env` ($1,500 same-direction vs $500 per-coin) this leg cannot bind on an empty
  book after D2. Added as a QA regression fixture (verify-no-regression), not a behaviour change —
  expanding the clamp to the same-direction leg would be unjustified scope creep.
- **No funnel HTTP endpoint or dashboard widget.** Reviewers preferred the `packages/analysis` query;
  an endpoint/widget remains explicitly deferred (D3 / Out of scope), consistent with minimum-touch.
- **No `market_snapshot->>'correlation_mode'` join into the rollup** (Cursor M5). The historical
  field is a pre-stamp artifact; documenting "correlated-vs-idio split is live-only until backfill"
  is enough — a backfill is out of scope and would touch persisted rows.

## Architectural decisions

### D1 — M29 is diagnosis + first-fill enablement, NOT the correlated leg

The single most important decision: **do not build slot C now.** Build order is funnel → first fill
→ idiosyncratic-edge measurement → (only then) correlated strategy. Shipping a correlated strategy
on top of a never-filled idiosyncratic path would make P&L unattributable and violate the project's
conservative-survival priority (a second untested order path). The WIP's own prerequisite gates
this. M29's deliverable is the **first idiosyncratic paper position opening and closing**, plus the
funnel telemetry to read the result. The correlated leg is explicitly deferred (out of scope) and
re-opened only after M29's soak shows idiosyncratic fills with measurable expectancy.

> **Honest framing.** This reverses the WIP's tentative lean toward extending slot C. The reversal
> is evidence-driven: the WIP was written on 2026-06-05 noting "zero trades closed"; M24–M28 have
> since fixed the *fill mechanics*, yet the DB on 2026-06-09 still shows zero fills — proving the
> blocker is the **gate funnel**, upstream of both the fill path and the slot model.

### D2 — Resolve the sizer-vs-per-coin-cap tension by clamping intent notional to the cap, not by raising the cap

The cleanest conservative fix for root cause #1: **the sizer should not propose a notional that the
per-coin cap will reject.** Add a notional clamp in `PositionSizer` (or a thin post-sizing clamp in
the gate's sizing seam) so the proposed notional is `min(riskTargetedNotional, maxLeverageNotional,
maxExposurePerCoinUsdt)`. The per-coin cap is the **operator's hard exposure ceiling** and must
remain binding; the sizer's 1%-risk target is a *desired* size that may legitimately be shrunk by a
hard limit — exactly as it is already shrunk by `MAX_LEVERAGE` (`clampToMaxLeverage`). Shrinking the
order to fit the cap lets the trade open at the capped size instead of being rejected outright.

**Rationale (why clamp, not raise the cap):** raising `MAX_EXPOSURE_PER_COIN_USDT` to clear the
sizer would *increase* per-coin risk — the opposite of conservative survival. Clamping *reduces*
realized size to the operator ceiling, which is the safe direction. The gate already shrinks size
on funding (`FUNDING_SIZE_CUT_FACTOR`) and leverage; clamping to the per-coin cap is the same
shape. The per-coin cap stays the source of truth for maximum per-coin exposure.

> **Locked seam (must verify in review):** the clamp must live where it keeps the strategy pure and
> the cap authoritative. Preferred: extend `PositionSizer` to accept `maxExposurePerCoinUsdt` as a
> sizing input and fold it into the existing `clampToMaxLeverage` step (rename to a general
> `clampToCeilings`). The gate's `checkExposureCaps` **still runs unchanged** as the final authority
> (defence in depth: if any reservation/open already consumes the coin's budget, the clamp alone
> would not catch it, so the cap check stays). After clamping, re-validate `notional >=
> instrument.minNotional` — a clamp that drops below min-notional must return `below_min_notional`,
> not a sub-minimum order. **Determinism preserved:** the clamp is pure decimal arithmetic on
> passed-in inputs, no clock/RNG.

**Rejected alternative — raise `MAX_EXPOSURE_PER_COIN_USDT`:** increases survival risk; rejected.
**Rejected alternative — lower `RISK_PER_TRADE_PCT`:** would shrink *all* orders globally to dodge
the cap, distorting the risk model for coins where the cap is not binding; the clamp is targeted.
**Rejected alternative — leave it and accept the rejections:** keeps the funnel at zero fills; the
whole point of M29 is to open it.

### D3 — Funnel observability: a per-day reject-reason breakdown surfaced to the dashboard/telemetry

We are flying blind: the only way the zero-fill state was found was ad-hoc SQL. Add a **funnel
summary** the operator can read without hand-written queries — a per-UTC-day rollup of `decisions`
grouped by `action` and `reason`, split into *halted-day* vs *reachable* rejects, with the count of
gate approvals and fills. This is the instrument that finally answers "is the idiosyncratic leg
producing edge" once fills start.

**Scope of the observability (minimum-touch):** prefer a read-only query/endpoint over new persisted
state. Two acceptable forms, in preference order:

1. **Preferred (per all three reviews):** a canonical query function in `packages/analysis` (e.g.
   `getFunnelSummary`, mirroring `getDecisions` / `selectHaltState` / `getPerformance`), exported
   from the package index and unit-tested with the existing Jest pattern. If an HTTP endpoint is
   added later it **delegates to this same function** (one canonical shape).
2. A read-only engine endpoint only if the DI/module cost is truly low; it must return the identical
   rollup shape for a date range.

**Rollup semantics (must be encoded in the query — consensus from all three reviews):**

- **Split `gate_allowed` three ways:** `true` (approvals), `false` (explicit gate rejects), and
  `NULL` (the 510 pre-M27 / pre-stamp rows — "unknown", **must NOT be counted as rejected**).
- **Halted-vs-reachable split** uses `reason = 'global_halt'` on `action='open'` rows — NOT the
  calendar-day `risk_state.is_halted` flag (a day can have both halted and pre-halt reachable rows).
- `LIKE 'market_stress%'` prefix match so the M23/M28 suffixed legs (`market_stress:breadth`,
  `market_stress:btc_5m`, …) are not silently dropped.
- Correlated-vs-idiosyncratic split is **live-only** (the historical `market_snapshot` →
  `correlation_mode` field is a pre-stamp artifact); document this rather than backfilling.
- **R-multiple / expectancy denominator (quant HIGH).** When the rollup computes per-trade
  R-multiples or expectancy on closed positions, the risk denominator **must be `effectiveRiskUsdt`,
  not `riskPerTradeUsdt`.** For a clamped trade the realized dollar risk is below the $15 target, so
  dividing PnL by the stale target overstates/understates R for exactly the clamped low-ATR names
  M29 unblocks. Where `effectiveRiskUsdt` is unavailable (pre-M29 rows), the rollup must mark the
  R-multiple as null/unknown rather than fall back to the target.
- **Split `sl_outside_liquidation` by sub-cause (quant MEDIUM #1).** This is the single largest
  reachable reject (~66) and D3 must break it out so the post-deploy forensics pass is not ad-hoc.
  The three sub-causes are derivable from `RiskGateService.clampStopInsideLiquidation`: **wrong-side
  stop** (`isWrongSideStop`: LONG stop ≥ entry, SHORT stop ≤ entry), **over-levered**
  (`clampToMaxLeverage` reduced qty to zero / leverage outside `(0, MAX_LEVERAGE]`), and
  **non-positive liquidation fraction** (`(1/leverage − maintenanceMarginRate) ≤ 0`). **Derive the
  sub-cause from already-persisted `decisions` columns — no new column, no migration.** The
  `decisions` row already carries `trade_side`, `stop_loss`, `leverage`, and `notional` (M27
  additive fields on `apps/engine/src/strategy/entity/DecisionEntity.ts`), and the entry-equivalent
  price is in `market_snapshot` JSONB; wrong-side vs over-levered is reconstructable from these in
  the rollup query. A `gate_reject_sub_reason` **column is explicitly NOT added** (it would be a
  schema migration, outside M29 scope) — the split is a diagnostic query over existing rows. If a
  future milestone wants the sub-cause stamped at write time, that is a separate additive-column
  migration routed through the engine agent.

**No new table, no schema migration.** The funnel is derived from existing rows. (If a future
milestone wants a materialized funnel, that is a separate schema change routed through the engine
agent with a migration + pg_dump.)

### D4 — Confirm-by-test that the correlated path is plumbed-but-undifferentiated, and log the gap

Rather than change the correlated code, M29 **pins the current state with tests** so the WIP's
ambiguity is resolved in the codebase, not just prose. **Extend the existing suites
(`StrategyService.spec.ts` already covers the correlated buffer + `btc_correlated_not_best_candidate`;
`BacktestOrchestrator.spec.ts` O7 covers `resolveCorrelationMode`) — add deltas, do not greenfield
duplicate** (per all three reviews): a test asserting `resolveCorrelationMode`
returns `CORRELATED` at `abs(btc_5m_move_pct) >= 1.5%`; a test asserting the `StrategyService`
per-bar buffer selects the single highest `signalScore` and rejects the rest
`btc_correlated_not_best_candidate`; and a test asserting that a correlated winner is evaluated by
the **same** strategy core as an idiosyncratic intent (the differentiation gap). A **MEDIUM
tech-debt entry** records the missing differentiated correlated strategy as the WIP's real ask,
gated behind M29's idiosyncratic-fill prerequisite.

### D5 — Do NOT touch the strategy stop logic, the depth floor, or the idiosyncrasy threshold in M29

`sl_outside_liquidation` (#2), `coin_book_too_thin` (M22-calibrated depth floor), and
`no_eligible_slot` (idiosyncrasy `< idiosyncrasy_min_score`) are all **diagnosed and quantified** in
M29 but **not changed**. Each is a deliberate safety/strategy calibration:

- The VWAP structural stop is a *strategy* decision (ADR 0003 / momentumCore) — changing it is a
  quant/strategy milestone, not a risk-config tweak, and must be backtested, not hand-edited.
- The depth floor is M22-calibrated against soak evidence and is on a 14-day slippage-telemetry
  re-calibration track (ADR 0004 §6a) — M29 must not pre-empt it.
- The idiosyncrasy threshold is the load-bearing A/B-slot eligibility gate (ADR 0004 §4).

M29's job is to make these blockers **visible and ranked** (D3) so the next milestone can decide
which one to address with proper backtesting. Changing two-plus safety levers blind, in one
milestone, to "make a trade happen" is exactly the over-fitting M29 must avoid. **Only the
sizer-vs-cap clamp (D2) is a behaviour change**, because it is unambiguously the safe direction
(shrink, never grow) and unambiguously a config conflict (cap binding before any position exists).

### D6 — Clean up the duplicate `MAX_OPEN_POSITIONS` env key

`.env` contains `MAX_OPEN_POSITIONS` **twice** (`=1` then `=3`; last wins → 3). This is a latent
operational hazard: an operator reading the top of the file sees `1` and reasons about a one-slot
bot while the engine runs three. M29 removes the stale duplicate and documents the single
authoritative value. This is a config-hygiene fix, not a behaviour change (the effective value is
already 3). **No code change** — `.env` + `.env.example` only. **Both files must be fixed (verified
by all three reviews):** committed `.env.example` shows `MAX_OPEN_POSITIONS=1` at line 218 with a
commented paper `=3` block at line 291; the operator `.env` carries the live duplicate. Ensure the
M25 paper-exploration comment block does not re-introduce a conflicting second key, and place the
authoritative paper sizing/cap values near the risk-limits section header so "read the top of the
file" matches effective paper behaviour.

## Scope

### What changes

1. `apps/engine/src/risk/service/PositionSizer.ts` — accept the per-coin exposure cap as a sizing
   input and clamp the proposed notional to it (D2); re-validate min-notional after the clamp;
   compute and attach `effectiveRiskUsdt` (post-clamp realized risk) on the sizing result.
   `apps/engine/src/risk/interface/IIntentSizing.ts` — add the `effectiveRiskUsdt: MoneyValue` field
   (engine-internal interface, NOT shared — no shared-package change; quant HIGH).
2. **Thread the cap into the two sizing call sites — NOT `RiskGateService`** (corrected per all
   three reviews; `RiskGateService` never calls `PositionSizer.size`):
   - `apps/engine/src/strategy/service/StrategyService.ts` (`buildOrderIntent`, sizing call at
     `:216`) — pass `new Money(this.config.maxExposurePerCoinUsdt)` into `sizer.size(...)`. The cap
     is already threaded into **gate** limits via `resolveRiskLimits()`; M29 also threads it into
     **sizing**.
   - `apps/engine/src/backtest/service/BacktestOrchestrator.ts` (sizing call at `:205`) — pass the
     same per-coin cap from the backtest context/limits, so replay sizing stays byte-identical to
     live (live/backtest determinism parity, ADR 0015 / ADR 0004 §8). Omitting this silently diverges
     replay from live.
   - `apps/engine/src/risk/service/RiskGateService.ts` — **no sizing call.** `checkExposureCaps`
     stays exactly as the final authority (defence in depth, unchanged logic). Only confirm it is
     untouched.
3. **Funnel observability (D3)** — a read-only funnel-rollup endpoint under the existing
   control/telemetry surface **or** a committed canonical SQL query (engine agent chooses the
   lighter correct form; prefer the query if the endpoint adds DI/module surface disproportionate to
   the value).
4. Tests pinning the correlated plumbing + differentiation gap (D4) and the new clamp behaviour (D2).
5. `.env` / `.env.example` — remove the duplicate `MAX_OPEN_POSITIONS` (D6); document the
   authoritative paper sizing/cap values.
6. ADR 0004 §8 **and** ADR 0042 §4 amended. ADR 0004 §8: the sizer→per-coin-cap clamp (the cap is
   binding pre-position; the sizer shrinks to it, the gate check remains the final authority); the
   new `effectiveRiskUsdt` field and the rule that R-multiple / expectancy uses it (not the stale
   `riskPerTradeUsdt` target) for clamped trades (quant HIGH); a short note that the funnel rollup is
   observability-only and derived (no schema), including the derived `sl_outside_liquidation`
   sub-cause split (quant MEDIUM #1). ADR 0042 §4:
   amend the locked "No `PositionSizer` code change. P3b is config-only" (line 200) — soak evidence
   showed config-only headroom (M25 P3b) was insufficient for low-ATR names where the risk-targeted
   notional exceeds `MAX_EXPOSURE_PER_COIN_USDT` before any position exists, so the sizer must clamp
   to the per-coin ceiling. This is a justified, evidence-driven reversal — record it in place so the
   ADR change is not silent. **ADR-conflict note:** D2 directly contradicts ADR 0042 §4 as written;
   the override is the explicit amendment above, not a silent change.
7. `docs/tech-debt.md` — MEDIUM: differentiated correlated slot-C strategy (the WIP's real ask),
   gated behind idiosyncratic-fill prerequisite; MEDIUM: `sl_outside_liquidation` is the #1 reachable
   funnel loss under the VWAP structural stop — investigate **wrong-side VWAP / over-levered
   structural stops** under momentum follow (the gate tightens-and-approves correct-side wide stops;
   rejects only wrong-side / bad-leverage cases). Needs decision-row forensics (entry vs stop vs
   side) + backtest; explicitly **not** a hand-edit to the liquidation buffer factor.

### What does NOT change

- **No schema migration, no shared-package change, no DB write at rest** beyond what already exists.
- **No strategy code** — `momentumCore`, the VWAP structural stop, `classifyFlowType`,
  `computeIdiosyncrasyScore`, `resolveCorrelationMode` are untouched (D4/D5).
- **The per-coin cap value `MAX_EXPOSURE_PER_COIN_USDT` is unchanged** — D2 clamps *to* it, does not
  raise it.
- `MAX_LEVERAGE`, `RISK_PER_TRADE_PCT`, the depth floor (`COIN_DEPTH_FLOOR_10BPS_USDT`), the
  idiosyncrasy threshold, the liquidation safety buffer — all unchanged (D5).
- The correlated buffer / `SlotManager` / `btc_correlated_not_best_candidate` logic — unchanged
  (D4 pins it with tests but edits no behaviour).
- The M28 stress-halt recalibration and the M23/M28 auto-resume — unchanged.
- `MAX_OPEN_POSITIONS` effective value (already 3) — unchanged; only the duplicate key is removed.

## Implementation steps (ordered, for `bot-engine-nestjs`)

1. **`PositionSizer.ts` — add the per-coin cap to the sizing inputs and clamp (D2).**
   - Add `maxExposurePerCoinUsdt: MoneyValue` to `ISizingInput`.
   - Generalise `clampToMaxLeverage` to `clampToCeilings(notional, allocatedCapital,
     maxExposurePerCoinUsdt)` that returns `min(notional, allocatedCapital × MAX_LEVERAGE,
     maxExposurePerCoinUsdt)` — pure decimal `min`, no float.
   - Apply the clamp **before** the qty step-rounding (so the rounded qty reflects the capped
     notional), then keep the existing `notional < minNotional → below_min_notional` check **after**
     the clamp (a clamp that drops below min-notional must reject, not ship a sub-minimum order).
   - **Record post-clamp effective risk (quant HIGH).** `riskPerTradeUsdt` on `IIntentSizing` is the
     *input* target ($15 = 1% of $1,500): notional is derived as `riskPerTradeUsdt / stopDistance ×
     entryPrice`. When the clamp shrinks notional **downward**, the realized dollar risk falls below
     $15, but `riskPerTradeUsdt` (and `proposedExit.stopLossPrice`) stay at the pre-clamp target —
     leaving the field stale for any clamped trade. Add a distinct field
     `effectiveRiskUsdt: MoneyValue` to `IIntentSizing` (interface lives at
     `apps/engine/src/risk/interface/IIntentSizing.ts` — **engine-internal, NOT in
     `packages/shared/`; no shared-package change**, consistent with M29 scope) and compute it as
     `clampedNotional / entryPrice × stopDistance` in pure decimal. When the clamp does not bind,
     `effectiveRiskUsdt === riskPerTradeUsdt`. Keep `riskPerTradeUsdt` as the recorded target (do not
     overwrite it — the gap between target and effective is itself audit signal). This is the
     denominator any R-multiple / expectancy calc must use (see D3).
   - Doc comment: cite ADR 0004 §8; explain the cap is the operator hard ceiling and the sizer
     shrinks the 1%-risk target to fit it, same shape as the leverage clamp; explain
     `effectiveRiskUsdt` is the realized post-clamp dollar risk and `riskPerTradeUsdt` is the
     pre-clamp target.
2. **Thread the cap into BOTH sizing call sites (NOT `RiskGateService`).** `RiskGateService` never
   calls `PositionSizer.size` — sizing is in `StrategyService` and `BacktestOrchestrator`.
   - `StrategyService.buildOrderIntent` (sizing call at `:216`) — pass
     `new Money(this.config.maxExposurePerCoinUsdt)` into `sizer.size(...)`.
   - `BacktestOrchestrator` (sizing call at `:205`) — pass the same per-coin cap from the backtest
     context/limits (use the `MAX_EXPOSURE_PER_COIN_USDT` already wired into
     `buildGateContext.limits` for consistency). Required for live/backtest determinism parity.
   - **Leave `RiskGateService.checkExposureCaps` exactly as is** — it remains the final authority and
     the defence-in-depth check for the multi-reservation / already-open case the single-order clamp
     does not cover. Confirm no double-count: the clamp shrinks the proposed notional; the cap check
     then sums open + active + the (already-clamped) intent notional.
   - **Both call sites must read the cap from the SAME config source (quant MEDIUM #3).** Equal
     output on one fixture is not enough: if `StrategyService` resolves `MAX_EXPOSURE_PER_COIN_USDT`
     from live `.env`/config while `BacktestOrchestrator` resolves it from a backtest override, the
     two paths can silently diverge under a different value. Thread the cap from the **single
     canonical config constant** into both sites; the parity test (below) asserts both paths receive
     the same value when the config is mocked to a **non-default** value.
3. **Funnel observability (D3) — choose the lighter correct form.**
   - **Preferred:** a canonical query function in `packages/analysis` (e.g.
     `getFunnelSummary`, exported from the package index, unit-tested like `getDecisions`): per-UTC-day
     rollup of `decisions` grouped by `action`, `reason`; split halted (`reason='global_halt'` on
     `action='open'`) vs reachable; **three-way `gate_allowed` bucket (`true` / `false` / `NULL`,
     NULL = unknown, never counted as reject)**; count of `positions` opened/closed; uses
     `LIKE 'market_stress%'` so suffixed legs are not dropped.
   - **Split `sl_outside_liquidation` by sub-cause (quant MEDIUM #1):** within the reachable-reject
     bucket, break the ~66 `sl_outside_liquidation` rows into wrong-side stop / over-levered /
     non-positive liquidation fraction. Derive from existing `decisions` columns (`trade_side`,
     `stop_loss`, `leverage`, `notional`) plus the entry-equivalent in `market_snapshot` —
     **no new `gate_reject_sub_reason` column, no migration** (a write-time sub-reason column is a
     separate additive migration if ever wanted).
   - **R-multiple / expectancy denominator (quant HIGH):** any per-trade R-multiple or expectancy
     the rollup computes on closed positions divides realized PnL by **`effectiveRiskUsdt`**, never
     the stale `riskPerTradeUsdt` target; pre-M29 rows lacking `effectiveRiskUsdt` yield a null
     R-multiple, not a target-based fallback.
   - **If an endpoint is warranted:** add a read-only GET under the existing control/telemetry
     controller that **delegates to the same query function** (one canonical shape). No new persisted
     state, no new table.
   - Either way: read-only, derived from existing rows, determinism-irrelevant (reporting path, not
     the trade loop).
4. **Tests — correlated plumbing + differentiation gap (D4). Extend existing suites
   (`StrategyService.spec.ts`, `marketSnapshotMapper` unit tests, `BacktestOrchestrator.spec.ts` O7)
   — do not duplicate.** Pin: `resolveCorrelationMode`
   `CORRELATED` at the 1.5% boundary; `StrategyService` per-bar buffer selects the single highest
   `signalScore` (tie → symbol ascending) and rejects the rest `btc_correlated_not_best_candidate`;
   the correlated winner is evaluated by the same strategy core as an idiosyncratic intent (asserts
   the *absence* of a differentiated correlated path — locks the gap so a future milestone is forced
   to acknowledge it).
5. **`.env` / `.env.example` — remove duplicate `MAX_OPEN_POSITIONS` (D6).** Delete the stale `=1`
   line; keep the authoritative `=3`. Add a one-line comment documenting the paper sizing/cap
   relationship (`ACCOUNT_CAPITAL_USDT × RISK_PER_TRADE_PCT` risk target, clamped to
   `MAX_EXPOSURE_PER_COIN_USDT`).
6. **ADR 0004 §8 AND ADR 0042 §4 amendments.** ADR 0004 §8: document the sizer→per-coin-cap clamp
   (cap binding pre-position; sizer shrinks to it; gate check remains final authority); note the
   funnel rollup is observability-only, derived, no schema. ADR 0042 §4: amend the locked "No
   `PositionSizer` code change. P3b is config-only" (line 200) — record that config-only headroom
   was insufficient for low-ATR names and the sizer must now clamp to the per-coin ceiling. This is
   an explicit, evidence-driven ADR reversal, written in place (not silent).
7. **`docs/tech-debt.md` — two MEDIUM entries.** (a) Differentiated correlated slot-C strategy (the
   WIP's real ask: regime classifier, trend-following entry/exit, correlated sizing, independent
   backtest), gated behind the idiosyncratic-fill prerequisite. (b) `sl_outside_liquidation` is the
   #1 reachable funnel loss under the VWAP structural stop — investigate **wrong-side / over-levered
   structural stops** (the gate tightens-and-approves correct-side wide stops; rejects only
   wrong-side / bad-leverage). Needs decision-row forensics + backtest; explicitly not a hand-edit
   to the liquidation buffer factor.

## Config changes

- **No new env var, no new strategy param, no schema migration.**
- **`.env` / `.env.example`:** remove the duplicate `MAX_OPEN_POSITIONS` key (D6); document the
  sizing/cap relationship. Effective values unchanged (`MAX_OPEN_POSITIONS=3`,
  `MAX_EXPOSURE_PER_COIN_USDT=500`, `ACCOUNT_CAPITAL_USDT=1500`, `RISK_PER_TRADE_PCT=0.01`,
  `ACTIVE_STRATEGY_VERSION_ID=3`, `EXCHANGE_ENV=paper`).
- The per-coin cap stays `500` — D2 clamps to it, does not change it. `MAX_LEVERAGE`,
  `RISK_PER_TRADE_PCT`, depth floors, idiosyncrasy threshold, liquidation buffer — all unchanged.

## Tests required (for `bot-qa-engineer`)

**Unit — `PositionSizer` (D2 clamp):**
- A risk-targeted notional that exceeds `maxExposurePerCoinUsdt` is clamped **to** the cap (boundary:
  notional just over the cap → returns exactly the cap notional; just under → unchanged).
- The clamp composes with the leverage clamp: result is `min(riskTargeted, capLeverage×capital,
  perCoinCap)` — test each ceiling binding in isolation and the most-restrictive-wins case.
- A clamp that drops the notional below `instrument.minNotional` returns `below_min_notional` (does
  NOT ship a sub-minimum order).
- The clamped path is pure decimal (no float) and deterministic: same inputs → same sizing.
- **`effectiveRiskUsdt` reflects post-clamp risk (quant HIGH):** when the cap clamps notional down,
  `effectiveRiskUsdt` (= `clampedNotional / entryPrice × stopDistance`) is **below**
  `riskPerTradeUsdt` ($15); when no ceiling binds, `effectiveRiskUsdt === riskPerTradeUsdt`;
  `riskPerTradeUsdt` is never overwritten by the clamp.
- Regression: a coin whose risk-targeted notional is already **below** the cap is sized **unchanged**
  (the clamp is a ceiling, never a floor — it must not inflate small orders).
- Funding cut still applies before the cap clamp (a funding-halved notional that is now under the
  cap is not re-inflated).

**Integration — sizing threading + gate (D2 threading + defence in depth):**
- A previously `exposure_cap_per_coin`-rejected single-coin open (open=∅, active=∅) now **approves**
  at the clamped (capped) notional — the core M29 funnel-unblock behaviour. **Drive it end-to-end
  through `StrategyService` → gate (real gate, not a mocked sizer)** so the threading is exercised.
- **Live/backtest sizing parity (consensus high-priority):** the same inputs through
  `StrategyService` sizing and `BacktestOrchestrator` sizing produce the **identical** clamped
  notional when the risk-target exceeds the per-coin cap — proves determinism parity after threading
  both call sites.
- **Same-config-source parity (quant MEDIUM #3):** mock the config with a **non-default**
  `MAX_EXPOSURE_PER_COIN_USDT` and assert **both** call sites receive that same mocked value (not
  just produce equal output on a single fixture). This catches the silent-divergence case where the
  two sites resolve the cap from different config sources (live `.env` vs a backtest override).
- `checkExposureCaps` still rejects `exposure_cap_per_coin` when an **existing** open/reservation
  plus the clamped intent exceeds the cap (defence in depth preserved — the clamp does not remove
  the gate check).
- **`sl_outside_liquidation` tighten-path regression (consensus):** a wide **correct-side** stop
  still **approves with a tightened stop** after D2 (the gate tightens, does not reject) — confirms
  D2's lower post-clamp leverage does not break the tighten path, and locks the corrected mechanism.
- **`same_direction_exposure_cap` sanity fixture:** with open=∅, this leg binds only if a single
  intent exceeds `MAX_SAME_DIRECTION_EXPOSURE_USDT` ($1,500 paper vs $500 per-coin) — confirm M29
  does not mask a parallel sizing-vs-cap conflict on this leg. Behaviour unchanged; verify-only.

**Unit — correlated plumbing pins (D4):**
- `resolveCorrelationMode`: `CORRELATED` at `abs(btc_5m_move_pct)=1.5%` (boundary), `IDIOSYNCRATIC`
  at `1.49%`.
- `StrategyService` correlated buffer: highest `signalScore` is submitted to the gate; ties broken
  by `symbol` ascending; all other buffered correlated candidates persisted
  `btc_correlated_not_best_candidate`.
- The correlated winner is routed through the same strategy core as an idiosyncratic intent
  (asserts no differentiated correlated entry/exit exists — pins the gap).

**Funnel observability (D3):**
- The rollup (query function, optional delegating endpoint) groups `decisions` by `action`+`reason`,
  separates `global_halt` from reachable rejects (by `reason`, not calendar-day `is_halted`), and
  **buckets `gate_allowed` three ways: `true`, `false`, `NULL`** — a fixture must prove NULL rows
  (pre-M27) are counted as "unknown", NOT as rejects.
- A `market_stress%` prefix-match fixture proves suffixed legs (`market_stress:breadth`,
  `market_stress:btc_5m`) are matched, not dropped.
- **`sl_outside_liquidation` sub-cause split (quant MEDIUM #1):** fixtures with persisted
  `trade_side` / `stop_loss` / `leverage` / `notional` (+ `market_snapshot` entry) prove the rollup
  classifies wrong-side stop vs over-levered vs non-positive liquidation fraction from existing
  columns — no new `gate_reject_sub_reason` column.
- **R-multiple uses `effectiveRiskUsdt` (quant HIGH):** a closed-trade fixture with a clamped
  notional yields an R-multiple computed on `effectiveRiskUsdt`; a fixture lacking the field
  (pre-M29 row) yields a null R-multiple, never a `riskPerTradeUsdt`-based fallback.
- Counts `positions` opened/closed. If an endpoint: read-only, delegates to the query function,
  returns the same shape for a date range; no write path.

**Regression locks:**
- No strategy code changed: `momentumCore`, VWAP stop, `classifyFlowType`,
  `computeIdiosyncrasyScore` behaviour byte-identical (existing specs green).
- `MAX_EXPOSURE_PER_COIN_USDT`, depth floor, idiosyncrasy threshold, liquidation buffer unchanged.
- M28 stress-halt + auto-resume behaviour unchanged (full suite green).

## Post-deploy checklist

1. **pg_dump before restart** (CLAUDE.md #9): `docker compose exec postgres pg_dump -U trade_bot
   trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`, then prune to the 2 most recent
   (`ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`). **No migration** — restart only,
   plus the `.env` duplicate-key cleanup.
2. **Stale-halt inspection.** Before reading the funnel, confirm the current UTC day is not sitting
   on a stale halt that would mask the unblock: query `risk_state WHERE is_halted=true` for today; if
   halted on a now-stale resume-eligible leg (per M23/M28 rules) and the tape is calm, clear it via
   the evidence-gated `clearHaltForDate` so the clamp fix actually gets exercised. Do **not** clear a
   loss/multi/invalid lock.
3. **10-min live smoke.** Engine boots clean (no module cycle from any new endpoint DI), zero
   errors/warnings, gate evaluates triggers. Confirm `EXCHANGE_ENV=paper`, `ACTIVE_STRATEGY_VERSION_ID=3`
   (v2 momentum) resolved, single authoritative `MAX_OPEN_POSITIONS=3`.
4. **First-fill watch (the M29 acceptance signal).** Within the first session that produces a
   non-halted open intent on a coin previously rejected `exposure_cap_per_coin`, confirm: the open is
   **approved** at the clamped notional (≤ `MAX_EXPOSURE_PER_COIN_USDT`), a `positions` row is
   created, and a `transactions` row follows (the first paper fill). This is the binary success
   signal — positions table flips from 0 to ≥1.
5. **24–48h funnel monitoring (via the D3 rollup):**
   - `exposure_cap_per_coin` rejections on single-coin opens (open=∅) drop toward **zero** (they
     should now clamp-and-open instead).
   - Track the new top reachable blocker — expect `sl_outside_liquidation` to dominate (root cause
     #2). If `gate_allowed=true` stays zero on non-halted days and **all** reachable rejects are
     `sl_outside_liquidation`, run the **decision forensics** (entry vs stop vs side: wrong-side vs
     over-levered vs already-tightened-and-approved) **before** opening a "change the VWAP stop"
     milestone — the fix may be geometry/leverage, not stop distance. Feeds tech-debt entry (b).
   - Watch for opens **approving with a tightened stop** (the gate pulls a wide correct-side VWAP
     stop to `safeDistance`) — these never appear in the SL reject count and confirm the corrected
     mechanism.
   - Confirm `gate_allowed=true` count goes **positive** for the first time and `positions` /
     `transactions` accumulate.
   - Watch realized notional per position is **≤ `MAX_EXPOSURE_PER_COIN_USDT`** on every fill (the
     clamp holds the operator ceiling).
6. **14-day paper soak — the idiosyncratic-edge measurement (the WIP prerequisite).** Once fills
   accumulate, read the funnel rollup for closed-position win/loss/expectancy (R-multiples computed
   on `effectiveRiskUsdt` per D3). **This is the data that gates any future correlated slot-C work.**
   Do not open the correlated-strategy milestone until this soak shows idiosyncratic fills with a
   measurable (even if negative) expectancy — a measured negative edge is itself a valid, actionable
   result; zero fills is not.
   - **Minimum closed-trade-count floor (quant MEDIUM #2).** With ~220 reachable rejects cleared, a
     14-day soak could yield only n=3–5 fills, and "expectancy" on that sample is noise.
     **Do not declare an idiosyncratic-edge verdict (positive or negative) until at least 20 closed
     trades have accumulated across at least 3 distinct trading days.** (Conservative floor — refine
     once an empirical fills/day rate is observed; if the rate is lower than expected, extend the
     soak window rather than lowering the floor.) The expectancy conclusion also requires a
     **sub-period / regime-robustness check** — split the closed trades into sub-windows (or by BTC
     regime) and confirm the sign/magnitude is not driven by a single session; aggregate expectancy
     alone is insufficient to open slot-C work.

## Success criteria — "M29 done"

> **Code-complete vs deploy-acceptance (per all three reviews).** Code-complete M29 is the clamp +
> observability + tests + ADR/tech-debt docs. It removes the **empty-book `exposure_cap_per_coin`
> choke for single-intent opens** — at most ~36 of the 256 reachable rejects. A first paper fill
> still requires a non-halted session, SL-inside-liquidation clearance, depth/idiosyncrasy passes,
> gate approval, and M24 fill execution; ~220 reachable rejects remain (`sl_outside_liquidation` 66,
> `market_stress` 48, `coin_book_too_thin` 46, `no_eligible_slot` 38). Deploy-acceptance is
> post-deploy checklist items 4–5 (`positions` 0 → ≥1) and may take multiple sessions plus a
> stale-halt clear. M29 is **not** "failed" if the next session's reachable blocker is entirely
> `sl_outside_liquidation` — that outcome validates D5 and prioritizes the next milestone.

- A single-coin open intent that previously rejected `exposure_cap_per_coin` (open=∅, active=∅) now
  **approves at the clamped notional ≤ `MAX_EXPOSURE_PER_COIN_USDT`** — the funnel choke-point for
  the dominant reachable cap rejection is removed.
- `PositionSizer` clamps the proposed notional to `min(risk-target, leverage-ceiling, per-coin cap)`
  in pure decimal; a clamp below min-notional rejects `below_min_notional`; small orders are never
  inflated.
- `checkExposureCaps` remains the final authority (defence in depth): an over-cap multi-reservation
  case still rejects `exposure_cap_per_coin`.
- `PositionSizer` attaches `effectiveRiskUsdt` (post-clamp realized risk) alongside the unchanged
  `riskPerTradeUsdt` target; the field is the R-multiple denominator for clamped trades (quant HIGH).
- The funnel rollup (D3) is available (endpoint or committed canonical query), splits halted vs
  reachable rejects, counts approvals + fills, uses a `market_stress%` prefix match, splits
  `sl_outside_liquidation` by sub-cause from existing columns (quant MEDIUM #1), and computes
  R-multiples on `effectiveRiskUsdt` (quant HIGH).
- Tests pin the correlated plumbing (`resolveCorrelationMode` boundary, buffer best-candidate
  selection) **and** the differentiation gap (correlated winner uses the same strategy core).
- `MAX_OPEN_POSITIONS` appears **once** in `.env`; the authoritative paper sizing/cap relationship is
  documented.
- **No strategy code changed; no safety floor lowered; no schema migration; no shared-package
  change.** Only the sizer clamp is a behaviour change, and it shrinks-never-grows.
- ADR 0004 §8 **and** ADR 0042 §4 amended (sizer→cap clamp, funnel observability-only; ADR 0042's
  "no PositionSizer change" reversed in place with soak rationale); two MEDIUM tech-debt entries
  logged (differentiated correlated strategy gated behind the idiosyncratic-fill prerequisite;
  `sl_outside_liquidation` #1 reachable loss — wrong-side / over-levered forensics, not "stop too
  far").
- All new unit + integration tests green; full suite green; review closes with zero blockers, zero
  highs, majority of mediums resolved.
- 10-min live smoke clean; first-fill watch + 24–48h funnel monitoring + 14-day soak criteria in
  place. **The binary acceptance signal: `positions` table flips from 0 to ≥1 in paper.**

## Open Questions / Risks

Surfaced or sharpened by the three independent reviews; tracked so the next milestone is not built on
an assumption.

1. **What actually causes the 66 `sl_outside_liquidation` rejects?** The gate tightens-and-approves
   correct-side wide stops; it rejects only on wrong-side stop / invalid-or-over leverage /
   non-positive liquidation fraction. The 66 are therefore most likely **wrong-side VWAP geometry**
   or **over-leverage**, not "stop too far." **Resolution:** post-deploy decision-row forensics
   (entry vs stop vs side on rejected rows) **before** any milestone touches the VWAP stop. Logged as
   tech-debt (b). Risk if ignored: a future milestone "fixes" stop distance and the rejects persist.
2. **D2 will not, by itself, produce a fill.** ~220 reachable rejects remain after the clamp. The
   first fill may need several sessions and a stale-halt clear. Mitigated by the code-complete vs
   deploy-acceptance framing in Success criteria and by checklist step 2 (stale-halt clear is
   **blocking**, not optional, given 283/539 `global_halt`).
3. **Secondary effect of the clamp on the SL gate (note, not a design goal).** Clamping notional
   reduces computed leverage for low-ATR names, which **widens `safeDistance`** and may let some
   near-cap intents pass the SL gate that previously rejected — a benign side effect to watch in
   monitoring, not relied upon.
4. **`riskPerTradeUsdt` is stale for clamped trades — RESOLVED in-plan (was placeholder; now quant
   HIGH).** `IIntentSizing.riskPerTradeUsdt` reflects the 1%-risk **target** ($15), not the
   post-clamp **effective** risk; on a clamped low-ATR name the realized dollar risk is below $15.
   Any R-multiple / expectancy calc that divides PnL by `riskPerTradeUsdt` would use a wrong
   denominator — exactly the edge measurement M29 exists to enable. **The plan now resolves this**
   by adding a distinct `effectiveRiskUsdt = clampedNotional / entryPrice × stopDistance` field to
   `IIntentSizing` (D2 step 1) and requiring the D3 rollup to use it as the R-multiple denominator.
   `riskPerTradeUsdt` is left intact as the recorded target (the target-vs-effective gap is audit
   signal). ADR 0004 §8 must document both fields and their meaning so funnel / PnL readers do not
   assume the full risk budget was deployed on a capped notional. **No longer an open question — a
   committed scope item.**
5. **Backtest/live divergence if the cap is threaded into only one sizing site.** The single highest
   regression risk of M29. Mitigated by the explicit dual call-site requirement (step 2) and the
   live/backtest sizing-parity test.
6. **`global_halt` masking persists.** D2 does nothing for the 283 halted-day rejects; the funnel can
   only be read on non-halted days. Mitigated by checklist step 2 + the `reason='global_halt'` split
   in the D3 rollup.
7. **ADR 0042 §4 reversal.** D2 contradicts the locked "no `PositionSizer` change." Resolved by the
   explicit in-place amendment (ADR step) — flagged here so reviewers treat it as a documented
   decision, not a silent override. **This is the one place M29 overrides a locked ADR; it does so
   openly, with soak evidence, per the architect's surfacing duty.**

## Out of scope (deferred)

- **The differentiated correlated slot-C strategy** — the WIP's real ask (BTC regime classifier;
  market-wide directional flow types; trend-following entry/exit for slot C; correlated-specific
  sizing; independent backtest framework). Explicitly deferred behind M29's idiosyncratic-fill
  prerequisite (D1). Re-opened only after the 14-day soak shows idiosyncratic fills with measurable
  expectancy **across ≥20 closed trades on ≥3 trading days, with a passing sub-period /
  regime-robustness check** (quant MEDIUM #2 — n=3–5 is noise, not edge). Logged as MEDIUM tech-debt.
- **Changing the VWAP structural stop / `sl_outside_liquidation` rejection logic.** Diagnosed and
  ranked as the #1 reachable funnel loss, but a strategy/quant decision requiring a backtest — a
  future milestone, not a hand-edit (D5). Logged as MEDIUM tech-debt.
- **Re-calibrating `COIN_DEPTH_FLOOR_10BPS_USDT`.** On the M22 14-day slippage-telemetry track
  (ADR 0004 §6a); M29 does not pre-empt it.
- **Lowering the idiosyncrasy threshold or `RISK_PER_TRADE_PCT`, or raising
  `MAX_EXPOSURE_PER_COIN_USDT`/`MAX_LEVERAGE`.** All rejected in D2/D5 — the safe fix is the clamp,
  not loosening a survival lever.
- **A persisted/materialized funnel table or dashboard widget.** M29's funnel is derived/read-only
  (D3); a materialized funnel is a separate schema-change milestone (migration + pg_dump) if the
  read-only form proves insufficient.
- **The separate BTC-only bot** the WIP raised as an alternative — same gate as the correlated leg:
  premature until the idiosyncratic edge is measured; arguably never (a 5m strategy on BTC fights
  maximum liquidity, per the WIP's own cons).
- **Relaxing `MAX_OPEN_POSITIONS` beyond 3** (the true 5-slot expansion deferred in M25/ADR 0042) —
  unchanged; M29 only removes the duplicate key.
