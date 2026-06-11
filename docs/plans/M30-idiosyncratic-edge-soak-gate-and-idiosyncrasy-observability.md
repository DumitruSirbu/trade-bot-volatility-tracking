# M30 — Idiosyncratic-edge soak gate + idiosyncrasy observability (the slot-C go/no-go instrument)

> **Sequencing note.** M29 shipped **today (2026-06-11)** — the same day this plan is written.
> M29's deliverable was *making the first idiosyncratic paper fill possible* (the `PositionSizer`
> per-coin-cap clamp + `effectiveRiskUsdt` + the `getFunnelSummary` funnel rollup) and *instrumenting
> the funnel so the idiosyncratic edge can finally be measured*. M29 did **not** build the correlated
> slot-C leg, and it explicitly **gated** that work behind a 14-day soak showing **≥20 closed
> idiosyncratic trades across ≥3 trading days** with a BTC-regime sub-split reported alongside for
> operator review (ADR 0004 §8a context; `docs/tech-debt.md` MEDIUM "Differentiated correlated
> slot-C strategy").
>
> The WIP `docs/wip/slot-model-and-correlated-leg-gaps.md` asks whether to build slot C next. **The
> answer is still no — and now for a sharper, code-verified reason than M29's.** As of this plan the
> post-M29 soak has accumulated **essentially zero hours**: the clamp + funnel instrument are
> deployed but **the soak that they exist to enable has not yet run**. The slot-C prerequisite
> (≥20 closed trades) is mechanically un-meetable today — the data does not exist. Building the
> regime classifier + correlated strategy now would be building against zero observations, exactly
> the over-fitting M29's D1 refused.
>
> **M30 is therefore the milestone that runs and reads the M29 soak.** It does two things and only
> two things: (1) it formalizes the **idiosyncratic-edge soak gate** as an executable instrument —
> a closed-trade expectancy + regime-robustness query — so the slot-C go/no-go decision is read from
> the DB, not asserted; and (2) it closes the **idiosyncrasy-funnel observability gap** that M29 left
> open (`no_eligible_slot` was the #3 reachable blocker at 38 rejects, but `getFunnelSummary` cannot
> yet show *how far* a rejected coin missed the threshold), and it **hardens the
> `computeIdiosyncrasyScore` pure function** against near-zero-noise edge cases with tests — a
> pure-function change with no DB param, no threshold move, no migration. **Code + ADR + tech-debt
> only — no schema migration, no shared-package change, no strategy-param (DB) change, no safety floor
> relaxed.** An engine restart (no `.env` change required) picks it up.

## Goal

Turn the M29 soak from "running and hopefully producing fills" into a **read-out the operator can
act on**: a single canonical query that answers *"does the idiosyncratic leg have enough closed trades
to evaluate — and what does the expectancy look like split across BTC-move conditions?"* — the exact
gate that ADR 0004 §8a and the M29 tech-debt entry placed in front of any slot-C work. In parallel, M30 removes the one observability
blind-spot that would otherwise make the soak's `no_eligible_slot` rejects unreadable (we can count
them but not see how far each coin missed), and it pins the idiosyncrasy formula's noise behaviour so
a future calibration milestone has a tested baseline. M30 is deliberately **measurement-first and
minimum-touch**: it changes no trading behaviour, relaxes no floor, and moves no threshold. The only
runtime behaviour change is a defensive guard inside a pure function that affects pathological
near-zero-noise inputs (and is asserted to leave every real soak input byte-identical).

## Problem

The WIP frames the next step as the correlated slot-C leg and lists five prerequisites (regime
classifier, new flow types, slot-C entry/exit, correlated sizing, independent backtest). M29 already
established — and locked in ADR 0004 §8a + tech-debt — that **none of those may start until the
idiosyncratic path has produced ≥20 closed trades with measurable expectancy**. The blocker M30 must
clear is not "build slot C"; it is **"we cannot yet read whether the gate-to-slot-C is open, and the
funnel can't tell us why the idiosyncratic path is rejecting the borderline coins the WIP named."**

### Code-verified current state (read 2026-06-11, post-M29 commit `fbadab8`)

**1. The soak that gates slot C has not run yet.** M29 landed today. The post-M29 `positions` /
`transactions` history is at most hours old; the ≥20-closed-trade floor (ADR 0004 §8a, tech-debt
MEDIUM "Differentiated correlated slot-C strategy") is structurally un-meetable. Slot-C work cannot
begin in M30 — there is no edge measurement to gate it. **(Verified: M29 is the most recent commit;
work-log `2026-06-11` row marks M29 DONE with post-deploy soak "in progress".)**

**2. The production idiosyncrasy threshold is `0.5`, not `0.3` — the WIP is stale on this point.**
`BASE_PARAMS.idiosyncrasy_min_score = 0.5` in the seed migration
(`apps/engine/src/database/migrations/20260522020000-SeedStrategyVersions.ts:20`), shared by **all**
versions including the active v2 momentum (`ACTIVE_STRATEGY_VERSION_ID=3` → version 2). The WIP says
"`< 0.3` → rejected `no_eligible_slot`"; in production the cut is at **0.5**. The WIP's borderline
examples — DOGE `0.295`, ADA `0.352` — are rejected at `0.5` **and would still be rejected at `0.3`**.
The test fixtures that use `0.3` (`BacktestOrchestrator.spec.ts:58` et al.) are **fixture values, not
production config**. This matters: any future "loosen the idiosyncrasy gate" reasoning must start from
the real 0.5 cut, and `idiosyncrasy_min_score` is a **per-version DB param** (seed migration), so
moving it is a migration/strategy-param change — explicitly **out of M30 scope** (D5 of M29 named the
threshold "the load-bearing A/B-slot eligibility gate").

**3. `computeIdiosyncrasyScore` has un-pinned near-zero-noise behaviour.** The pure function
(`apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts`) is:

```
score = clamp[0,1]( 1 − abs(btc5mMovePct) / abs(coin5mMovePct) )
with the single guard: abs(coin5mMovePct) === 0 → return 0
```

Code-verified edge cases that are **not** guarded and **not** pinned by a test:

- **Near-zero-noise inflation.** A coin moving `0.02%` while BTC moves `0.005%` scores
  `1 − 0.005/0.02 = 0.75` → passes the 0.5 idiosyncratic gate **on pure microstructure noise**. The
  formula has no minimum-coin-move floor; a tick of noise on a flat coin reads as "idiosyncratic
  conviction." This is the most plausible source of *false* idiosyncratic eligibility, the mirror of
  the `no_eligible_slot` rejections — and it is unmeasured.
- **Exact-zero BTC move.** `btc5mMovePct === 0` with any non-zero coin move → score `1.0`. Benign
  (BTC genuinely flat ⇒ the coin is genuinely idiosyncratic), but undocumented and untested at the
  boundary.
- **No stablecoin / degenerate-input guard.** A symbol whose `coin5mMovePct` is a sub-basis-point
  rounding artifact is treated as a real denominator.

These are **pure-function** concerns: no DB param, no threshold, no I/O, no migration. Pinning them
(and adding a conservative minimum-coin-move noise floor that only ever *removes* false idiosyncratic
eligibility — the safe direction) is the lowest-risk surface in the codebase.

**4. `getFunnelSummary` counts `no_eligible_slot` but cannot show how far a coin missed.** The M29
query (`packages/analysis/src/query/getFunnelSummary.ts`) rolls up `action='open'` decisions by
`reason`, buckets `gate_allowed` three ways, splits `sl_outside_liquidation` by sub-cause, and is
explicit (line 58–59) that **R-multiples / expectancy are NOT computed — "deferred to a future
positions-linked rollup keyed on `effectiveRiskUsdt`."** That future rollup is the **literal
instrument the slot-C gate needs**, and it does not exist yet. (M29's "keyed on `effectiveRiskUsdt`"
phrasing assumed that field would be persisted; code verification (F1 below) found it is not, so D2
reconstructs the risk denominator from fill-anchored `positions` columns instead — see amended D2.) Separately, `no_eligible_slot` rows
carry the coin's `idiosyncrasy_score` and `btc_5m_move_pct` in `market_snapshot` JSONB (the event
fields `idiosyncrasyScore` / `btc5mMovePct` are persisted), so the *miss distance* (how far below 0.5
each rejected coin scored) is derivable from existing columns — but `getFunnelSummary` does not
surface it. Without it, the soak cannot answer "is the idiosyncrasy gate rejecting marginal-but-real
edge, or correctly filtering BTC-beta?"

**5. The slot-C plumbing is confirmed-undifferentiated (M29 pinned this with tests).**
`SlotManager.assignCorrelated` assigns slot C and enforces `BTC_CORRELATED_SLOT_TAKEN`;
`resolveCorrelationMode` emits `CORRELATED` at `abs(btc_5m_move_pct) ≥ 1.5%`; the per-bar buffer
selects the single best candidate. **But the correlated winner is evaluated by the same
`momentumCore` as an idiosyncratic trade** — no regime classifier, no trend exit, no correlated
sizing (verified at `SlotManager.ts`; M29 `StrategyService.m29.spec.ts` correlated pins). M30 does
**not** touch any of this — it is the WIP's real ask and stays deferred behind the soak gate.

### Code-verified findings from independent review (read 2026-06-11, three LLM reviews + architect re-verification)

Three independent reviews surfaced four issues the original quant review missed. All four were
re-verified against live code by the architect before this amendment. They materially change D2 and D4.

**F1 — `effectiveRiskUsdt` is NOT persisted anywhere (confirmed).** `effectiveRiskUsdt` lives only on
the **engine-internal** `IIntentSizing` interface (`apps/engine/src/risk/interface/IIntentSizing.ts:11`)
— it is explicitly *not* a `@bot/shared` type and "never crosses the shared boundary." It is computed
in `PositionSizer` (`PositionSizer.ts:66`) and threaded through `IOrderIntent`/`IRiskDecision` at
runtime, but **`StrategyService.buildGateGeometry` persists only `qty`, `notional`, `leverage` from
`decision.approvedSizing`** (`StrategyService.ts:423–434`) — `effectiveRiskUsdt` is dropped. Neither
`DecisionEntity` nor `PositionEntity` has an `effective_risk_usdt` column (verified — `DecisionEntity.ts`
M27 geometry columns stop at `qty/notional/leverage/halt_reason_detail`; `PositionEntity.ts` has no
such column). **Consequence:** D2 cannot read `effectiveRiskUsdt` from any row. The R-multiple
denominator must be **reconstructed from fill-anchored persisted columns** (see amended D2). Adding the
column would be a migration + shared-package-adjacent change — explicitly out of M30's minimum-touch scope.

**F2 — `BacktestEventBuilder` has a SEPARATE idiosyncrasy formula (confirmed).**
`apps/engine/src/backtest/service/BacktestEventBuilder.ts:117–127` defines a **private**
`computeIdiosyncrasyScore(symbol5m, btc5m)` =
`abs(symbol5m − btc5m) / (abs(symbol5m) + abs(btc5m) + 0.0001)`, clamped to [0,1]. This is a
**completely different function** from the live
`apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts`, which is
`1 − abs(btc5m)/abs(coin5m)`. The two produce different scores for the same inputs. The backtest event
builder calls its own private formula (line 73), not the live indicator. **Consequence:** the
live/backtest idiosyncrasy-scoring path **already diverges today** — this predates M30. D4's noise floor
hardens only the **live** function; it does not (and must not claim to) unify the two. D4's "both call
the same function" claim is **corrected** below, and the divergence is logged as a MEDIUM tech-debt item
deferred to a separate milestone.

**F3 — `decisions.position_id` exists but is never stamped on open (confirmed).** `DecisionEntity` *has*
a `position_id` column + `ManyToOne` to `PositionEntity` (`DecisionEntity.ts:46–51`), but
`StrategyService.persistDecision` (`StrategyService.ts:460–486`) **never writes it** on the open-decision
path. So a position-to-open-decision join via `decisions.position_id` is unreliable (the column is null
on the live soak rows). **Consequence:** D2 must join closed positions to their open decision by a
**LATERAL time-join**, not via `position_id` (see amended D2). A LOW tech-debt item ("stamp
`decisions.position_id` on successful open fill") is added — out of M30 scope.

**F4 — D3 bucket-count wording inconsistency (confirmed, still present).** D3 prose still says "four
equal-width buckets" on one line and then lists **five** (`[0,0.1)…[0.4,0.5]`). Corrected to "five"
consistently below.

### Why this is the right M30 (build-order)

The build order locked across M24→M29 is: **fill mechanics → first fill → idiosyncratic-edge
measurement → (only then) correlated strategy.** M29 delivered the first three *capabilities*; M30
delivers the **measurement read-out** that the fourth step is gated on, plus the funnel visibility to
diagnose the soak's dominant idiosyncratic-path reject (`no_eligible_slot`). Building anything in the
correlated leg now would invert the order against zero data. The conservative-survival priority and
M29's D1 both require M30 to be the soak instrument, not the slot-C build.

## Architectural decisions

### D1 — M30 is the soak read-out + idiosyncrasy observability, NOT slot C (re-affirm M29 D1)

The single most important decision, restated because the WIP keeps pulling toward slot C: **do not
build the correlated leg.** The prerequisite (≥20 closed idiosyncratic trades across ≥3 trading
days) is un-meetable today (the soak has not run). M30's deliverable is the
**executable gate that reads whether that prerequisite is met**, plus the funnel visibility to
understand the idiosyncratic path's rejections. The correlated leg stays deferred (tech-debt MEDIUM,
unchanged) and re-opens only when the M30 expectancy query reports a passing gate.

### D2 — Build the closed-trade expectancy + regime-robustness query (the actual slot-C gate)

M29 explicitly deferred the positions-linked, risk-denominated rollup
(`getFunnelSummary.ts:58–59`). M30 builds it as a new canonical query in `packages/analysis`
(e.g. `getIdiosyncraticEdgeReport`), mirroring `getFunnelSummary` / `getPerformance`.

**Denominator is reconstructed, not read (F1 — `effectiveRiskUsdt` is not persisted).** Code
verification confirms `effectiveRiskUsdt` lives only on the engine-internal `IIntentSizing` and is
**never written to any row** — `StrategyService.buildGateGeometry` persists `qty/notional/leverage`
only, and no `effective_risk_usdt` column exists on `decisions` or `positions`. M30 therefore
reconstructs the realized-risk denominator from **fill-anchored persisted `positions` columns**:

```
reconstructedEffectiveRiskUsdt = positions.qty × |positions.entry_price − positions.stop_loss_price|
```

This is the actual dollar risk realized **at fill** — the distance from the filled entry to the
protective stop, times the filled quantity. It is the quantity `effectiveRiskUsdt` was meant to capture,
but anchored to fill-time values (not the pre-round intent values that `IIntentSizing.effectiveRiskUsdt`
held in memory). This is **more correct** for an edge read-out: it reflects what was actually risked,
not what was intended pre-rounding. **No migration, no shared-package change** — all three columns
already exist on `PositionEntity` (`qty`, `entry_price`, `stop_loss_price`).

- **Closed idiosyncratic positions only**, over a UTC date range. Primary filter is
  `positions.correlation_mode = 'idiosyncratic'` (idiosyncratic vs correlated — the correlated path is
  undifferentiated so its PnL is non-attributable per M29). Do **not** rely on `decisions.position_id`
  for the open-decision join — that column exists but is never stamped on open (F3). Join each closed
  position to its open decision via a **LATERAL subquery**: for each position, the most recent
  `decisions` row matching `(strategy_version_id, symbol, action='open', gate_allowed=true,
  ts <= positions.opened_at) ORDER BY ts DESC LIMIT 1`. This recovers the `market_snapshot` for the
  BTC-move sub-split without needing `position_id`.
- **R-multiple per trade = realized PnL / `reconstructedEffectiveRiskUsdt`** (ADR 0004 §8a/§8b,
  quant-HIGH rule: the denominator is the **fill-anchored realized risk**, never the pre-clamp
  `riskPerTradeUsdt` target). A closed position where **any** of `qty`, `entry_price`,
  `stop_loss_price` is null yields a **null** R-multiple and is **excluded from the expectancy
  aggregate** — never a target-based fallback (same exclusion rule as the M29-deferred design, now
  keyed on the three reconstruction columns rather than on a persisted `effectiveRiskUsdt`).
- **Aggregate expectancy** = mean R-multiple over the eligible closed trades, plus `n` (closed-trade
  count), `distinctTradingDays`, and `rMultipleStdError` (standard error of the mean R-multiple =
  `stdDev / sqrt(n)`, decimal math) so the operator can read uncertainty alongside the point estimate.
  At n=20 the standard error is typically 0.3–0.7 R — the field makes the wide confidence interval
  explicit rather than implied. **`rMultipleStdError` returns `null` (not `0`) when `n < 2`** —
  a single trade has no dispersion, and returning `0` would imply false certainty. `null` reads
  honestly as "standard error undefined at this sample size."
- **Clamp-distortion disclosure.** Also report `clampedTradeCount` and `clampedTradeFraction`. A trade
  is "clamped" when its `reconstructedEffectiveRiskUsdt` is **below the per-trade risk target** —
  i.e. the per-coin cap was binding so realized risk fell short of the intended risk budget. The target
  is `riskPerTradeUsdt = accountCapitalUsdt × riskPerTradePct`, **passed in as a query parameter**
  (the query has no access to engine config; the operator/caller supplies `accountCapitalUsdt = 1500`,
  `riskPerTradePct = 0.01` ⇒ a $15 target). When the cap binds, `reconstructedEffectiveRiskUsdt < $15`
  and the same dollar PnL produces a larger R than an unclamped trade — the aggregate `meanRMultiple`
  mixes two risk regimes. Reporting the fraction lets the operator see how much of the expectancy is
  clamp-distorted.
- **Gate fields** computed against the ADR 0004 §8a floor: `meetsClosedTradeFloor`
  (`n ≥ MIN_CLOSED_TRADES_FOR_EDGE_VERDICT = 20`), `meetsTradingDayFloor`
  (`distinctTradingDays ≥ MIN_TRADING_DAYS_FOR_EDGE_VERDICT = 3`).
- **BTC-move sub-split (advisory, not part of the hard gate).** Partition the eligible closed trades
  by the BTC 5-minute move *at entry bar*, derived from the open decision's
  `market_snapshot->>'btc_5m_move_pct'` against the existing `btc_correlated_move_threshold_pct =
  1.5%` boundary, into three observation-only buckets: `btc_5m_up` (`btc_5m ≥ +1.5%`),
  `btc_5m_down` (`btc_5m ≤ −1.5%`), `btc_5m_flat` (in between). Report per-bucket `n` and mean
  R-multiple. **These are per-bar move labels, not regime labels** — a single 5-minute return is not
  a stable regime state (the WIP's own definition). Naming them `btc_5m_*` avoids implying a regime
  classifier that does not exist yet. Idiosyncratic triggers fire *because BTC is calm*, so
  `btc_5m_flat` will structurally hold the majority of trades; that is expected and correct, not a
  failure of the sub-split. Per-bucket expectancy is **advisory**: when a bucket holds fewer than
  `REGIME_BUCKET_MIN_N = 8` trades its sign should not be trusted (below this the standard error of
  mean R exceeds the likely effect size).
- **`regimeRobustnessPasses` (advisory flag, not wired into the hard gate).** True when every bucket
  with `n ≥ REGIME_BUCKET_MIN_N` has a mean R-multiple whose sign agrees with the aggregate. This is
  the consistency check the WIP asks for, but because (a) the per-bar proxy is not a true regime
  classifier and (b) `btc_5m_flat` will dominate by construction, a `false` value here does not
  block the gate — it is a signal for the operator to investigate, not a hard lock.
- **Overall `slotCGateOpen`** = `meetsClosedTradeFloor AND meetsTradingDayFloor`. This boolean is the
  documented go/no-go the operator reads before any slot-C milestone is opened. **`slotCGateOpen`
  means "sufficient sample to evaluate" — it does not assert positive expectancy.** A measured
  *negative* expectancy with the gate open is actionable data (it means "decide," not "build").
  `regimeRobustnessPasses` is reported alongside but is **not** AND'd into the gate: a real positive
  edge running primarily through calm-BTC sessions should not be structurally blocked by a per-bar
  proxy biased toward the ranging bucket.

> **`slotCGateOpen` naming note.** The name reads slightly permission-granting. If the engine team
> prefers a less suggestive field name (e.g. `slotCEdgeSampleReady`), that is acceptable — the
> load-bearing thing is the ADR §8b comment making explicit that the flag is a **sample-readiness**
> signal ("enough closed trades to evaluate"), **not** an edge-positive assertion. Do not rename it
> unilaterally; the engine agent may pick the clearer name at implementation time.

Read-only, derived from existing rows via fill-anchored reconstruction, no migration, no new persisted
state, no shared-package change, determinism-irrelevant (reporting path). All money math is decimal
(`decimal.js` at the query boundary, consistent with `getPerformance`); no float in PnL/R-multiple
arithmetic.

### D3 — Extend the funnel with idiosyncrasy miss-distance for `no_eligible_slot`

`no_eligible_slot` was the #3 reachable M29 blocker (38). To read the soak's idiosyncratic-path
rejections, the operator needs not just the count but the **distribution of how far each rejected coin
missed the 0.5 cut**. Extend the funnel surface (preferably a sibling query
`getIdiosyncrasyMissDistribution`, or an additive field on the `no_eligible_slot` funnel rows — engine
agent picks the lighter correct form) to derive, from existing `decisions` columns + `market_snapshot`
JSONB:

- per `no_eligible_slot` open-decision row: the coin's `idiosyncrasyScore`
  (`market_snapshot->>'idiosyncrasy_score'`) and `btc_5m_move_pct`;
- a bucketed histogram of the **miss distance** = `idiosyncrasy_min_score − idiosyncrasyScore`
  using **five** equal-width buckets of width 0.1: `[0,0.1)`, `[0.1,0.2)`, `[0.2,0.3)`, `[0.3,0.4)`,
  `[0.4,0.5]`, per UTC day. (Five, not four — the range `[0,0.5]` at width 0.1 yields five bands; the
  top band is kept distinct so deep BTC-beta rejects near score=0 are distinguishable from
  borderline-miss rejects near score=0.4.) Confirm: a coin scoring exactly at the threshold
  (miss-distance=0) passes the gate and must never appear in this distribution.

Purpose: answer "are most `no_eligible_slot` rejects deep BTC-beta (large miss, correctly filtered),
or a cluster of marginal misses (small miss, candidate for a *future, separately-justified*
calibration)?" The threshold is read from the **active strategy version's params resolved via
`ACTIVE_STRATEGY_VERSION_ID`** (the same source the engine uses — not from `WHERE status='active'`
which points to the v0 seed row, not the env-selected v2). Pass the active version id in explicitly
or resolve it from the config constant, and add a test asserting the query reads v2's param (id=3)
rather than the status-active row. **M30 does not
move the threshold** — it only makes the miss-distance legible so a future calibration milestone has
evidence instead of the WIP's stale 0.3 assumption. Read-only, derived, no migration.

### D4 — Harden `computeIdiosyncrasyScore` against near-zero-noise inflation (the only runtime change)

The pure function currently lets a sub-basis-point coin move with a smaller BTC move score as
high-conviction idiosyncratic (`0.02%` coin / `0.005%` BTC → `0.75`). Add a **minimum-coin-move noise
floor**: when `abs(coin5mMovePct) < IDIOSYNCRASY_MIN_COIN_MOVE_PCT`, return `IDIOSYNCRASY_SCORE_MIN`
(0) — the same fail-closed outcome as the existing `coinMagnitude === 0` guard, generalized from
"exactly zero" to "indistinguishable from noise."

- **Direction is provably safe.** The floor only ever **lowers** a score toward 0 — it can only
  *remove* false idiosyncratic eligibility (turn a noise-inflated pass into a `no_eligible_slot`
  reject). It can **never** inflate a score or open a trade that was previously rejected. This is the
  conservative-survival direction: it tightens, never loosens.
- **Threshold value, conservatively chosen.** `IDIOSYNCRASY_MIN_COIN_MOVE_PCT` is a new engine const
  in `apps/engine/src/market-data/const/indicatorConsts.ts`, set **strictly below the smallest real
  trigger move**. The strategy already requires `tier{1,2,3}_min_abs_move_pct` of `0.8 / 1.2 / 1.5`%
  for a coin to even register a volatility trigger (seed params). A `0.05%` noise floor is **16× below**
  the tightest tier-1 trigger floor — so for **every real soak input the floor is inert** and the
  score is byte-identical to today. It only bites pathological inputs that could never have produced a
  trigger anyway. This inertness must be **asserted by a regression test on real-tier-magnitude
  fixtures** (D4 tests below). The regression must cover the **full call-graph of the function** —
  not only trigger-magnitude fixtures — because any non-trigger code path (e.g. a telemetry or
  shadow path) that calls `computeIdiosyncrasyScore` on sub-0.05% moves would see changed scores.
  The engine agent must confirm there are no such callers before claiming inertness is total.
- **Determinism preserved on the live path; live/backtest are already separate functions (F2).** The
  hardened function is still a pure function of two numbers — no clock/RNG/I/O — so live re-runs are
  deterministic. **D4 hardens the *live* scoring path only** (`computeIdiosyncrasyScore.ts`). Code
  verification (F2) found that the **backtest does NOT call this function**: `BacktestEventBuilder.ts`
  has a *separate private formula* (`abs(symbol−btc)/(abs(symbol)+abs(btc)+0.0001)`) that is
  algebraically different from the live `1 − abs(btc)/abs(coin)`. The earlier draft's claim that
  "backtest and live read identical scores because both call the same function" is **false and is
  retracted** — the two paths already diverge, independent of M30. D4 does **not** fix that divergence
  (out of scope) and must not silently claim parity; it only removes near-zero-noise false eligibility
  on the live path. See the new **D4b** below.

### D4b — The live/backtest idiosyncrasy-scoring divergence is a pre-existing gap M30 does NOT fix

Code verification surfaced (F2) that live and backtest compute idiosyncrasy by **two different
formulas**:

- **Live** (`apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts`):
  `clamp[0,1]( 1 − abs(btc5m)/abs(coin5m) )`, zero-guard on `coin5m === 0`.
- **Backtest** (`apps/engine/src/backtest/service/BacktestEventBuilder.ts:117–127`, **private**):
  `clamp[0,1]( abs(coin5m − btc5m)/(abs(coin5m)+abs(btc5m)+0.0001) )`, zero-guard on `btc5m === 0`.

These yield different scores for the same inputs, so the **same strategy run live vs in backtest sees a
different idiosyncrasy gate** — a violation of the same-code-live-and-backtest invariant on this
specific field. This predates M30. **M30 explicitly does not fix it** (touching the backtest formula
would change replay outputs and demands its own parity test suite + backtest re-baseline). D4 only
hardens the live function; it neither widens nor narrows this divergence. A **MEDIUM tech-debt entry**
is added: *"Unify live/backtest idiosyncrasy scoring on `computeIdiosyncrasyScore` (the live function),
delete the private `BacktestEventBuilder` formula, and add a live-vs-backtest parity test"* — deferred
to a separate milestone. M30's job here is to **name** the divergence, not resolve it.

> **Honest framing of the one behaviour change.** Strictly, adding a floor *is* a runtime behaviour
> change to a function on the strategy-eligibility path, which M29 D5 named load-bearing. It is in
> scope for M30 — and only this — because (a) it is a pure function with no DB param and no migration,
> (b) its direction is provably tightening (never opens a trade), and (c) it is asserted inert for all
> real trigger magnitudes. It is the noise-floor analogue of the existing zero-guard, not a threshold
> move. **The idiosyncrasy *threshold* (`idiosyncrasy_min_score = 0.5`) is NOT touched** — that
> remains the deferred per-version DB-param calibration.

### D5 — Do NOT touch the threshold, the slot model, the VWAP stop, or any DB param

`idiosyncrasy_min_score` (0.5, per-version DB param), `SlotManager`, the correlated buffer, the VWAP
structural stop / `sl_outside_liquidation` logic, the depth floor, and `MAX_EXPOSURE_PER_COIN_USDT`
are all **read and reported on** in M30 but **not changed**. Each is on its own evidence-gated track:

- The **idiosyncrasy threshold** is a strategy/quant calibration requiring a seed-migration param
  change + backtest; D3's miss-distribution is the *evidence-gathering* for it, not the change itself.
- The **`sl_outside_liquidation` forensics** track (tech-debt MEDIUM, M29) uses the existing
  `getFunnelSummary` sub-cause split — M30 does not pre-empt it.
- The **slot-C correlated strategy** stays deferred behind the D2 gate.

M30 changes exactly one runtime line of logic (the D4 noise floor, provably tightening). Everything
else is observability.

## Scope

### What changes

1. **`packages/analysis/src/query/getIdiosyncraticEdgeReport.ts` (new)** — D2 closed-trade expectancy
   query; exports `IIdiosyncraticEdgeReport` from the package index; decimal math; **fill-anchored
   reconstructed risk denominator** = `positions.qty × |entry_price − stop_loss_price|` (F1 —
   `effectiveRiskUsdt` is not persisted, so it is reconstructed, not read); open-decision join via
   **LATERAL time-join** (F3 — `decisions.position_id` is never stamped); `rMultipleStdError`
   (**`null` when `n < 2`**); `clampedTradeCount/Fraction` vs a passed-in `riskPerTradeUsdt`
   (= `accountCapitalUsdt × riskPerTradePct`); `btc_5m_up/down/flat` advisory sub-split with per-bucket
   `n` and mean R; advisory `regimeRobustnessPasses` flag (not in hard gate); `slotCGateOpen` =
   `meetsClosedTradeFloor AND meetsTradingDayFloor` only. No migration, no shared-package change.
2. **`packages/analysis/src/query/getIdiosyncrasyMissDistribution.ts` (new)** *or* an additive field
   on the existing `no_eligible_slot` funnel rows — D3 miss-distance histogram, derived from
   `market_snapshot` JSONB; five equal-width buckets `[0,0.1)…[0.4,0.5]`; threshold resolved from
   `ACTIVE_STRATEGY_VERSION_ID` (not `status='active'` DB row).
3. **`packages/analysis/src/const/` (extend)** — new gate constants: `MIN_CLOSED_TRADES_FOR_EDGE_VERDICT
   = 20`, `MIN_TRADING_DAYS_FOR_EDGE_VERDICT = 3`, `REGIME_BUCKET_MIN_N = 8`, idiosyncrasy miss
   bucket edges (five: `[0,0.1)…[0.4,0.5]`). Mirrors `analysisFunnelConsts.ts`.
4. **`apps/engine/src/market-data/const/indicatorConsts.ts` (extend)** — new const
   `IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05` (D4 noise floor).
5. **`apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts` (edit)** — add the
   `abs(coin5mMovePct) < IDIOSYNCRASY_MIN_COIN_MOVE_PCT → IDIOSYNCRASY_SCORE_MIN` guard (D4); doc
   comment cites the tier trigger floors and the tightening-only direction.
6. **Tests** — D2 query, D3 query, D4 noise-floor guard + inertness regression (counts below).
7. **ADR 0004 §8b (new)** — the idiosyncratic-edge soak gate: the `slotCGateOpen` definition + floors
   + regime-robustness rule; the **fill-anchored risk reconstruction**
   (`qty × |entry_price − stop_loss_price|`) and *why* it is reconstructed (F1 — `effectiveRiskUsdt`
   is never persisted) with the three-column null-exclusion rule; the LATERAL open-decision join (F3);
   the `rMultipleStdError = null` at `n < 2` rule; the `slotCGateOpen` "sample-readiness, not
   edge-positive" semantics; and the D4 noise floor (tightening-only, inert for real triggers). Note
   D3 miss-distribution is observability-only/derived, and record (per D4b) that live/backtest
   idiosyncrasy scoring already diverges and M30 does not unify it.
8. **`docs/tech-debt.md`** — annotate the existing MEDIUM "Differentiated correlated slot-C strategy"
   entry to point its gate at the new `getIdiosyncraticEdgeReport.slotCGateOpen` instrument (replace
   the prose floor with the executable query); add one MEDIUM for the **idiosyncrasy-threshold
   calibration** (now evidence-backed by D3's miss-distribution, starting from the *correct* 0.5 cut,
   not the WIP's stale 0.3); add one **MEDIUM** for the **live/backtest idiosyncrasy-scoring
   divergence** (D4b/F2 — unify on the live `computeIdiosyncrasyScore`, delete the private
   `BacktestEventBuilder` formula, add a parity test); add one **LOW** for **stamping
   `decisions.position_id` on successful open fill** (F3 — the column exists but is never written,
   forcing D2's LATERAL time-join).

### What does NOT change

- **No schema migration, no shared-package change, no DB write at rest, no strategy-param (seed)
  change.** Both new queries derive from existing rows.
- **No threshold move** — `idiosyncrasy_min_score = 0.5` unchanged; `MAX_EXPOSURE_PER_COIN_USDT`,
  `MAX_LEVERAGE`, `RISK_PER_TRADE_PCT`, depth floor, liquidation buffer, breadth/stress thresholds —
  all unchanged.
- **No slot-model / correlated change** — `SlotManager`, `resolveCorrelationMode`, the per-bar buffer,
  `btc_correlated_not_best_candidate` — untouched (M29 pinned them).
- **No strategy code** — `momentumCore`, the VWAP structural stop, `classifyFlowType`,
  `resolveCorrelationMode` are untouched. The **only** runtime change is the D4 noise floor inside
  `computeIdiosyncrasyScore`, provably tightening and asserted inert for real triggers.
- **No `.env` change** — M30 needs no config change; engine restart only.
- **No new HTTP endpoint or dashboard widget** — the queries are canonical `packages/analysis`
  functions (any future endpoint delegates to them), consistent with M29 D3.

## Implementation steps (ordered, for `bot-engine-nestjs` + analysis)

1. **`indicatorConsts.ts` + `computeIdiosyncrasyScore.ts` — D4 noise floor.** Add
   `IDIOSYNCRASY_MIN_COIN_MOVE_PCT = 0.05`. In the function, after the existing
   `coinMagnitude === 0` guard, add `if (coinMagnitude < IDIOSYNCRASY_MIN_COIN_MOVE_PCT) return
   IDIOSYNCRASY_SCORE_MIN;`. Doc comment: cite `tier1_min_abs_move_pct=0.8` (the floor is 16× below
   the tightest real trigger, so inert for every real input); state the floor only ever lowers a
   score (tightening-only, never opens a trade).
2. **`getIdiosyncraticEdgeReport.ts` (new, `packages/analysis`) — D2.** Select closed
   `positions WHERE correlation_mode = 'idiosyncratic'` in the UTC range; for each, LATERAL-join the
   most recent open decision `(strategy_version_id, symbol, action='open', gate_allowed=true,
   ts <= opened_at) ORDER BY ts DESC LIMIT 1` to recover `market_snapshot` (do NOT use
   `decisions.position_id` — never stamped, F3). Compute per-trade
   `reconstructedEffectiveRiskUsdt = qty × |entry_price − stop_loss_price|` (F1); R-multiple =
   `realized_pnl / reconstructedEffectiveRiskUsdt`, **null + excluded** when any of `qty`,
   `entry_price`, `stop_loss_price` is null. Aggregate `meanRMultiple`, `rMultipleStdError`
   (= `stdDev/sqrt(n)`, decimal; **`null` when `n < 2`**), `n`, `distinctTradingDays`; flag
   `clampedTradeCount` + `clampedTradeFraction` against the **passed-in** `riskPerTradeUsdt`
   (= `accountCapitalUsdt × riskPerTradePct`, supplied in query params — the query has no engine
   config); compute `meetsClosedTradeFloor` / `meetsTradingDayFloor`; build the `btc_5m_up/down/flat`
   sub-split from `market_snapshot->>'btc_5m_move_pct'` vs the 1.5% boundary; compute advisory
   `regimeRobustnessPasses` (sign-consistent across buckets with `n ≥ REGIME_BUCKET_MIN_N`, not in the
   hard gate); `slotCGateOpen = meetsClosedTradeFloor AND meetsTradingDayFloor`. Parameterized SQL
   (positional bindings, no interpolation — boundary lint R0). Decimal math throughout. Export
   `IIdiosyncraticEdgeReport` from the index.
3. **`getIdiosyncrasyMissDistribution.ts` (new) — D3.** For `action='open'`,
   `reason='no_eligible_slot'` rows, derive `idiosyncrasyScore` from `market_snapshot`, compute
   `missDistance = activeMinScore − idiosyncrasyScore`, bucket into five equal-width buckets
   `[0,0.1)…[0.4,0.5]`, group per UTC day. Resolve `activeMinScore` from the strategy version
   identified by `ACTIVE_STRATEGY_VERSION_ID` (passed in or resolved from config) — not from
   `WHERE status='active'` which points to the v0 seed row, not the env-selected v2. Parameterized
   SQL; read-only.
4. **`analysisFunnelConsts.ts` (or a sibling const file) — gate + bucket consts.** Add
   `MIN_CLOSED_TRADES_FOR_EDGE_VERDICT = 20`, `MIN_TRADING_DAYS_FOR_EDGE_VERDICT = 3`, the miss-
   distance bucket edges, and the BTC-regime boundary (reuse the 1.5% value with a named const, do
   not magic-number it).
5. **Tests** — D2 / D3 / D4 (counts below), via the existing analysis Jest pattern + engine unit
   pattern.
6. **ADR 0004 §8b + tech-debt** — as in Scope items 7–8.

## Config changes

- **No new env var, no new strategy param, no schema migration, no `.env` change.** Effective runtime
  config unchanged (`MAX_OPEN_POSITIONS=3`, `MAX_EXPOSURE_PER_COIN_USDT=500`, `ACCOUNT_CAPITAL_USDT=1500`,
  `RISK_PER_TRADE_PCT=0.01`, `ACTIVE_STRATEGY_VERSION_ID=3`, `EXCHANGE_ENV=paper`,
  `idiosyncrasy_min_score=0.5`).
- New **engine const** `IDIOSYNCRASY_MIN_COIN_MOVE_PCT=0.05` and new **analysis consts** (gate floors,
  buckets) — code constants, not operator config.

## Tests required (for `bot-qa-engineer`)

**Unit — `computeIdiosyncrasyScore` noise floor (D4):**
- A coin move **below** `IDIOSYNCRASY_MIN_COIN_MOVE_PCT` (e.g. `0.02%`) with a smaller BTC move (that
  would otherwise score `> 0.5`) now returns `0` (the noise-floor reject) — the core D4 behaviour.
- Boundary: `abs(coin5mMovePct)` exactly `IDIOSYNCRASY_MIN_COIN_MOVE_PCT` is **not** floored (the
  guard is strict `<`); a hair below is floored.
- **Inertness regression (the safety assertion):** at every real tier trigger magnitude
  (`0.8 / 1.2 / 1.5%` and above, both directions, with a range of BTC moves) the returned score is
  **byte-identical** to the pre-D4 formula — proving the floor never touches a real input. The engine
  agent must first confirm via grep that no non-trigger call-site passes sub-0.05% moves to this
  function; if any such call-site exists, its inputs must also be fuzz-covered in the regression.
- Exact-zero BTC move with a real coin move still returns `1.0` (boundary pinned, unchanged).
- The existing `coinMagnitude === 0 → 0` guard still holds (regression).
- Pure / deterministic: same inputs → same score; no float drift.
- **Live/backtest divergence is NOT silently closed (D4b/F2):** the test suite must not assert that
  `BacktestEventBuilder`'s private idiosyncrasy formula equals the live `computeIdiosyncrasyScore`
  (they are intentionally different and divergence resolution is out of M30 scope). The D4 inertness
  test targets the **live** function only; do not add a parity assertion that would falsely imply M30
  unified the two paths.

**Unit — `getIdiosyncraticEdgeReport` (D2):**
- R-multiple uses the **fill-anchored reconstructed** denominator
  `qty × |entry_price − stop_loss_price|`; a fixture closed trade with a clamped (small) reconstructed
  risk yields R on that reconstructed value (below the $15 target), **not** on `riskPerTradeUsdt`.
- A closed trade missing **any** of `qty`, `entry_price`, `stop_loss_price` yields **null** R and is
  **excluded** from the aggregate — never a target-based fallback. (Cover each of the three nulls.)
- The open-decision LATERAL join recovers `market_snapshot` from the most-recent matching open
  decision (`ts ≤ opened_at`, `gate_allowed=true`), **not** via `decisions.position_id` — a fixture
  with `position_id = null` on the decision row still resolves the snapshot correctly.
- `meetsClosedTradeFloor` flips at exactly `n = 20`; `meetsTradingDayFloor` at exactly
  `distinctTradingDays = 3` (boundary tests).
- Only **idiosyncratic** closed positions are counted (a correlated-mode close is excluded — its PnL
  is non-attributable per M29).
- `rMultipleStdError` is computed as `stdDev / sqrt(n)` in decimal; a two-trade fixture with known
  values produces the expected standard error (no float drift). A **single-trade** range returns
  `rMultipleStdError = null` (not `0` — no false certainty); a zero-trade range also returns `null`.
- `clampedTradeCount` and `clampedTradeFraction` correctly flag trades where the reconstructed risk is
  below the passed-in `riskPerTradeUsdt` (`accountCapitalUsdt × riskPerTradePct`); a fully-unclamped
  fixture yields fraction=0.
- BTC-move sub-split buckets a trade into `btc_5m_up/down/flat` by entry `btc_5m_move_pct` vs the
  ±1.5% boundary (boundary tests at `+1.5%`, `−1.5%`, `+1.49%`); `btc_5m_flat` correctly holds
  trades with BTC move inside the window.
- `regimeRobustnessPasses` (advisory): false when any bucket with `n ≥ REGIME_BUCKET_MIN_N = 8`
  has a sign flip against the aggregate; true when all qualifying buckets agree; a bucket with
  `n < 8` does not participate in the sign check (no false failure on a 2-trade bucket).
- `regimeRobustnessPasses` is **NOT** included in `slotCGateOpen`: a fixture where count+day floors
  are met but robustness fails still yields `slotCGateOpen = true` (the gate is the two floors only).
- `slotCGateOpen = meetsClosedTradeFloor AND meetsTradingDayFloor`; boundary tests: flips at
  exactly `n = 20` and `distinctTradingDays = 3`.
- Empty range / zero closed trades → all floors false, `slotCGateOpen = false`, no divide-by-zero.
- Decimal math: no float in PnL or R aggregation.

**Unit — `getIdiosyncrasyMissDistribution` (D3):**
- A `no_eligible_slot` row with `idiosyncrasy_score = 0.295` (DOGE-class) buckets into the correct
  miss-distance band (`0.5 − 0.295 = 0.205` → `[0.2,0.3)`); a score of `0.05` (deep beta) lands
  in `[0.4,0.5]` (miss-distance `0.45`), not compressed into a wide top bucket.
- A score of exactly `0.5` (passes the gate — miss-distance = 0) does **not** appear in the
  distribution; the boundary is exclusive at the bottom.
- The active threshold is resolved from `ACTIVE_STRATEGY_VERSION_ID` (version id=3), not from
  `WHERE status='active'` (which is v0): a fixture where the two disagree confirms the query reads
  v2's param value, not v0's.
- Rows that are not `no_eligible_slot` are excluded; per-UTC-day grouping is correct.
- Missing `idiosyncrasy_score` in `market_snapshot` (pre-stamp row) is handled (excluded / counted as
  unknown, not a crash or a 0-score artifact).

**Regression locks:**
- No strategy behaviour beyond D4 changed: `momentumCore`, VWAP stop, `classifyFlowType`,
  `resolveCorrelationMode`, `SlotManager` byte-identical (existing specs green).
- `getFunnelSummary` unchanged (M29 query untouched; the new queries are siblings).
- `idiosyncrasy_min_score`, `MAX_EXPOSURE_PER_COIN_USDT`, depth floor, liquidation buffer, breadth/
  stress thresholds unchanged.
- Full engine + analysis suites green.

**Rough count:** ~48 new tests (D4 noise floor + inertness ~12; `getIdiosyncraticEdgeReport` ~24;
`getIdiosyncrasyMissDistribution` ~12), plus regression-lock assertions. The QA wave should adversarially
attack: divide-by-zero on empty/single-trade ranges and the single-trade `rMultipleStdError = null`
edge (n=1 returns null, not 0); the **reconstructed-risk null exclusion** path (prove a position
missing any of `qty`/`entry_price`/`stop_loss_price` never contaminates expectancy, and that the
LATERAL join resolves the snapshot even when `decisions.position_id` is null);
the D4 inertness claim (fuzz tier-magnitude inputs and assert byte-identical scores; verify no
non-trigger call-site is missed); `regimeRobustnessPasses` NOT appearing in `slotCGateOpen` (a
fixture failing robustness but meeting the two floors must yield `slotCGateOpen = true`); the
`ACTIVE_STRATEGY_VERSION_ID` threshold-resolution path for D3 (prove it reads v2, not v0); and the
miss-distance boundary at score=0.5 (no gate-passer leaks into the distribution).

## Post-deploy checklist

1. **pg_dump before restart** (CLAUDE.md #9): `docker compose exec postgres pg_dump -U trade_bot
   trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`, then prune to the 2 most recent
   (`ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`). **No migration** — restart only, no
   `.env` change.
2. **Stale-halt inspection.** Before reading the funnel, confirm the current UTC day is not sitting on
   a stale halt (per M23/M28 resume rules) that would mask the soak; if halted on a now-stale
   resume-eligible leg and the tape is calm, clear via the evidence-gated `clearHaltForDate`. Do
   **not** clear a loss/multi/invalid lock.
3. **Deploy split — D4 needs a restart, D2/D3 do not.** Only the **D4 noise floor** is engine code and
   requires an **engine restart** to take effect. The **D2/D3 analysis queries** ship with the
   `packages/analysis` build and require **no engine restart** — they can be run via MCP/operator
   script the moment the analysis package is updated, against the live DB. Sequence: (a) build+publish
   the analysis package and confirm `getIdiosyncraticEdgeReport` / `getIdiosyncrasyMissDistribution`
   run read-only against the soak (no restart); (b) restart the engine for the D4 floor.
   Then the **10-min live smoke**: engine boots clean (no module change — the new engine code is one
   pure-function guard), zero errors/warnings, gate evaluates triggers. Confirm `EXCHANGE_ENV=paper`,
   `ACTIVE_STRATEGY_VERSION_ID=3`, the D4 floor active (a debug assertion or a logged score on a known
   trigger is byte-identical to pre-M30).
4. **D4 inertness confirmation.** On the first real trigger after restart, confirm the persisted
   `idiosyncrasy_score` matches the pre-M30 formula (the floor must be inert for real magnitudes) — if
   any real trigger's score changed, the floor is mis-calibrated and must be lowered.
5. **Run the M30 instruments against the live soak.** Execute `getIdiosyncraticEdgeReport` and
   `getIdiosyncrasyMissDistribution` for the soak window. Expected on day 1: `n = 0` or near-zero,
   `slotCGateOpen = false` — **this is correct**; the gate is open only after the floors are met.
   `getIdiosyncrasyMissDistribution` should immediately show whether `no_eligible_slot` rejects cluster
   at large miss-distance (deep beta, correctly filtered — top buckets `[0.3,0.4)` / `[0.4,0.5]`) or
   small miss-distance (marginal — future calibration evidence, bottom buckets `[0,0.1)` / `[0.1,0.2)`).
6. **14-day idiosyncratic-edge soak (the WIP prerequisite, now executable).** As fills accumulate,
   read `getIdiosyncraticEdgeReport` until `slotCGateOpen` resolves. **Do not open the correlated
   slot-C milestone until `slotCGateOpen = true`** (≥20 closed idiosyncratic trades on ≥3 trading
   days). Also review `regimeRobustnessPasses` and the `btc_5m_*` sub-split as advisory context for
   the go/no-go decision — but the hard gate is the two sample-size floors only. A measured **negative** expectancy with the gate open is a valid,
   actionable result (it means "decide," not "build"); zero/sub-floor fills is not. Watch the
   miss-distribution weekly to size the *separate* idiosyncrasy-threshold-calibration decision.

## Success criteria — "M30 done"

> **Code-complete vs deploy-acceptance.** Code-complete M30 is the two queries + the D4 noise floor +
> tests + ADR/tech-debt docs. Deploy-acceptance for the *gate* is **not** "slot C opens" — it is "the
> operator can run a single query and read `slotCGateOpen`," plus the funnel now shows idiosyncrasy
> miss-distance. The slot-C gate is **expected to read `false`** until the soak meets the floors; M30
> is not "failed" because `slotCGateOpen = false` on deploy — that is the correct, conservative
> default and the whole point of having an executable gate instead of a prose assertion.

- `getIdiosyncraticEdgeReport` returns idiosyncratic-only closed-trade expectancy with R-multiples on
  the **fill-anchored reconstructed risk** `qty × |entry_price − stop_loss_price|` (trades missing any
  of the three columns null + excluded), `rMultipleStdError` (`null` when `n < 2`),
  `clampedTradeCount/Fraction` (vs a passed-in `riskPerTradeUsdt`), the two sample-size floors, the
  `btc_5m_up/down/flat` advisory sub-split with per-bucket n and mean R, advisory
  `regimeRobustnessPasses`, and a `slotCGateOpen` boolean (`= meetsClosedTradeFloor AND
  meetsTradingDayFloor`) that is the documented sufficient-sample-to-evaluate gate for any slot-C
  milestone. `slotCGateOpen` means "enough data to decide" — it does not assert positive expectancy.
  No migration, no shared-package change, and the open-decision join uses a LATERAL time-join (not the
  never-stamped `decisions.position_id`).
- `getIdiosyncrasyMissDistribution` surfaces the per-day miss-distance histogram for `no_eligible_slot`,
  with the threshold read from active params (not hard-coded), so the soak can distinguish correctly-
  filtered beta from marginal misses.
- `computeIdiosyncrasyScore` (the **live** function) floors sub-noise coin moves to 0
  (tightening-only); the floor is asserted **inert** for every real tier trigger magnitude
  (byte-identical scores); live determinism preserved. The pre-existing live/backtest formula
  divergence (D4b/F2) is named and logged as tech-debt, **not** fixed in M30; no test falsely asserts
  parity between the live and `BacktestEventBuilder` formulas.
- **No threshold moved, no slot-model change, no DB-param change, no schema migration, no shared-
  package change, no safety floor relaxed, no `.env` change.** The only runtime change is the
  provably-tightening D4 noise floor.
- ADR 0004 §8b added (soak gate definition + fill-anchored reconstruction + LATERAL join +
  `rMultipleStdError` null-at-`n<2` rule + D4 floor + D4b divergence note); tech-debt updated (slot-C
  gate now points at `getIdiosyncraticEdgeReport.slotCGateOpen`; new MEDIUM for idiosyncrasy-threshold
  calibration backed by D3 evidence, starting from the correct 0.5 cut; new MEDIUM for the live/backtest
  idiosyncrasy-scoring divergence; new LOW for stamping `decisions.position_id`).
- All new unit tests green; full engine + analysis suites green; review closes with zero blockers,
  zero highs, majority of mediums resolved.
- 10-min live smoke clean; D4 inertness confirmed on a real trigger; both M30 instruments run against
  the soak; the 14-day gate (`slotCGateOpen`) is in place as the slot-C prerequisite.

## Open Questions / Risks

1. **The soak may take longer than 14 days to reach `n = 20`.** With ~220 reachable M29 rejects still
   in play (`sl_outside_liquidation` 66, `market_stress` 48, `coin_book_too_thin` 46, `no_eligible_slot`
   38), the idiosyncratic fill rate is unknown. **Resolution:** extend the soak window rather than
   lower the floor (quant MEDIUM #2 from M29 — `n=3–5` is noise). M30 makes the floor *executable* so
   "are we there yet?" is a query, not a guess. Risk if ignored: pressure to open slot C on a thin
   sample.
2. **`sl_outside_liquidation` may dominate and starve the idiosyncratic sample.** If it does, the M29
   `getFunnelSummary` sub-cause split (wrong-side / over-levered) is the next milestone's input, not
   M30's — M30 reports, does not fix. Tracked in the existing M29 tech-debt entry.
3. **The D4 noise floor could be mis-set.** If `0.05%` is too high it would floor a real low-tier
   trigger; the inertness test (real-tier byte-identical) and post-deploy step 4 guard this. The floor
   is 16× below the tightest tier-1 trigger, so the margin is large; if a future tier admits sub-0.05%
   triggers, the const must be re-derived (documented in the ADR).
4. **`regimeRobustnessPasses` is advisory and structurally biased toward `btc_5m_flat`.** A 20-trade
   sample split three ways can leave `btc_5m_up/down` buckets with `n=2`. The flag only asserts a
   sign in buckets with `n ≥ REGIME_BUCKET_MIN_N = 8`, and it is **not wired into the hard gate** —
   the operator reads it alongside the sub-split for qualitative context. Idiosyncratic trades fire
   predominantly when BTC is calm, so `btc_5m_flat` will structurally hold the majority; this is
   expected, not a failure. The per-bar labels are not regime classifiers (documented in ADR §8b).
5. **The WIP's idiosyncrasy threshold premise is stale (0.3 vs the real 0.5).** Any future calibration
   milestone must start from 0.5 and D3's measured miss-distribution, not the WIP's numbers. Captured
   in the new tech-debt entry so the next milestone is not built on the stale assumption. (Note: the
   live `computeIdiosyncrasyScore` doc-comment itself still says "`< 0.3` = BTC-correlated" — a stale
   comment; the active cut is the DB param `idiosyncrasy_min_score = 0.5`.)

6. **Wait protocol while `slotCGateOpen = false` (explicit backlog priority).** Until the gate reads
   `true`, the standing order of work is, in priority order: **(1)** if the idiosyncratic fill rate
   stalls, prioritize **`sl_outside_liquidation` forensics** (the M29 tech-debt track) using the
   existing `getFunnelSummary` sub-cause split — it is the most likely cause of a starved sample;
   **(2)** **do NOT lower the idiosyncrasy threshold under sample pressure** — a thin sample is a
   reason to *extend the soak*, never to loosen the gate (D3 gathers evidence; the threshold move is a
   separate, evidence-backed milestone starting from 0.5); **(3)** **do NOT open slot C or any
   correlated-strategy work under any circumstance** before `slotCGateOpen = true` — this is the
   load-bearing D1 lock, and it is not negotiable by impatience. The whole point of the executable gate
   is that "are we allowed yet?" is answered by a query, not by pressure.

7. **Live/backtest idiosyncrasy divergence is named but unfixed (D4b/F2).** M30 deliberately leaves the
   two formulas different. Until the deferred unification milestone, any backtest-vs-live comparison of
   idiosyncrasy-gated behaviour must account for the formula mismatch; do not treat a backtest
   idiosyncrasy score as equivalent to what live would have computed.

## Out of scope (deferred)

- **The differentiated correlated slot-C strategy** — the WIP's real ask (BTC trading regime
  classifier; market-wide directional flow types; trend-following slot-C entry/exit; correlated
  sizing; independent backtest). Deferred behind `getIdiosyncraticEdgeReport.slotCGateOpen = true`
  (D1). Tech-debt MEDIUM unchanged except to point its gate at the new executable instrument.
- **Moving `idiosyncrasy_min_score` (0.5) or any seed strategy param.** A per-version DB-param change
  requiring a seed migration + backtest. D3 gathers the evidence; the change is a separate milestone.
- **Changing the VWAP structural stop / `sl_outside_liquidation` logic** — on the M29 forensics
  tech-debt track; M30 does not pre-empt it.
- **A trading BTC regime classifier or new correlated `FlowTypeEnum` values** — the D2 regime split is
  a *reporting* derivation from a persisted snapshot field and emits no signal; the WIP's trading
  classifier is deferred with slot C.
- **A persisted/materialized edge table, an HTTP endpoint, or a dashboard widget** — M30's instruments
  are derived read-only `packages/analysis` queries (any future endpoint delegates to them), per M29 D3.
- **Re-calibrating `COIN_DEPTH_FLOOR_10BPS_USDT`, `MAX_EXPOSURE_PER_COIN_USDT`, `MAX_LEVERAGE`, or
  `RISK_PER_TRADE_PCT`** — all on their own evidence-gated tracks; M30 relaxes no survival lever.
- **Unifying the live/backtest idiosyncrasy-scoring formulas (D4b/F2).** Live
  (`computeIdiosyncrasyScore`) and backtest (`BacktestEventBuilder`'s private formula) compute
  idiosyncrasy differently today. M30 hardens only the live path and **names** the divergence; deleting
  the private backtest formula and unifying on the live function (with a parity test + backtest
  re-baseline) is deferred to a separate milestone (MEDIUM tech-debt).
- **Stamping `decisions.position_id` on successful open fill (F3).** The column exists but is never
  written, which is why D2 uses a LATERAL time-join. Stamping it is a small engine change deferred to a
  later milestone (LOW tech-debt); D2 does not depend on it.
- **Adding a persisted `effective_risk_usdt` column (F1).** `effectiveRiskUsdt` is engine-internal and
  unpersisted; D2 reconstructs the denominator from fill-anchored columns instead. Persisting it would
  be a migration — out of M30's minimum-touch scope.
- **The separate BTC-only bot** the WIP raised — same gate as the correlated leg; premature until the
  idiosyncratic edge is measured.
