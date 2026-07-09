# ADR 0047 — Portfolio-strategy contract (`IPortfolioStrategy`)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Milestone:** M50 (D1)
- **Composes with:** ADR 0003 (single-symbol `IStrategy`, purity/determinism rule),
  ADR 0016 (strategy-version lineage), ADR 0004 (risk gate — unchanged), ADR 0042
  (paper exploration profile), ADR 0029 (shadow pipeline). Companion: ADR 0048
  (rebalance orchestrator — the impure outer loop that drives this pure core).
- **Amended by:** [ADR 0050](0050-xmom-cascade-topn-rebalance-anchor.md) §2.1 / §2.5 (M50b) —
  `selected` → `ranked` (full list); core no longer slices to `top_n`; `top_n` is orchestrator-only.
  [§6 M53 amendment](#6-m53-amendment-2026-07-04--decoupled-tp-arm-ratio) — new `xmom_tp_arm_rr`
  param decouples the take-profit arm from the fill-acceptance guard floor (no-op at 1.5).
  [§7 M54 amendment](#7-m54-amendment-2026-07-09--expected-fill-anchor--thin-book-skip) — new
  `xmom_expected_fill_enabled` + `xmom_max_depth_fraction` params arm SL/TP off the expected fill
  price instead of the signal price, plus a pre-send thin-book skip (both no-op at defaults).

> **ADR numbering note.** The next free number after `0046` is **0047**; this ADR uses it.

---

## 1. Context

Every strategy to date (v0–v3) implements `IStrategy` (ADR 0003): a **single-symbol**
contract — `evaluate(input) → ISignal` for one symbol's market state at one bar. The VWAP
detector fires per symbol; `StrategyService` runs the active `IStrategy` against that one
symbol's snapshot.

Cross-sectional momentum (EXP-011/012) is a fundamentally different shape: its decision is
**relative across a universe**. "Buy the strongest of the last 24h" cannot be expressed as a
per-symbol `evaluate` — the answer for `ETHUSDT` depends on every other symbol's trailing
return. It needs a contract that takes the **whole universe** in and returns a **ranked
selection** out.

The constraint that does *not* change: the ranking logic must remain **pure and
deterministic** so the same code ranks identically in paper, shadow, and a future backtest
replay (the ADR 0003 §1 invariant, restated for the portfolio shape). All clock, I/O, and
universe-snapshot acquisition stay **outside** the core (ADR 0048).

EXP-012 is positive post-cost on only **one up-regime** with `t < 2`; live promotion is
gated on a down-regime soak. M50 is therefore **paper + shadow only — no live capital**.

---

## 2. Decision

### 2.1 `IPortfolioStrategy` — a new, separate extension point (OCP)

> **ADR 0050 amendment (M50b).** `IPortfolioSelection.selected` is renamed `ranked` and returns
> the **full** eligible universe (dense rank 1..M). The core ranks only; `top_n` is consumed by
> the orchestrator cascade (ADR 0048 §2.4, amended). Code is authoritative over this snippet.

A new interface, **distinct from and not extending `IStrategy`**. It operates over a
universe snapshot and returns a ranked, sized-by-rank selection of symbols:

```
interface IPortfolioStrategy {
  readonly name: string;            // matches strategy_versions.name
  readonly version: number;         // matches strategy_versions.version
  readonly direction: StrategyDirectionEnum;   // 'momentum' for xmom
  selectUniverse(input: IPortfolioStrategyInput): IPortfolioSelection;
}

interface IPortfolioStrategyInput {
  readonly universe: ReadonlyArray<UniverseEntry>;  // trailing-return-bearing snapshot
  readonly params: IMomentumParams;                 // validated by momentumParamsSchema
  readonly nowMs: number;                           // injected; core never reads a clock
}

interface IPortfolioSelection {
  readonly selected: ReadonlyArray<ISelectedSymbol>;  // ranked best-first, length ≤ topN
  readonly reason: PortfolioSelectionReasonEnum;       // ranked | universe_too_small | no_eligible_symbols
}

interface ISelectedSymbol {
  readonly symbol: string;
  readonly rank: number;            // 1 = strongest; deterministic, dense
  readonly trailingReturnPct: number;  // the ranking key (the value it was chosen on)
}
```

**Purity/determinism (the hard rule, restated for the portfolio shape).** `selectUniverse`
MUST be a pure function of `(universe, params, nowMs)`: no I/O, no logging, no DB, no
exchange calls, no `Date.now()`, no `Math.random()`, no mutation of inputs. `skip` for the
whole universe is expressed as `selected: []` with a `reason` — selection ALWAYS returns an
`IPortfolioSelection`, never throws for the empty case. Persistence/logging is the
orchestrator's job (ADR 0048). `nowMs` is passed in so the function stays reproducible.

`UniverseEntry` is the **M50 ranking-input type** and is intentionally *distinct* from
market-data's existing engine-internal `IUniverseEntry` (membership/tier/volume only — it
carries no return). The orchestrator (ADR 0048) builds `UniverseEntry[]` by joining
membership with a per-symbol trailing return. Minimum fields the core reads:
`{ symbol, trailingReturnPct, tier }` — see ADR 0048 §5 for how it is sourced and the
NaN/undefined exclusion guard.

### 2.2 `IPortfolioStrategyVersion` — versioning wrapper, analogous to the VWAP path

Portfolio strategies are versioned and selected by the **same lineage model** as `IStrategy`
(ADR 0016): a registry, a `strategy_versions` row, and an env-selected active id — but on a
**separate selection axis** so the two paths never collide:

```
interface IPortfolioStrategyVersion {
  readonly versionId: number;       // strategy_versions.id (numeric, like the VWAP path)
  readonly name: string;            // e.g. 'xmom'
  readonly strategy: IPortfolioStrategy;
}
```

- **Env selector:** `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` (numeric), the portfolio analogue
  of the existing `ACTIVE_STRATEGY_VERSION_ID`. Unset/absent ⇒ the portfolio path is dormant
  (no scheduler, no orchestrator activity); the VWAP path is wholly unaffected.
- **Persistence reuse:** a portfolio version is an ordinary `strategy_versions` row
  (`direction = 'momentum'`, `params` = the momentum params). No new versions table, no
  migration. Its positions/decisions carry that `strategy_version_id` (ADR 0048 §7).

### 2.3 OCP constraint — `IStrategy` and the VWAP path are untouched

`IPortfolioStrategy` does **not** extend, wrap, replace, or modify `IStrategy`,
`StrategyService`, `IStrategyInput`, `ISignal`, or any v0–v3 implementation. It is a parallel
extension point added by **new code**, not by editing existing code (open for extension,
closed for modification). The VWAP detector → `StrategyService` → risk-gate flow is
byte-identical to pre-M50. A reader scanning v0–v3 sees nothing new.

### 2.4 Slot sharing in M50 — explicit: shared A/B/C pool now, disjoint namespace is M50b

In M50 the momentum path **shares the global A/B/C slot pool** with the VWAP path. The
single-slot long-only proxy (`topN = 1`) is one position and fits the existing architectural
3-slot model (ADR 0004) **with no cap change**. The consequence is explicit and accepted:
**a momentum rebalance can gate-reject with `max_positions_reached` when VWAP holds all
slots** — momentum has no reserved capacity in M50. This is a known, logged outcome, not a
bug.

A **disjoint slot namespace** (a per-strategy position + notional cap so momentum and VWAP do
not starve each other) and the **N-long basket** (`topN > 1`) are deferred to **M50b**. M50
ships the single-slot proxy only.

### 2.5 `momentumParamsSchema` — separate Zod schema, deliberately NOT `.strict()`

A **new, separate** Zod schema in `packages/shared/`, independent of the VWAP
`strategyParamsSchema`. The two never share a key namespace. Unlike the VWAP schema (which is
`.strict()` and rejects unknown keys), `momentumParamsSchema` is **not `.strict()` for now**:
the momentum param set is expected to grow through M50/M50b (basket sizing, vol-scaling,
skip-recent-bar lookback), and a non-strict schema lets a forward param land without a
lockstep shared-package bump. It will be tightened to `.strict()` once the param set settles
(tracked as M50b follow-up).

Initial params (snake_case, persisted in `strategy_versions.params`):

| Param | Type / bound | Default | Meaning |
|-------|--------------|---------|---------|
| `top_n` | int ≥ 1 | **1** | Number of strongest symbols to hold (M50: 1 only) |
| `lookback_ms` | int ≥ 1 | **86_400_000** (24h) | Trailing-return window the ranking is computed over |
| `rebalance_interval_ms` | int ≥ 1 | **86_400_000** (24h) | Re-rank cadence; drives the scheduler (ADR 0048 §1) |
| `min_universe_size` | int ≥ 1 | (e.g. 20) | Minimum eligible symbols required to rank; below ⇒ empty selection |

Money/notional sizing is **not** a momentum param — it stays operator-level in the risk gate
/ `PositionSizer` (ADR 0004 §8), exactly as for VWAP. The momentum schema governs **ranking
shape only**.

### 2.6 Paper + shadow only in M50 — env-gated, hard fail-closed on any other env

`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` **only activates the momentum path when
`EXCHANGE_ENV = paper`** (the existing `ExchangeEnvironmentEnum.PAPER`). On boot:

- `EXCHANGE_ENV = paper` **and** the env var set ⇒ portfolio path active (paper fills +
  shadow record).
- Any other `EXCHANGE_ENV` (`live`, `testnet`) with the env var set ⇒ **log a WARN and skip**
  — the scheduler and orchestrator do not register/emit. No live or testnet capital can ever
  reach the momentum path in M50. This mirrors the two-condition paper gate used by ADR 0042
  (`paperRelaxMarketStress`) and ADR 0036, so a non-paper boot is byte-identical to pre-M50.

This is a **code-enforced** boot gate, not a config convention.

---

## 3. Invariants this ADR defends

- **Same code, every mode.** `selectUniverse` is pure and deterministic — identical ranking
  in paper, shadow, and future backtest. No wall-clock, no RNG, no I/O in the core.
- **The risk gate is not bypassed.** This ADR defines selection only; *every* selected leg
  routes through the unchanged ADR 0004 risk gate → `PositionSizer` → execution (enforced in
  ADR 0048 §3). `IPortfolioStrategy` cannot place an order.
- **No LLM in the loop.** The momentum core is deterministic ranking math; no model call.
- **Money is `decimal`.** The core ranks on `trailingReturnPct` (a ratio scalar, not money);
  all sizing/notional/PnL downstream stays `decimal.js` in the unchanged risk/execution path.
- **VWAP untouched.** v0–v3 and `StrategyService` are not modified (§2.3).
- **No live capital in M50.** Hard paper-only boot gate (§2.6).

---

## 4. Consequences

- A second strategy *shape* exists alongside the per-symbol shape, with its own registry,
  active-version env, and Zod schema — no change to `IStrategy` or any v0–v3 code.
- `strategy_versions` is reused as-is for portfolio versions (no migration); positions and
  decisions distinguish momentum by `strategy_version_id`.
- The shared A/B/C slot pool means momentum can lose to VWAP for a slot in M50 (§2.4) — an
  accepted, logged outcome until M50b adds a disjoint namespace.
- `momentumParamsSchema` being non-strict trades a little boot-time validation tightness for
  param-evolution velocity during the experimental phase; tightened in M50b.
- Determinism is preserved end-to-end, so an M50 momentum version can later be backtested
  through the same `selectUniverse` for the down-regime promotion gate.

---

## 5. Alternatives considered

- **Extend `IStrategy` with an optional `selectUniverse`.** Rejected. Pollutes the
  single-symbol contract every v0–v3 impl satisfies, forces a no-op on each, and violates
  OCP/ISP — a per-symbol strategy has no business carrying a universe method. A separate
  interface keeps each contract cohesive (one reason to change).
- **Express momentum as a per-symbol `IStrategy` that reads peers from a shared cache.**
  Rejected. Breaks purity (the "snapshot" would be impure ambient state), makes the decision
  order-dependent and non-reproducible, and smuggles cross-sectional state into a contract
  whose whole premise is single-symbol isolation.
- **Make `momentumParamsSchema` `.strict()` immediately like the VWAP schema.** Rejected for
  M50 only. The param set is still moving (basket sizing, vol-scaling in M50b); strict mode
  would force a shared-package bump per param. Revisited (and adopted) once the set settles.
- **Give momentum its own slot pool now (disjoint namespace in M50).** Rejected as scope.
  The `topN = 1` proxy fits the existing 3-slot model with zero cap change; building a
  per-strategy capacity model is real work with its own review surface — deferred to M50b so
  M50 proves the ranking edge first, survival-first.
- **Run momentum live at minimal size immediately.** Rejected. EXP-012 is post-cost positive
  on a single up-regime with `t < 2`; the locked policy (00-overview) is no live capital
  without out-of-sample/down-regime evidence. Paper + shadow only.

---

## 6. M53 amendment (2026-07-04) — decoupled TP-arm ratio

**Milestone:** M53 (D1). **Status:** Accepted. **Source analysis:**
`docs/analysis/20260704-m52-force-close-retry-soak-analysis.md` (EXP-018).

### 6.1 Context — one param drove two independent seams

Before M53 the single `xmom_min_rr` field (default `1.5`) was read in **two unrelated places**
inside `MomentumOrchestratorService`:

- **The take-profit arm** (`:618`): `takeProfitPrice = entryPrice + stopDistance × xmom_min_rr`,
  frozen at the signal (`tpRebaseEligible = false`).
- **The fill-acceptance guard floor** (`:857` → `gateStrategyParams.min_rr` →
  `geometryParams.min_rr` on the OPEN approval → `exitGeometryHelper.isRrInsufficient`, ADR 0045).

Because the arm was placed at *exactly* the reject floor, ordinary adverse entry slippage on a
long tipped realized R:R below `1.5` and the ADR 0045 guard force-closed the fill at 0-duration
(EXP-018 §2). Raising `xmom_min_rr` alone cannot fix this — it moves the arm **and** the floor
together and buys zero slack (all four EXP-018 reviews converge on this).

### 6.2 Decision — add `xmom_tp_arm_rr`, drive the arm only

A **second** momentum param, `xmom_tp_arm_rr` (`z.number().positive().default(1.5)`), is added to
`momentumParamsSchema` and read **only at the arm site**. `xmom_min_rr` stays the guard floor,
untouched. At `xmom_tp_arm_rr = xmom_min_rr = 1.5` the arithmetic is byte-identical to pre-M53 — a
**no-op on the active version** (`id=20`, `params={}` parses `xmom_tp_arm_rr = 1.5` via the
non-strict schema, §2.5, so no data change is needed). Any wider arm (1.8 / 2.0 / …) lives **only**
on `status='shadow'` cohort rows; no wider ratio touches the active version in M53.

| Param | Type / bound | Default | Meaning |
|-------|--------------|---------|---------|
| `xmom_tp_arm_rr` | number > 0 | **1.5** | Signal-time take-profit arm ratio (`TP = entry + stopDistance × xmom_tp_arm_rr`). Decoupled from the guard floor; 1.5 = no-op. |
| `xmom_min_rr` | number > 0 | **1.5** | Fill-acceptance **guard floor** only (ADR 0045). Not the arm. Not raised in M53. |

**Invariants preserved.** The wider arm produces a *wider* TP that still clears the unchanged
`min_rr` floor (ADR 0045 pre-fill guarantee intact — the guard is consumed byte-for-byte, not
modified); the new field is plain versioned data read inside the pure sizing/geometry path (no
clock/RNG/I/O added — determinism/backtest-parity intact); money stays `decimal`; no live capital
(active version stays at the 1.5 no-op). **Side symmetry (forward note):** the xmom arm is
hardcoded LONG; when a SHORT xmom path is ever added, `xmom_tp_arm_rr` must apply symmetrically
(`entryPrice − stopDistance × xmom_tp_arm_rr`) so the arm and guard seams never diverge by side.

### 6.3 Measurement scaffold (D2/D3) — DEFERRED to a follow-up milestone

M53's brief assumed the multi-ratio shadow cohort was "free plumbing" over the existing
`ShadowStrategyOrchestratorService`. **Code verification refutes that premise** (see §6.4). Per the
plan's scope guard, D2 (shadow cohort) and D3 (per-cohort instrumentation) are **deferred**; M53
ships **D1 (this param) + D4 (archive retired VWAP shadow rows)** only — both independently
valuable and low-risk. The wider-ratio *value* is unproven (EXP-018 real-price replay, n=31: noisy,
non-monotonic PnL, TP:SL mix degrades 0.71 → 0.44 as the arm widens) and was always a future,
soak-gated decision (§Non-goals). See ADR 0029 for where the deferred portfolio-shadow mechanism
would land.

### 6.4 Why the existing shadow path does NOT cover xmom (verified)

- `ShadowStrategyOrchestratorService.runShadows` is invoked **only** by
  `StrategyService.onVolatilityDetected` — the single-symbol VWAP trigger path — and evaluates each
  cohort through the per-symbol `IStrategy.evaluate(...)` API. xmom is a **portfolio** strategy
  (`XMomPortfolioStrategy` on `UNIVERSE_REBALANCE_DUE_EVENT`, ADR 0048/0050) and never flows through it.
- `StrategyRegistry` registers only `volatility-vwap` v0–v3 (and aliased rows 11/21/31/32) — there
  is **no `xmom` entry**. A `name='xmom' status='shadow'` row would throw `StrategyConfigException`
  in `resolveShadow`, be caught and skipped, and **never evaluated**. `findActiveShadows()`
  returning it does not mean the momentum path evaluates it.
- The VWAP path is **dormant** during xmom operation (`ACTIVE_STRATEGY_VERSION_ID` unset, ADR 0049
  — it must be, else boot would `registry.resolve('xmom', …)` → throw). While dormant,
  `onVolatilityDetected` returns early, so `runShadows` is **never called at all** — the per-tick
  shadow fan-out is switched off, not merely single-symbol.

An honest post-fill counterfactual for xmom therefore requires a **new portfolio-shadow mechanism**
(rebalance-cascade fan-out at the `MomentumOrchestratorService` intent-build seam, recording per-cohort
to `shadow_decisions`/`simulated_fill` with a hard "shadow intent never reaches `emitApproval`/executor/
gate" containment invariant). That is a genuinely new mechanism (its own ADR 0029 section or a new ADR),
gated on proving realistic entry-slippage fill fidelity and a 1.5-baseline calibration — out of scope
for M53. See ADR 0029 for the deferral record.

---

## 7. M54 amendment (2026-07-09) — expected-fill anchor + thin-book skip

**Milestone:** M54 (D1–D5, shipped). **Status:** Accepted, **default-off** (no-op on the active
version, `id=20`, `params={}`). **Source analysis:**
`docs/analysis/20260708-xmom-geometry-and-live-forensics-exp022.md` (EXP-022 §3 "Force_close root
cause proven", §7 "Still-valid SEPARATE action") and
`docs/analysis/20260704-m52-force-close-retry-soak-analysis.md` (EXP-018 §2, seed #3).

### 7.1 Context — the arm anchors to the signal, the guard measures the fill

xmom arms every long's SL/TP off the signal price `P0 = latestBar.close`
(`MomentumOrchestratorService.ts`), frozen at signal time (ADR 0045 M47 Option B, no rebase). The
ADR 0045 fill-acceptance guard (`evaluateFillGeometry` / `isRrInsufficient`) then measures realized
R:R against the **actual fill** `F`, not `P0`. On thin books a long systematically fills *above*
signal (adverse), so realized R:R is systematically biased **below** the arm ratio and the guard
`force_close`s the fill at 0-duration (EXP-022 §3: force_close set averaged R:R-at-fill 1.03, all
≤ the 1.5 guard floor; traded set 1.96; scheduled force_close rate 67%, 14/21). This is an
**open-time anchor mismatch**, not a guard bug — the guard is correct and protective (EXP-022 §4:
the force-closed positions would have lost *more* if held). M54 fixes the anchor, not the guard.

**Scope framing (load-bearing — do not overstate).** EXP-021 (fragile peak, 1/10 walk-forward
folds) and EXP-022 (all 22 exit-geometry variants net-negative; the binding constraint is the
*signal*, not exit mechanics) already proved xmom has no cost-surviving edge and that widening exit
geometry does not create one. M54 is **correctness / fee-bleed reduction, NOT an edge fix.** Success
is measured as force_close-rate and fee/slot-churn reduction — never PnL improvement.

### 7.2 Decision — two new params, both no-op at their defaults

| Param | Type / bound | Default | Meaning |
|-------|--------------|---------|---------|
| `xmom_expected_fill_enabled` | boolean | **false** | **Anchor** toggle only. `false` ⇒ arm off `P0` exactly as today (byte-identical). |
| `xmom_max_depth_fraction` | number > 0 (finite) or `null` | **`null`** ⇒ skip disabled | **Skip** budget: skip the candidate pre-send when `orderNotional / book_depth_10bps_usdt` exceeds it. |

A Zod `.superRefine` on `momentumParamsSchema` **rejects the parse** when
`xmom_expected_fill_enabled === true` and `xmom_max_depth_fraction` is `null`/undefined/non-finite —
it is structurally impossible to enable the anchor without a live skip budget. This closes the
EXP-022 §4 bootstrap trap: anchor-only (no skip) would convert near-floor fee-only rejects into
full-size positions, and EXP-022 §4 proved the force-closed cohort would have lost more if held.
**The skip is the primary fee-bleed/safety lever; the anchor is the correctness/honest-measurement
lever** — they ship together by construction, never anchor-without-skip.

Both params default to a byte-identical no-op on the active version (`id=20`, `params={}`),
consistent with the M51/M52/M53 default-off-paper-soak discipline.

### 7.3 The anchor — half-spread offset, notional-independent

For a long: `F_exp = P0 × (1 + halfSpreadPct/100)`, `halfSpreadPct = bid_ask_spread_pct / 2` (the
guaranteed-adverse minimum a taker IOC crosses to fill). `stopLossPrice = F_exp − D`,
`takeProfitPrice = F_exp + a·D` (`D` = stop distance, `a` = `xmom_tp_arm_rr`, ADR 0047 §6). The
sizer receives `entryPrice = F_exp`, `stopLossPrice = F_exp − D` ⇒ `stopDistance = D` is unchanged,
so sized notional is unaffected by the anchor move. **`referencePrice`, `midAtTrigger`, and the
recorded signal anchor stay `P0`** — they are NOT moved, protecting the M48 `slFloor` threshold
anchor and the M52/ADR 0051 `atrUnitsDrift` retry breaker (both key on `referencePrice = P0`;
neither needed recalibration).

**Why half-spread, not the backtest's flat-%-of-notional slippage model:** EXP-008 proved the
backtest `slippageCostUsdt` encodes order *size*, not price velocity — not reusable here. The
half-spread is the real, already-captured microstructure cost and is the defensible first model.
It is a **lower-bound** estimator (EXP-022's realized adverse slippage implies ~0.23·D typical
adverse move vs ~0.05·D modeled by half-spread alone), so a residual positive bias is expected and
is the D3/EXP-025 calibration input, not evidence the anchor is wrong. A depth-scaled impact term
is a possible future refinement, out of scope for M54.

**Cold-boot behavior.** `getSpreadPct()` returning `null`/`≤0` (no reading) makes `halfSpread = 0`
⇒ `F_exp = P0` — the anchor degrades to a byte-identical no-op; this is safe because it is not a
fill-admission decision.

### 7.4 The skip — order-size-aware thin-book budget, fail-closed

Pre-send, after sizing: `depthFraction = orderNotional / book_depth_10bps_usdt`; skip (return `null`
from `buildMomentumOpenIntent`, logged like the existing null-skips) when
`depthFraction > xmom_max_depth_fraction`. This is EXP-018 seed #3 ("pre-fill R:R gate with a
slippage budget"). It is the lever that actually stops fee bleed: a doomed thin-book candidate is
never sent, instead of open → 0-duration force_close → M52 retry churn.

**Fail-closed on bad/missing depth**, matching the in-gate `isBookTooThin` convention
(ADR 0004 §6a): `book_depth_10bps_usdt = null` (no reading) or finite `≤ 0` ⇒ **skip**. A genuinely
empty book is the worst adverse-slippage case; admitting it would be exactly wrong. Because
`isBookTooThin` already fails-closed on the same `null`/`≤0` readings, M54's skip never removes
opens the soak would otherwise get — it only moves the rejection earlier and cheaper (§7.6 records
the two-layer reconciliation).

### 7.5 Wiring — arm site + M52 retry rebuild, log-only observability

Both legs wire into `MomentumOrchestratorService.buildMomentumOpenIntent` via a private
`resolveExpectedFillPrice` (the anchor) and `isDepthBudgetExceeded` (the skip), reading
`SymbolMarketState.getSpreadPct()` / `getBookDepth10bpsUsdt()` — already in scope at the arm site,
no new data source. Both operations are deterministic functions of the already-captured market
snapshot: no new clock/RNG/I-O. The M52 retry rebuild (ADR 0051 §3.5) constructs a fresh open intent
via the **same** `buildMomentumOpenIntent`, so it inherits the anchor and skip automatically — a
thin-book retry that would just re-`force_close` is now skipped instead of re-opened-and-churned.

Log-only observability (`MOMENTUM_EXPECTED_FILL_ANCHOR`, `MOMENTUM_DEPTH_SKIP`, mirroring the M48
`GEOMETRY_ANCHOR_DRIFT` log-only pattern — never gates) records expected slippage, the fill residual,
and `depthFraction` per open so a future soak calibrates `xmom_max_depth_fraction` from measured
data instead of a guess.

### 7.6 Interaction with existing mechanisms (all unchanged, referenced not amended)

- **ADR 0045 (fill-acceptance guard)** — consumed byte-for-byte; see ADR 0045's M54 reference note.
- **ADR 0051 (M52 force_close retry)** — the retry rebuild inherits the anchor + skip via the shared
  builder; see ADR 0051's M54 reference note.
- **ADR 0004 §6a (`isBookTooThin` per-coin depth eligibility)** — the skip is a second, pre-gate,
  order-size-aware layer sitting above the unchanged in-gate static tier-floor guard, adopting its
  fail-closed convention; see ADR 0004 §6a's M54 reference note.
- **ADR 0047 §6 (`xmom_tp_arm_rr`, M53)** — orthogonal lever (ratio, not anchor); unchanged, stays
  at its 1.5 no-op default. M54 changes the anchor point (`P0 → F_exp`) both `xmom_min_rr` (guard
  floor) and `xmom_tp_arm_rr` (arm ratio) already compute from.

### 7.7 Invariants preserved

No order path bypasses the risk gate (the skip emits no intent at all — strictly safer; armed
geometry still flows through the unchanged gate and unchanged ADR 0045 guard); strategies stay
pure/deterministic (same-snapshot ⇒ same `F_exp`/skip decision, no new nondeterministic input);
money stays `decimal`; no live capital (xmom stays PAPER-only, keeps its HIGH go-live blockers;
ships default-off).
