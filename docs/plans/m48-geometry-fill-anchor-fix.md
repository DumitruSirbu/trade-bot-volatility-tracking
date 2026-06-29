# M48 — Fill-anchor geometry fix (momentum geometry collapses when the live fill diverges from the reconstructed reference)

**Status:** see `docs/plans/README.md` (status lives there, not in this frontmatter).
**Scope:** Live geometry-integrity fix. M47 froze SL/TP at signal time and added a signal-anchored R:R gate (`isRewardRiskTooLow`), but **every M47 geometry check measures distance against the *reconstructed* signal reference (`reconstructReferencePrice`), never against the actual fill price.** When the live fill diverges materially from that reconstruction (1.53% on live position 212), the realized SL distance collapses to a fraction of what the gate approved (34.5× smaller on 212 → 85:1 R:R at fill), and inverted geometry ships. M48 adds **one new fill-time leg to the existing `evaluateFillDrift` execution helper** (`exitGeometryHelper.ts:39`, ADR 0045 §D2 — the seam that already receives `clampedExit`, `avgFillPrice`, `side`, `entrySnapshot` and already runs the wrong-side-of-SL check). The new leg: (1) asserts side-correct SL/fill/TP ordering, (2) checks `slDist_fill ≥ slFloor` (noise floor, reusing the M47 formula), (3) checks `tpDist_fill / slDist_fill ≥ min_rr`, all anchored to the **fill price** (a local variable at the seam). On any failure it rejects via the existing `FILL_ACCEPTANCE_REJECTED` execution-metric path and routes through the existing synthetic-FLATTEN unwind (`fillAcceptanceUnwind.emitSyntheticClose`). **No change to the frozen SL/TP price levels** (Option B / `tpRebaseEligible: false` preserved), **no change to any pure strategy core**, **no change to `entryHelpers.ts`**, **no new `RiskGateService` check**, **no change to the shadow simulator** (Task 3 dropped — see B3). Live-only; backtest and shadow paths are inert (their fills ≈ the reconstructed reference, so the new leg never trips — asserted by a parity test). Money is `decimal`, never float.
**Owner modules:** ExecutionModule (`exitGeometryHelper.ts` — the new `evaluateFillDrift` leg; `ExecutionService.ts` — the existing call seam + ATR-unit drift log).
**Related:** M47 (froze SL/TP at signal time, added the *signal-anchored* `isRewardRiskTooLow` — M48 adds the *fill-anchored* sibling at the execution seam), M38/ADR 0045 (the `evaluateFillDrift` + synthetic-FLATTEN-unwind machinery M48 extends; Option B no-rebase invariant M48 must not break), M35 (trade-record integrity).
**ADRs touched:** 0045 (fill-acceptance seam — adds a geometry-integrity leg to `evaluateFillDrift` alongside the existing wrong-side/drift legs, without re-enabling rebase; new `FILL_ACCEPTANCE_REJECTED` sub-reason const `DEGENERATE_GEOMETRY_AT_FILL`; adds a `geometryParams` field to the engine-internal `IOrderIntentApprovedEvent` so the M47 versioned params reach the fill seam with zero hot-path DB round-trip — Amendment 1A). ADR 0003 and 0004 are **referenced but not amended** — no strategy core changes, no new gate check (the fill-time backstop lives in the execution helper, not `RiskGateService`). Architect re-blesses the 0045 amendment before the implementation wave.

---

## 1 — Root cause summary

M47 closed Bug 1 (uncoupled SL/TP) and Bug 2 (single-leg fill rebase) by **freezing** both legs at signal time (Option B, `tpRebaseEligible: false`, `momentumCore.ts:83` sets `stopLossPrice = event.vwapSession`) and validating R:R against `intent.referencePrice = reconstructReferencePrice(event) = vwapSession × (1 + deviationPct/100)`. In backtest this is sound because the simulated fill (`nextBarOpen`) is approximately the reconstructed reference. **In live trading the actual fill can diverge from that reconstruction by more than the entire intended stop distance**, and every M47 geometry check inherits the error. Two compounding defects:

### Defect 1 — No fill-time geometry re-evaluation

Every M47 geometry check (the strategy-layer momentum degeneracy check and the gate's `isRewardRiskTooLow`) validates against the **reconstructed reference**, never the **actual fill**. When the fill diverges, collapsed or inverted geometry ships unchecked. There is no fill-anchored re-validation anywhere on the open path. (Note: the existing `evaluateFillDrift` *does* run at fill time and *does* check wrong-side-of-SL — but it has **no R:R / noise-floor leg**, so a fill that lands the right side of the SL but only a hair away from it passes today.)

### Defect 2 — `reconstructReferencePrice` is an unreliable geometry anchor

`entryHelpers.ts:42–47` rebuilds the reference from `vwapSession × (1 + vwapDeviationPct/100)` — a signal-bar approximation. On live position 212 it missed the actual fill by **1.53%**, larger than the entire intended stop distance. The fix is **not** to change `reconstructReferencePrice` (it is called inside pure cores at signal time, where no fill exists — changing it breaks determinism/parity). The fix is to **anchor the new fill-time leg to the fill price**, which is the truth available at the execution seam.

### Live evidence (source of truth for M48 scope)

**Position 212 (live SHORT, HYPE/USDT):**
- Reconstructed reference: `62.294`; actual fill: `63.250` → divergence **1.53%**.
- `slDist` the gate saw (signal-anchored): `|62.294 − 63.278| = 0.984`.
- `slDist` at fill (real): `|63.250 − 63.278| = 0.0285` → **34.5× smaller** (`0.984 / 0.0285 ≈ 34.5`).
- R:R at fill: **85:1** (the gate approved ≈ 1.5:1). The SL sits 0.0285 from the fill — a hair-trigger stop the gate never saw.

**Position 211 (live LONG):** R:R at fill `0.74` (the opposite inversion — TP closer than SL).
**Position 210:** R:R `2.03` (a *good* trade — clears `min_rr = 1.5` at fill; M48 must let this one pass).

**Shadow pre-fill inversions:** `shadow_decisions` rows show inverted geometry *before any fill* (XAG short: SL below TP; SLX long: SL above TP), meaning `reconstructReferencePrice` can produce inverted geometry at the formula level. M47's *signal-time* `isRewardRiskTooLow` is the check for those pre-fill cases (it stays); M48 adds the *fill-time* check for the divergence cases.

> **Shadow `simulated_fill.entryPrice` is NOT a defect (Task 3 dropped — reviewer B3).** `ShadowStrategyOrchestratorService.buildFilledShadowFill` (line 668) already writes the real `entryPrice.toFixed()` for filled rows. The `0.000000` rows are `buildMissedShadowFill` (line 1050) — genuinely missed/never-filled opens, correctly zero by `missed=true` semantics, and `compareVersions.ts:114-115` already filters them. There is no shadow bug to fix here; the quant's fill-relative R:R must read filled rows (`missed=false`) and exclude misses. If a `0` is ever observed on a known-`missed=false` row, that is a *separate* serialization/persistence investigation, not M48 scope.

---

## 2 — Locked decisions / invariants (what M48 MUST preserve)

M48 adds one fill-time validation leg. It must not break any of the following:

1. **No fill-time TP rebase in the general case** (ADR 0045 M47 amendment D1.A, `tpRebaseEligible: false`). M48 must **not** move the frozen TP or SL *price levels*. It adds a fill-time *validation* that can **reject** a degenerate fill, never one that mutates geometry. The fill is used only as the *measurement anchor* for the new leg's distances (a local variable) — the SL/TP prices on the position are unchanged.
2. **No uncoupled SL/TP anchors** (ADR 0003 M47 amendment A1). M48 does not re-derive SL or TP independently.
3. **Live/backtest/shadow parity** (ADR 0003 §1, Invariant 7; ADR 0045 §D2.8 — `evaluateFillDrift` is live-only). The new leg lives in `evaluateFillDrift`, which is **already not invoked in backtest** (`BacktestOrchestrator` runs only the D1 rebase, not D2 — confirmed `BacktestOrchestrator.m38.spec.ts:484`). It is likewise inert in the shadow path (shadow has no exchange fill). Backtest fill ≈ reconstructed reference, so even if a future change invoked the leg there, it would not trip — asserted by the parity test (M2).
4. **The risk gate is the single authority that approves/rejects; strategies never bypass it** (ADR 0004, ADR 0003 §3). The new leg is execution-layer fill-acceptance (post-gate, post-fill), the same authority boundary as the existing `evaluateFillDrift` wrong-side check — it does not relocate the pre-fill gate. The synthetic-FLATTEN unwind routes through the existing gate-mediated close path.
5. **Money is `decimal`, never float** (the whole helper is `Money`/decimal.js — match the existing `evaluateFillDrift` style; no float intermediate).
6. **The momentum VWAP stop is the thesis-invalidation level and is never tightened** (ADR 0003 M47 amendment A1). M48 does not move the SL to "fix" R:R — when fill-time geometry is degenerate it **rejects the fill** (treats it as unacceptable), it does not re-shape the stop.
7. **`atrDistance` remains the single-composite-distance carrier and sweep-tool seed** (ADR 0045 D1.C) — not dead code. M48 does not touch it.
8. **`FILL_ACCEPTANCE_REJECTED` is the only reject vocabulary at this seam — never a `SkipReason`** (ADR 0045 §D2.1, reviewer B4). The new leg emits a `FILL_ACCEPTANCE_REJECTED` sub-reason via the named const `DEGENERATE_GEOMETRY_AT_FILL`. It must **not** emit `DEGENERATE_VWAP_GEOMETRY` (that is a strategy-layer `SkipReason`, pre-trade only).

---

## 3 — Proposed fix (tasks)

### Task 0 — New fill-time geometry-integrity leg in `evaluateFillDrift` (bot-engine-nestjs)
**Touches:** `apps/engine/src/execution/utils/exitGeometryHelper.ts` (`evaluateFillDrift` — add the new leg + the `IFillDriftContext` fields it needs + extract `resolveSlFloorDistance`), `ExecutionService.ts` (`rejectAndUnwindIfUnacceptable` at line ~1170 — the existing `evaluateFillDrift` call site already supplies `clampedExit`/`avgFillPrice`/`side`/`entrySnapshot`; pass `geometryParams` + `atr14` + `referencePrice` through the context, and log the ATR-unit drift at the existing drift-log line ~1180), `IOrderIntentApprovedEvent` + `StrategyService.emitApproval` (line ~256/394 — stamp `geometryParams`, see Item-1 amendment). **Contract touch (ADR 0045 §D2 amendment + `IOrderIntentApprovedEvent` field) → architect re-blesses first.** **No pure strategy core touched. No `entryHelpers.ts` touched. No `RiskGateService` check added.**

The single new leg, evaluated **at the fill seam against the actual fill price** (the local `avgFillPrice`, not `reconstructReferencePrice`). It runs **after** the existing wrong-side-of-SL leg and **before** the magnitude-drift leg:

```
fill = avgFillPrice                                  # the actual fill — the anchor for ALL distances below
# slFloor PCT leg anchors to intent.referencePrice (signal-calibrated), NOT fill (Item 2 / reviewer HIGH).
# entry_pct_floor is a percent-number → divide by 100 (strategyParamsSchema.ts:60). Extract resolveSlFloorDistance().
slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor / 100) × intent.referencePrice)

# Step 0 — fail-closed input guard (Item 3 + Residual 2 / reviewer must-state). The new leg is
# UNCONDITIONAL — it must NOT inherit the existing magnitude-leg `if (entrySnapshot && maxDriftPct)`
# opt-in guard. Any input the leg needs to compute slFloor/ratio being absent is a wiring bug:
if geometryParams absent on an OPEN approval:        → reject/escalate (fail-closed), never skip.
if entrySnapshot or atr_14 absent on an OPEN approval: → reject/escalate (fail-closed), never skip.
#   (slFloor needs atr_14 from entrySnapshot; without it the floor cannot be computed.)

# Step 1 — side-correct ordering FIRST (reviewer B1). Absolute-value distances mask a wrong-side fill.
SHORT requires:  stopLossPrice > fill > takeProfitPrice
LONG  requires:  takeProfitPrice > fill > stopLossPrice
if ordering violated:                → reject FILL_ACCEPTANCE_REJECTED / DEGENERATE_GEOMETRY_AT_FILL

# Step 2 — signed distances (now guaranteed positive by Step 1)
slDist_fill = (SHORT: stopLossPrice − fill) | (LONG: fill − stopLossPrice)
tpDist_fill = (SHORT: fill − takeProfitPrice) | (LONG: takeProfitPrice − fill)

# Step 3 — div-by-zero / collapsed-stop guard (reviewer M1: <= 0, not == 0)
if slDist_fill <= 0:                  → reject FILL_ACCEPTANCE_REJECTED / DEGENERATE_GEOMETRY_AT_FILL

# Step 4 — noise floor (reviewer H4 — the ratio alone misses the 212 collapse)
if slDist_fill < slFloor:             → reject FILL_ACCEPTANCE_REJECTED / DEGENERATE_GEOMETRY_AT_FILL

# Step 5 — R:R ratio (defense-in-depth backstop; reviewer H1/M4)
if tpDist_fill / slDist_fill < min_rr: → reject FILL_ACCEPTANCE_REJECTED / DEGENERATE_GEOMETRY_AT_FILL
```

- **Item 1 — `geometryParams` plumbing (Amendment 1A, architect decision — engine agent must NOT free-style).** The three M47 versioned params are NOT on `IOrderIntentApprovedEvent` today but ARE in scope at `StrategyService.emitApproval` (`activeParams`, line ~119/256). **Stamp `geometryParams: Pick<IStrategyParams, 'min_rr' | 'atr_floor_multiplier' | 'entry_pct_floor'>` onto `IOrderIntentApprovedEvent` at gate-approval time.** The fill seam reads it from the event — **zero DB round-trip on the fill hot path**. No alternative approach (no re-fetch, no re-resolve from the registry at fill time). `IOrderIntentApprovedEvent` is engine-internal, so this stays inside the engine boundary (no `bot-shared-maintainer` wave); `IStrategyParams` is the existing shared type, only `Pick`ed here.
- **Item 2 — `slFloor` PCT leg anchors to `intent.referencePrice`, not the fill (reviewer HIGH).** The ATR leg uses `atr14`; the percent-of-reference leg uses **`intent.referencePrice`** (the signal-calibrated anchor), NOT `fillPrice` — otherwise the floor threshold shifts with slippage and weakens the 212 guard. **Distances (Step 2) remain fill-anchored; only the floor *threshold* is signal-calibrated.** This matches `meanReversionCore.ts:96-103`. Unit: `entry_pct_floor` is a percent-number (divide by 100 before applying to a price — `strategyParamsSchema.ts:60`); do not mix with the fraction form.
- **Item 3 + Residual 2 — the new leg is unconditional and fail-closed on ALL its inputs (reviewer must-state).** The existing magnitude-drift leg is opt-in (`if (entrySnapshot && maxDriftPct)`, `exitGeometryHelper.ts:53`) and ships inert when params are absent. **The new geometry leg must NOT inherit that guard.** It needs `geometryParams` (the three M47 params) AND `atr_14` (from `entrySnapshot`) to compute `slFloor`. If **any** of `geometryParams`, `entrySnapshot`, or `atr_14` is absent on an OPEN approval, the leg **rejects/escalates (fail-closed)** — it does not silently skip. A missing input is a wiring bug, not a license to pass a fill unchecked.

- **One leg, one helper, one seam (reviewer H1).** The wrong-side-of-SL, noise-floor, R:R-ratio, and existing magnitude-drift checks all live in `evaluateFillDrift`. There is **no** separate touch in `momentumCore`, `entryHelpers.ts`, or `RiskGateService` — three touch-points doing the same fill-time math was the original plan's DRY violation. The new leg IS the fill-time backstop; there is no duplicate gate check.
- **The fill price is the anchor (reviewer H3).** All Step-2 distances measure from `fill`, never `reconstructReferencePrice`. `reconstructReferencePrice` (entryHelpers.ts:42) is untouched and its pure-core callers keep using the reconstruction at signal time (no fill exists there — Invariant 2/3). The fill anchor is a local variable at this execution seam only.
- **Not "mirroring meanReversionCore.ts:211" (reviewer H2).** `meanReversionCore.ts:211` is a *signal-time* check inside a pure core with no fill input — it cannot be mirrored at a fill seam. M48 reuses only the M47 `slFloor` **formula** (`max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry)`), placed in the execution layer. **No new params** — `atr_floor_multiplier`, `entry_pct_floor`, `min_rr` are the existing M47 versioned params; thread them (and `atr14`, `entry`) into `IFillDriftContext`.
- **Two-tier design is deliberate (reviewer M4).** The R:R ratio uses `min_rr` (1.5, the core target) here, because this leg is the fill-time enforcement and there is no separate looser fill-time floor. The M47 `MIN_RR_GATE_FLOOR` (1.0) remains the *signal-time* gate's loose floor. A fill landing in `[1.0, 1.5)` at fill is rejected by this leg (stricter than the signal gate) — intentional: the fill is the ground truth, so the fill-time check enforces the full target, not the loose floor.
- **Reject vocabulary (reviewer B4).** Emit a `FILL_ACCEPTANCE_REJECTED` result with sub-reason **`DEGENERATE_GEOMETRY_AT_FILL`** — a **named engine-local const** (not a bare string literal), in the fill-acceptance sub-reason set alongside `wrong_side_of_sl` / `drift_over_cap`. **Never** `DEGENERATE_VWAP_GEOMETRY` (a strategy `SkipReason`, forbidden at this seam per ADR 0045 §D2.1). Route the reject through the existing `unwindRejectedFill → fillAcceptanceUnwind.emitSyntheticClose` path (`ExecutionService.ts:1170-1216`) — one clean CLOSED `FORCE_CLOSE` row, no phantom, no new close path.
- **Comparator (reviewer NIT):** strict `<` (at-floor passes) for both `slDist_fill < slFloor` and `tpDist_fill / slDist_fill < min_rr`, matching `meanReversionCore.ts:211` (`lessThan`) and `isRewardRiskTooLow` (line 1214). Pin this in the test names.
- **`resolveSlFloorDistance` shared pure util — MOVE to `common/utils/`, Option A (Residual 3, LOCKED — engine agent must NOT choose ad hoc).** The function **already exists** as a private `resolveSlFloorDistance(referencePrice, atr14, params)` in `meanReversionCore.ts:99-103` and **already anchors its PCT leg to `referencePrice`** (line 101) — confirming Item 2 is already the established convention. The fill leg must reuse the **same** function, not a copy. **Placement decision: Option A — move `resolveSlFloorDistance` into `apps/engine/src/common/utils/` (the folder already exists; barrel from `common/utils/index.ts`) and import it from BOTH `meanReversionCore` and `exitGeometryHelper`.** Option B (duplicate-with-parity-test) is **rejected** — a single source removes the drift risk entirely. **Why Option A is mandatory, not just preferred:** strategy modules do **not** import from the execution module today (verified — no `strategy → execution` import exists), so placing the util in `exitGeometryHelper.ts` and importing it into `meanReversionCore` would create a **new `strategy → execution` dependency edge / circular-dependency risk**. `common/utils/` is importable by both layers with no new cross-module edge. Pure, decimal-only; the move is behaviour-preserving for mean-reversion (same function, new home) and must keep `meanReversionCore`'s existing call working byte-identically (a `resolveSlFloorDistance` parity assertion on the moved function guards the refactor).
- **Observability owners (reviewer medium).** Both observability outputs are owned by **`ExecutionService.rejectAndUnwindIfUnacceptable`** (line ~1170, which already logs `driftPct` at ~1180): (1) the `GEOMETRY_ANCHOR_DRIFT` log and (2) a **momentum-broken-out** `DEGENERATE_GEOMETRY_AT_FILL` reject-rate counter. Place both at that existing seam; do not scatter them.
- **ATR-unit drift log (reviewer M3, absorbs the old Task 1 canary).** At the call site (line ~1180), log the reconstruction-vs-fill drift in **ATR units** (`|fill − reconstructedRef| / atr14`) **and** absolute %, as `GEOMETRY_ANCHOR_DRIFT` (engine-local log/metric label, never a shared column or `SkipReason`). The ATR-unit form is regime-independent — it is the canary for how unreliable `reconstructReferencePrice` is in live, feeding a future decision on replacing it wholesale (out of scope). This is a **log only**; it does not gate.
- **Mean-reversion fills also pass through the new leg (reviewer medium — intentional defense-in-depth).** `evaluateFillDrift` runs on every OPEN fill regardless of core, so mean-reversion fills are subject to the geometry leg too. This is intentional: a second, fill-anchored safety net behind mean-reversion's own signal-time guard. Track the reject rate **broken out by `flow_type`** so a mean-reversion-specific over-reject is distinguishable from a momentum one.
- Decimal-only throughout; reuse the `Money` style already in `evaluateFillDrift`.

Paired tests (boundary at exactly `slFloor` and exactly `min_rr` both **pass** via strict `<`):
- **(a) TP-ordering break (reviewer B1, renamed):** a SHORT fill on the **correct side of its SL** (`fill < stopLossPrice`) but where the **TP is also above the fill** (`takeProfitPrice > fill`, i.e. the SL/fill/TP ordering `SL > fill > TP` is violated at the TP end) → reject `DEGENERATE_GEOMETRY_AT_FILL`. LONG mirror. **This targets the TP-ordering break specifically** — distinct from the existing `wrong_side_of_sl` reject (which fires first for the at/over-SL case, `fill ≥ SL`). Add a separate assertion that the at/over-SL case still routes to `wrong_side_of_sl`, so the two rejects do not blur.
- **(b) 212-style collapse (Defect 1, noise floor):** momentum SHORT with the live 212 fixture (ref `62.294`, fill `63.250`, SL `63.278`, TP coupled at signal time) → `slDist_fill ≈ 0.0285 < slFloor` (slFloor's PCT leg anchored to `referencePrice`, not fill) → reject `DEGENERATE_GEOMETRY_AT_FILL`. LONG mirror.
- **(c) 211-style inversion (R:R ratio):** a LONG fill where `tpDist_fill / slDist_fill = 0.74 < min_rr` → reject `DEGENERATE_GEOMETRY_AT_FILL`.
- **(d) 210-style pass:** a fill where `tpDist_fill / slDist_fill = 2.03 ≥ min_rr` and `slDist_fill ≥ slFloor` → **passes** (M48 must not reject a good trade — reviewer B2).
- **(e) `slDist_fill <= 0` (reviewer M1):** fill at the SL → reject (not a divide error); ordering leg catches it first, assert no division occurs.
- **(e2) Fail-closed input guard (Item 3 + Residual 2):** an OPEN approval reaching the seam with `geometryParams` absent → reject/escalate; **and separately** with `entrySnapshot`/`atr_14` absent → reject/escalate. Both must NOT silently pass the fill. Assert the pre-fix opt-in-guard behaviour (silent skip) fails and the fail-closed behaviour holds for each missing input.
- **(e3) `slFloor` anchor (Item 2):** a fixture where `fillPrice` and `intent.referencePrice` diverge and the PCT leg is the binding floor → assert `slFloor` is computed from `referencePrice` (the reject/pass flips if it were wrongly computed from `fillPrice`). Note: this is the *present-but-divergent* case; **absent** `atr_14` is the fail-closed (e2) case, not a fallback.
- **(FA — Residual 4) `ExecutionService.m38.fillAcceptance.spec.ts` integration case:** add one `FA*` case (mirroring the existing FA2/FA3 pattern) — a 212-style fill at the `rejectAndUnwindIfUnacceptable` seam → routes to `emitSyntheticClose` and **does NOT arm/attach** (assert no `POSITION_OPENED_EVENT`, no protective-monitor arm). This is the integration-level guard that the new leg's reject actually reaches the unwind path, distinct from the unit-level (a)–(g) tests on `evaluateFillDrift`.
- **(f) Parity / inertness (reviewer M2):** the backtest seam does **not** invoke the new leg (`BacktestOrchestrator` runs only the D1 rebase — assert unchanged); the shadow path does not invoke it (no exchange fill). Plus assert `|backtest_fill − reconstructedRef| < slFloor` for a representative case, so a future fill-model change that introduces slippage trips this test rather than silently diverging live from replay.
- **(g) Option-B preservation (Invariant 1):** the SL and TP **price levels** persisted on the position are unchanged by the leg — it rejects-or-passes, never mutates geometry; no fill-time rebase is re-introduced.

### Task 1 — Adversarial regression suite (bot-qa-engineer)
Per `dev-qa-cycle.md` §2: happy path is the floor, adversarial is the bar. Each defect gets a paired test (fails before / passes after). Required coverage = the Task 0 paired tests (a)–(g) above (including (e2) fail-closed param guard and (e3) `referencePrice`-anchored `slFloor`), plus:
- **Anchor assertion (Defect 2):** assert the leg's *distances* are computed from `avgFillPrice`, not the reconstructed reference, while the `slFloor` PCT *threshold* is computed from `intent.referencePrice` — feed a fixture where fill and reference diverge and assert both anchor choices independently.
- **Adversarial inputs:** zero `atr14` (slFloor falls back to the `entry_pct_floor` × `referencePrice` leg — assert it still bounds), enormous spike (fill far off reference, slDist collapses), TP-ordering break, negative inputs.
- **Mean-reversion defense-in-depth:** assert a mean-reversion fill that collapses at fill is also rejected by the leg (it is not momentum-only) and the reject is tracked by `flow_type`.
- **Anti-coverage:** a fill with inverted geometry at the fill price is **never** attached (always rejected); a good fill (210-style) is **never** wrongly rejected.

Adversarial failures route to the **architect** (not the developer) per `dev-qa-cycle.md` §2.2.

---

## 4 — Out of scope for M48

- **Full replacement of `reconstructReferencePrice`.** M48 adds the ATR-unit `GEOMETRY_ANCHOR_DRIFT` canary but does not redesign or remove the reconstruction. A wholesale replacement (e.g. persisting the true reference at signal time) is a separate decision, informed by the drift-rate this milestone surfaces.
- **Any change to `entryHelpers.ts` or any pure strategy core** (reviewer H3) — the signal-time reconstruction stays; only the execution-seam anchor changes.
- **Any new `RiskGateService` check** (reviewer H1) — the fill-time backstop is the `evaluateFillDrift` leg, not a duplicate gate method.
- **Shadow `simulated_fill.entryPrice` "fix"** (reviewer B3 — dropped) — filled rows already store the real price; zero rows are correct `missed=true` semantics.
- **Strategy parameter re-tuning** (`min_rr`, `atr_floor_multiplier`, `entry_pct_floor`, `MIN_RR_GATE_FLOOR`). M48 reuses the M47 provisional values verbatim; any re-tune is the separate post-deploy review M47 already scheduled. Note H5: the shared `slFloor` formula was tuned for mean-reversion's VWAP-half-retrace TP, not momentum's ATR-multiple TP — it ships as an acceptable v1, watched by the success-criteria reject-rate alarm.
- **Win-rate / signal-quality fixes** (the deferred M48-signal-quality workstream named in M47 §10 — note the naming overlap; *this* M48 is the geometry-fill-anchor fix). Profitability is not in scope.
- **Re-enabling any fill-time rebase.** Explicitly forbidden (Invariant 1).

---

## 5 — Success criteria (what must be true before M48 closes)

- **No opened live position holds fill-anchored R:R < `min_rr − ε`** (reviewer B2 — one-sided floor, **not** a band; a high-R:R trade like 210 at 2.03 is a pass, not a failure). After deploy, query live closed positions for fill-anchored `tpDist_fill / slDist_fill`; no *opened* position is below `min_rr` (1.5) minus a small epsilon. The 212 (85:1 hair-trigger SL) and 211 (0.74 inversion) shapes no longer open — they become `DEGENERATE_GEOMETRY_AT_FILL` rejects.
- **`DEGENERATE_GEOMETRY_AT_FILL` fires on every test where the fill diverges from the reference past the noise floor or inverts the ratio** (Task 0 paired tests pass; the 212 and 211 fixtures reject; the 210 fixture passes).
- **The leg catches both the noise-floor collapse AND the ratio inversion** (reviewer H4) — assert a 212-style case where `ratio > 1.0` but `slDist_fill < slFloor` is still rejected (the ratio-only check would miss it).
- **Momentum-specific `FILL_ACCEPTANCE_REJECTED` reject-rate alarm is live, with a provisional threshold (reviewer H5 + Residual 1)** — a counted alarm on the `DEGENERATE_GEOMETRY_AT_FILL` rate **broken out for momentum**, in the success criteria (not merely a monitoring note). **Provisional threshold: alarm if the momentum reject rate exceeds 5% over a rolling 20 fills** — a high rate signals the shared `slFloor` is mis-scaled for momentum's ATR-multiple TP. The 5% / 20-fill threshold ships **provisional** and is re-tuned post-soak exactly like M47's `min_rr` (param/threshold adjust, no code deploy logic change). Record the threshold in the deploy runbook alongside the M47 `min_rr` review note.
- **`GEOMETRY_ANCHOR_DRIFT` observability is live** — logged in **ATR units** (regime-independent, reviewer M3) and absolute %, giving the drift-rate signal the future reconstruct-replacement decision needs.
- **Live/backtest/shadow parity intact** — the new leg is inert in backtest (`evaluateFillDrift` not invoked there) and shadow; the parity test asserts `|backtest_fill − reconstructedRef| < slFloor` so a future slippage-introducing change trips the test (reviewer M2).
- **Option B preserved** — SL/TP price levels unchanged; no fill-time rebase re-introduced.
- **Reviewer gate** — zero blockers, zero highs, majority of mediums resolved (`dev-qa-cycle.md` §6.3); quant is lead reviewer (the change is fill-relative PnL math).

---

## 6 — Risk and mitigations

- **The fill-time leg rejects too aggressively on thin markets.** A collapsed `slDist_fill` on a wide-spread / thin-book fill could reject otherwise-acceptable trades. **Mitigation:** `slFloor` reuses the **same** `atr_floor_multiplier` / `entry_pct_floor` values mean-reversion already runs in live without over-rejecting. The momentum-specific reject-rate alarm (H5, now a success criterion) is the trigger for the post-deploy re-tune; M48 does not invent a tighter momentum floor.
- **Shared `slFloor` mis-scaled for momentum's TP geometry (reviewer H5).** Mean-reversion's floor was tuned alongside a VWAP-half-retrace TP; momentum's TP is ATR-multiple-based. **Mitigation:** accept the shared formula as v1, gate it behind the momentum reject-rate alarm; re-tune post-deploy if the alarm fires. Documented, not silently shipped.
- **Rejecting the fill leaves an exchange position to unwind.** The fill already exists on the exchange when the leg rejects. **Mitigation:** route through the **existing** `unwindRejectedFill → fillAcceptanceUnwind.emitSyntheticClose` path (the same one `wrong_side_of_sl` / `drift_over_cap` already use) — one clean CLOSED `FORCE_CLOSE` row, no phantom, no new close path. Verify the unwind handles the new `DEGENERATE_GEOMETRY_AT_FILL` sub-reason identically.
- **Live/backtest divergence if the leg accidentally runs in backtest.** **Mitigation:** the leg lives in `evaluateFillDrift`, which is already not invoked in backtest (ADR 0045 §D2.8, `BacktestOrchestrator.m38.spec.ts:484`); the parity test (M2) asserts both inertness and the `< slFloor` triggering condition so a future change cannot silently break parity.
- **M48 does not make the bot profitable** — it closes a specific live geometry-integrity defect (the fill-time check the M47 signal-anchored checks could not provide). Profitability is the separate signal-quality workstream. State this honestly in the milestone log to prevent a false "fixed" read.

---

## 7 — Dispatch note

Per `CLAUDE.md` waves and `dev-qa-cycle.md`: the contract touch is the **ADR 0045 §D2 amendment** (new `evaluateFillDrift` geometry leg + `DEGENERATE_GEOMETRY_AT_FILL` sub-reason + the `geometryParams` field on `IOrderIntentApprovedEvent`, Amendment 1A) — architect re-blesses **before** the engine wave. **No `bot-shared-maintainer` wave** (all engine-internal: `IFillDriftContext` and `IOrderIntentApprovedEvent` are engine types, `IStrategyParams` is only `Pick`ed from the existing shared type, the sub-reason is an execution-metric const, no `packages/shared` type or `SkipReasonEnum` is touched — reviewer B4). Task 0 is bot-engine-nestjs (the `evaluateFillDrift` leg + the `resolveSlFloorDistance` move to `common/utils/` + the `meanReversionCore` import-swap + the call site + the `emitApproval`/`IOrderIntentApprovedEvent` stamp + the `DEGENERATE_GEOMETRY_AT_FILL` execution const); Task 1 is bot-qa-engineer (adversarial, failures route to architect).

> **Wave-split note (Residual 5 — `dev-qa-cycle.md` §1.1).** Task 0 touches ≥5 production files (`exitGeometryHelper.ts`, `ExecutionService.ts`, `IOrderIntentApprovedEvent`, `StrategyService.ts`, `meanReversionCore.ts` for the Option-A util move, `common/utils/` new util + barrel, and the execution const file). This exceeds the ≤5-file soft anchor, so dispatch as **Wave 1a / 1b**: **1a** = the contract/plumbing edits (`IOrderIntentApprovedEvent` field + `StrategyService.emitApproval` stamp + the `resolveSlFloorDistance` move to `common/utils/` + the `meanReversionCore` import-swap, with the parity assertion that mean-reversion behaviour is byte-unchanged); **1b** = the new `evaluateFillDrift` leg + const + call-site wiring that consumes 1a. The split keeps each wave reviewable and isolates the behaviour-preserving refactor (1a) from the new behaviour (1b). The orchestrator verifies the 1a diff is inert for mean-reversion before 1b lands. Reviewer wave with **quant as lead** (fill-relative PnL math). Scribe closes out the ADR 0045 amendment, `docs/work-log.md`, the milestone log, `docs/STATUS.md`, and the `docs/plans/README.md` status flip. Every dispatch carries the `dev-qa-cycle.md` quick-reference: ≤5 files/items, paired tests, architect on contract touches, reviewer continuity, orchestrator verifies every diff.
