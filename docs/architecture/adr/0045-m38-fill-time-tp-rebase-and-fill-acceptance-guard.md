# ADR 0045 — M38: Fill-time TP rebase and fill-acceptance guard (D1/D2)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Milestone:** M38 (D1 + D2; D3 gated, out of this ADR)
- **Supersedes / amends:** none. Composes with ADR 0008 (synchronous arm window), ADR 0015 +
  `live-vs-backtest-contract.md` (parity), ADR 0007 (ADD/reduce re-anchor rules), ADR 0019
  (promotion gate — D3 only).

> **ADR numbering note.** The milestone brief asked for "ADR 0020". 0020 is already
> `0020-auth-and-cors.md`. The next free number is **0045**; this ADR uses it. The brief's
> "0020" reference is stale.

---

## Context

The momentum exit geometry (TP/SL) armed on a position is computed in the **pure strategy layer**
(`momentumCore.ts`) from the **signal-time reference price** and then **frozen**. The execution
layer arms the protective monitor directly from those frozen values
(`ExecutionService.ts:927-928`, `:951-952`) and persists them at `createPositionFromFill`
(`:1136-1137`) — it never substitutes the **actual fill price** even though it has
`fillSummary.avgFillPrice` in scope (used for the stop-distance calc at `:1102`).

When the paper fill lands away from the signal price (>50% of the live 48h sample), the armed TP
and/or SL land on the **wrong side of entry**: 23 of 45 closed positions had ≥1 wrong-side level,
all exited in ≤2s as fake instant `take_profit` / `stop_loss`. M37's `tpEligible` guard fixes only
the *label*; it does not move the *level*. Two M37-post-rebuild positions (ids 68, 70) still armed a
wrong-side TP and closed at a loss labeled `take_profit`.

The economic loss (≈ −$80 of the −$88 window) is **direction/flow selection** (D3), not geometry.
D1/D2 are **correctness-by-construction** fixes whose value is making the surviving trades
**measurable** on clean geometry — they are not the economic lever. No strategy parameter is tuned
in M38.

The strategy layer must stay pure/deterministic (ADR 0015 / `live-vs-backtest-contract.md`); the
fix must therefore live in the **execution layer at fill acceptance**, and must apply at **both** the
live arm seam and the backtest `buildPosition` seam (which carries the identical frozen-geometry
bug). There is **no** shared fill/arm abstraction to reuse — parity is achieved by two **new pure
helpers** called at both seams.

---

## Decision

### D1 — Rebase momentum TP to the actual fill price at arm time (execution-layer transform)

1. **The rebase is an execution-layer transform, not a strategy change.** `momentumCore.ts` keeps
   emitting signal-time geometry. After the open fill is confirmed and before the monitor arms, the
   execution layer recomputes:
   `takeProfitPrice = avgFillPrice ± atrDistance` (`+` for LONG, `−` for SHORT). The multiplier is
   unchanged; only the **anchor** moves from signal price to fill price. **SL is never rebased** —
   the structural one-R VWAP budget is preserved (wrong-side SL is D2's job, not the SL's).

2. **Engine-local contract extension (NOT `packages/shared`).** `IProposedExit`
   (`apps/engine/src/strategy/interface/IProposedExit.ts`) gains two fields, flowing automatically
   onto `IOrderIntentApprovedEvent.clampedExit` (typed `IProposedExit`):

   - `tpRebaseEligible: boolean` — the **discriminator** at the arm seam. `momentumCore` sets
     `true` (TP is reference+ATR, rebase-eligible). `meanReversionCore` sets `false` (TP is
     VWAP-anchored; applying `fill ± ATR` would corrupt it). `stopType` is **not** a usable
     discriminator — both strategies set `STRUCTURAL`. Required `boolean`, not optional, so every
     producer is forced to declare intent (no silent default).

   - `atrDistance: MoneyValue | null` — the computed `atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER`
     distance. **Computed once in the strategy layer** (`momentumCore.buildMomentumExit`) and
     consumed **verbatim** — neither the live seam nor the backtest may re-derive
     `atr14 × MULTIPLIER` (re-derivation can diverge at the last decimal and fail the parity test).
     **Post-clamp by construction:** the field lives on `clampedExit`, the value the risk gate
     hands back after any SL/TP clamp; a pre-clamp `atrDistance` would reintroduce anchor drift if
     the gate clamps. **Nullable** (`null`, not `undefined`) on the mean-reversion path and any
     producer that is not rebase-eligible. Two distinct fields (not a single tagged union) keep the
     consumer check trivial: `if (clampedExit.tpRebaseEligible && clampedExit.atrDistance !== null)`.

3. **D1 is momentum-only.** The mean-reversion exit path is untouched. The reversion TP is
   VWAP-anchored; rebasing it would corrupt it. The `tpRebaseEligible=false` flag enforces this at
   the seam.

4. **Fallback when `atrDistance` is null (or absent):** do **not** rebase. Arm the original frozen
   geometry and rely on D1's verification query + the `tpEligible` backstop to flag it — **do not
   reject** on a missing distance. `tpEligible` is retained as defense-in-depth, not removed.

5. **Pure-helper extraction for parity.** A pure function
   `rebaseMomentumTakeProfit(clampedExit: IProposedExit, avgFillPrice: MoneyValue): MoneyValue`
   returns the new TP price (no I/O, no clock, decimal-only). It is called at the live arm seam AND
   at `BacktestOrchestrator.buildPosition`. The caller is responsible for the eligibility guard; the
   helper assumes a rebase-eligible input with a non-null `atrDistance` and a known side. Side comes
   from the intent/signal at the call site; the helper takes the resolved side or applies the sign
   from the position side passed in — see the impl brief for the exact signature variant chosen by
   the engine agent (either `(clampedExit, avgFillPrice, side)` or split LONG/SHARP). **No flag
   argument** — if a side parameter is added it is an enum, not a boolean.

### D2 — Fill-acceptance drift + wrong-side-of-own-SL guard (execution-layer reject + FLATTEN unwind)

1. **D2 is an execution-layer reject, NOT a strategy skip.** By fill acceptance the gate has already
   approved, an order was submitted, and a fill exists on the exchange. D2 is **not** a
   `SkipReasonEnum` decision (those are pre-trade at `StrategyService.persistDecision`). **Do not add
   `SIGNAL_STALE` to `SkipReasonEnum`.** The pre-trade `decisions` row (`action='open'`) is
   **correct and left unchanged** — the bot did decide to open.

2. **Placement.** D2 evaluates on a **confirmed full fill**, immediately after
   `createPositionFromFill` returns (~`:905-906`) and **before** the synchronous arm at `:922`. On
   reject: skip the arm entirely and route to the FLATTEN unwind. This keeps the ADR 0008 §2
   synchronous-arm window closed for *surviving* positions — a doomed position never arms. Partial
   fills / `RECONCILE_REQUIRED` follow the existing reconcile path (`:565, :703, :853`) and are
   explicitly **out of** D2's single-fill evaluation.

3. **Reject conditions (reject + unwind when EITHER is true):**
   - *(operative — hard structural check, always on, not tunable)* the fill is on the **wrong side
     of the position's own structural SL**: LONG with `avgFillPrice ≤ clampedExit.stopLossPrice`,
     SHORT with `avgFillPrice ≥ clampedExit.stopLossPrice`. **Keyed on `clampedExit.stopLossPrice`,
     not literally `vwapSession`** — this generalises correctly to mean-reversion (structural wick
     stop, not VWAP) and never wrongly rejects valid reversion fills.
   - *(far-tail magnitude guard — off by default / un-calibrated)*
     `driftPct = |avgFillPrice − referencePrice| / referencePrice > MAX_SIGNAL_DRIFT_PCT`, with
     `referencePrice = new Money(vwap_session).times(ONE.plus(new Money(vwap_deviation_pct).dividedBy(100)))`
     — **the exact decimal op-order of `entryHelpers.ts:44-46`** so it is bit-identical to the
     strategy-layer original. Built from `entrySnapshot`. **Disabled** unless an explicit
     fat-finger cap (e.g. 8.0%, expressed in % of reference price only, labelled un-calibrated) is
     configured. This window CANNOT calibrate a magnitude cap (drift is collinear with the
     wrong-side bug). The drift value is **logged on every evaluation** (even when it passes).

4. **Drift evaluation is a pure helper.**
   `evaluateFillDrift(clampedExit, avgFillPrice, entrySnapshot?, maxDriftPct?) →
   { shouldReject: boolean; reason?: string; driftPct?: number }` — pure, decimal-only. Consumes
   `clampedExit.stopLossPrice`, `avgFillPrice`, and the optional `entrySnapshot` (for the magnitude
   leg). Side is supplied at the call site. When `entrySnapshot` or `maxDriftPct` is absent, the
   magnitude leg is skipped; the wrong-side-of-SL leg always runs.

5. **The unwind: synthetic FLATTEN through the existing close pattern.** On reject the execution
   layer emits a synthetic `OrderIntentActionEnum.FLATTEN` intent through the existing
   `buildCloseIntent → riskGate.evaluate (auto-approved de-risk) → emit ORDER_INTENT_APPROVED_EVENT`
   pattern, which routes to the reduce-family finalize (`applyReduceFillToPosition`). The
   PENDING_OPEN `positions` row inserted at `:905` is force-closed through the existing
   promote-before-close guard (`:379`) and `finalizeRealizedPnl` (`:447`), yielding **one CLEAN
   CLOSED row** with `ExitReasonEnum.FORCE_CLOSE`. There is **no self-issued close** in the
   execution layer today — this is real new wiring, not a reuse.

6. **Close-intent helper extraction (now mandatory).** The `buildCloseIntent → gate → emit` pattern
   already appears in `LocalProtectiveMonitor.executeBreachClose` (`:340-400`) and
   `ReconciliationService.flattenAdoptedForeignPosition` (`:962-1028`). D2 is the **third** copy, so
   the DRY rule (3+ occurrences) triggers extraction. **Decision: extract a dedicated
   `PositionCloseCoordinatorService` (or `SyntheticCloseEmitter`) in the execution module that owns
   the slot-acquire → buildCloseIntent → gate-evaluate → emit → slot-leak/throw handling.** It is a
   service (not a bare util) because it depends on `closeCoordinator`, `riskGate`, and the event
   emitter — all injected. The two existing copies are refactored to call it in the same milestone
   if cheap; if not cheap, D2 uses the new service and the existing two are tracked as a carry-over
   refactor (the extraction must not balloon the diff). The helper MUST acquire the shared
   `closeCoordinator` slot and handle the gate-reject / throw slot-leak path exactly as the two
   existing copies do.

7. **D2 reject side effects:** release the close-coordinator slot per the standard pattern, emit a
   **counted execution-layer metric** (label `FILL_ACCEPTANCE_REJECTED`), do **NOT** mutate the
   `decisions` row. Net result of a D2 reject: `decisions` row unchanged + one CLOSED `positions`
   row (`FORCE_CLOSE`) + one counted `FILL_ACCEPTANCE_REJECTED` metric. DB and exchange agree
   post-unwind (no phantom).

8. **D2 is live-only.** The backtest fill price is deterministic (not exchange-slipped), so there is
   no drift to gate. `evaluateFillDrift` is **not** invoked in `BacktestOrchestrator.buildPosition`.
   Only D1's `rebaseMomentumTakeProfit` runs in backtest.

### Relationship to existing decisions

- **ADR 0008 §2 (synchronous arm window):** preserved. D2 runs *before* the arm so a doomed
  position never arms; surviving positions arm synchronously exactly as before. No ADR 0008
  amendment is needed (the arm ordering for surviving positions is unchanged).
- **ADR 0015 / live-vs-backtest contract:** parity is preserved via the two pure helpers called at
  both seams. **Backtest behaviour changes** (it previously armed frozen geometry with no
  instant-fire guard) — historical backtest metrics will move after D1 lands. This is an **expected
  re-baseline, not a regression**. Acceptance test #5 asserts the helpers produce identical output
  on identical inputs at both seams.
- **ADR 0007 §3 (ADD/reduce re-anchor):** unaffected. The arm is OPEN-only (`:922`); ADD does not
  re-anchor SL/TP (weighted-avg entry). D1 rebases only the OPEN intent; D2 evaluates only the OPEN
  fill. ADD/reduce are out of scope by design.
- **ADR 0019 (promotion gate):** governs D3 (V3 promotion), which is **gated and out of this ADR**.
  D3 requires M37 non-hollow shadow PnL + one clean post-D1/D2 soak window.

---

## Shared-contract boundary (what routes through `bot-shared-maintainer`)

| Item | Home | Routing |
|------|------|---------|
| `tpRebaseEligible`, `atrDistance` on `IProposedExit` | **engine-local** (`apps/engine/src/strategy/interface/`) | `bot-architect` (this ADR) — NOT shared |
| `rebaseMomentumTakeProfit`, `evaluateFillDrift` helpers | engine-local execution util | engine agent — NOT shared |
| `FILL_ACCEPTANCE_REJECTED` reject reason/metric label | **engine-local** (execution `enum/` or `const/`) | engine-local — it is an execution-layer counter, never serialized across the wire, never a strategy `SkipReason`. NOT shared. |
| `MAX_SIGNAL_DRIFT_PCT` | **engine** risk config (highest config level, `const/` or config) | engine-local risk param — NOT a shared DTO. NOT shared. |
| `OrderIntentActionEnum.FLATTEN` | `packages/shared` | **already exists** — reuse, do not add |
| `ExitReasonEnum.FORCE_CLOSE` | `packages/shared` | **already exists** — reuse, do not add |

**`FillAcceptanceRejectReasonEnum` decision:** an engine-local enum (in the execution module's
`enum/`) is sufficient and preferred — the reject reason is observed only inside the engine
(metric/log), never persisted to a shared-typed column nor sent to the dashboard. A single
`FILL_ACCEPTANCE_REJECTED` metric label with sub-reason strings (`wrong_side_of_sl`,
`drift_over_cap`) for the log is adequate; if the engine agent prefers a small engine-local enum
for the two sub-reasons, that is acceptable. Nothing here touches `packages/shared`.

---

## M47 Amendment — momentum TP no longer rebased (Option B mandatory) (2026-06-25)

Status: Accepted (re-blessed before the M47 implementation wave).
Milestone: M47 — Risk:Reward geometry fix. See `docs/plans/m47-rr-geometry-fix.md`.

This amends **D1**. M38's single-leg rebase (TP re-anchored to fill, SL pinned at VWAP) is the
source of Bug 2 in M47: after a fill landing off the signal reference, the TP moves but the SL
does not, voiding the signal-time R:R the gate approved. M47 resolves this by **removing the
momentum fill-time rebase entirely**.

### D1.A — Momentum TP is frozen at signal time (`tpRebaseEligible: false`)

`momentumCore` now sets `tpRebaseEligible: false` (it previously set `true`). **Both legs stay
at their signal-time price levels** — TP at `reference ± tpDist`, SL at the VWAP-session level.
There is **no single-leg rebase and no fill-time rebase at all for momentum**. Geometry is fixed
at signal time and never mutated for the life of the position.

If the fill drifts materially from the reference, the M38 D2 fill-acceptance guard already
rejects over-slippage fills (this ADR §D2), bounding the drift; the surviving geometry is the
signal-time geometry.

**Rebase-path audit (confirmed):** only `ExecutionService.ts:1051` and
`BacktestOrchestrator.ts:452` consume `tpRebaseEligible`. All other producers already set
`false`. Setting momentum to `false` fully closes the fill-time rebase path; no SL-update path
during the position lifecycle re-introduces drift.

### D1.B — Why Option A (rebase both legs) was rejected

Re-anchoring *both* TP and SL from the actual fill price would preserve the signal-time
distances, but it is **not viable**:

- The M47 risk-gate R:R backstop (ADR 0004 M47 amendment) validates **pre-fill** geometry — it
  runs at intent time on `intent.proposedExit`. It **cannot be moved to fill-acceptance time
  without restructuring the gate architecture**. Under Option A the gate would approve a
  signal-time geometry that does **not** match what the position holds after the rebase. Option B
  keeps the gate-approved geometry identical to the held geometry, which is what makes the
  pre-fill gate check sound.
- Option A also re-opens the "is the momentum stop a level or a distance" question ADR 0003
  settled, and a distance-preserved SL can land on the wrong side of the now-irrelevant VWAP.

Option A is dropped from consideration.

### D1.C — `atrDistance` survives Option B — it is NOT dead code

After Option B removes the fill-time rebase, a future reader may assume `atrDistance` is now
dead. It is not — **do not remove it.** Post-M47:

- `atrDistance` is still set on `clampedExit`, and now **equals the coupled `tpDist`** computed in
  `momentumCore` (ADR 0003 M47 amendment / M47 Task 2 — the `max(atrLeg, costFloorLeg, rrFloor)`
  result, including the `rrFloor` and its cap).
- It serves as the **single-composite-distance carrier** (D1.2 in this ADR — computed once in the
  strategy layer, never re-derived at the arm/backtest seams).
- It serves as the **sweep-tool reference seed**: `BacktestOrchestrator.applyTargetTpSlRatioOverride`
  (line 187) reads `proposedExit.atrDistance` to reconstruct the signal reference for an R:R sweep.
  For momentum this works post-M47 because `atrDistance == tpDist`. **The sweep tool is
  momentum-only** — for mean-reversion `atrDistance` is `null` and the override no-ops; do not use
  `targetTpSlRatioOverride` to validate `min_rr` on reversion trades.

Only the **fill-time rebase consumption** of `atrDistance` (the `rebaseMomentumTakeProfit` call at
the arm/backtest seams) is removed. The field and its other two roles remain.

### D1.D — `max_tp_dist_factor` cap on the momentum TP

The coupled momentum TP distance is `tpDist = max(atrLeg, costFloorLeg, rrFloor)` where
`rrFloor = min(slDist × min_rr, max_tp_dist_factor × atr14)`. The `max_tp_dist_factor` cap
(default 5.0, versioned param — ADR 0003 M47 amendment) prevents `rrFloor` from placing the TP at
a negative (SHORT) or unreachable (LONG) price on an extreme spike where VWAP sits far from
reference. If the cap binds and `tpDist / slDist < min_rr`, or the capped TP price is degenerate,
`momentumCore` **skips the signal** (ADR 0003 M47 amendment A2) — it does not arm a sub-target or
degenerate TP.

## M48 Amendment — fill-anchored geometry-integrity leg in `evaluateFillDrift` (2026-06-26)

Status: Accepted (re-blessed before the M48 implementation wave).
Milestone: M48 — Fill-anchor geometry fix. See `docs/plans/m48-geometry-fill-anchor-fix.md`.

This amends **D2** (it adds a leg to `evaluateFillDrift`) and adds **Amendment 1A** to the
engine-internal `IOrderIntentApprovedEvent`. It does **not** amend D1 (no rebase is re-introduced),
ADR 0003 (no strategy core changes), or ADR 0004 (no new `RiskGateService` check).

### Why M48

M47 froze SL/TP at signal time (D1.A / Option B) and added a *signal-anchored* R:R gate
(`isRewardRiskTooLow`). But every M47 geometry check measures distance against the **reconstructed**
signal reference (`reconstructReferencePrice`), never against the **actual fill price**. When the
live fill diverges from that reconstruction (1.53% on live position 212), the realized SL distance
collapses to a fraction of what the gate approved (34.5× smaller on 212 → 85:1 R:R at fill) and
inverted geometry ships. The existing `evaluateFillDrift` already runs at fill time and already
checks wrong-side-of-SL — but it has **no R:R / noise-floor leg**, so a fill landing the right side
of the SL but only a hair away from it passes today. M48 adds that missing fill-anchored leg.

### Amendment 1A — `IOrderIntentApprovedEvent` gains `geometryParams`

`IOrderIntentApprovedEvent` (engine-internal) gains:

```
geometryParams: Pick<IStrategyParams, 'min_rr' | 'atr_floor_multiplier' | 'entry_pct_floor'>
```

stamped at gate-approval time in `StrategyService.emitApproval` from `activeParams`. The fill seam
reads the three M47 versioned params off the event — **zero DB round-trip on the fill hot path**. No
re-fetch and no re-resolve from the registry at fill time. `IOrderIntentApprovedEvent` is
engine-internal so this stays inside the engine boundary (no `bot-shared-maintainer` wave);
`IStrategyParams` is the existing shared type, only `Pick`ed here. This matches the D1 precedent of
carrying signal-time values forward on the approved event rather than re-deriving them at the seam.

### D2.9 — new fill-anchored geometry-integrity leg in `evaluateFillDrift`

`evaluateFillDrift` gains one new leg, evaluated **at the fill seam against the actual fill price**
(`avgFillPrice`), running **after** the existing wrong-side-of-SL leg (D2.3 operative) and **before**
the existing magnitude-drift leg (D2.3 far-tail). The leg:

1. **Step 0 — fail-closed input guard.** The leg is **unconditional** — it must NOT inherit the
   magnitude leg's opt-in `if (entrySnapshot && maxDriftPct)` guard. If any of `geometryParams`,
   `entrySnapshot`, or `atr_14` is absent on an OPEN approval, it **rejects/escalates (fail-closed)**,
   never silently skips. A missing input is a wiring bug, not a license to pass a fill unchecked.
2. **Step 1 — side-correct ordering first.** SHORT requires `stopLossPrice > fill > takeProfitPrice`;
   LONG requires `takeProfitPrice > fill > stopLossPrice`. Absolute-value distances would mask a
   wrong-side fill, so ordering is checked before any distance is taken. (The at/over-SL case still
   routes to the existing `wrong_side_of_sl` reject, which fires first; this leg's ordering check
   targets the **TP-end** ordering break.)
3. **Step 2 — signed distances** (positive by Step 1): `slDist_fill`, `tpDist_fill`, both anchored to
   `fill`.
4. **Step 3 — collapsed-stop guard:** `slDist_fill <= 0` → reject (`<=`, not `==`).
5. **Step 4 — noise floor:** `slDist_fill < slFloor` → reject. The ratio alone misses the 212
   collapse, so the floor leg is required.
6. **Step 5 — R:R ratio:** `tpDist_fill / slDist_fill < min_rr` → reject (defense-in-depth backstop).

**Anchor split (the load-bearing decision).** All Step-2 *distances* are measured from the fill
price. The **`slFloor` PCT threshold** anchors to **`intent.referencePrice`** (the signal-calibrated
anchor), NOT the fill:

```
slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor / 100) × intent.referencePrice)
```

Anchoring the floor threshold to the fill would let it shift with slippage and weaken the 212 guard.
This is the **same anchor convention already established** in `meanReversionCore.ts` (its private
`resolveSlFloorDistance` already anchors its PCT leg to `referencePrice`). `entry_pct_floor` is a
percent-number — divide by 100 before applying to a price (`strategyParamsSchema.ts`).

**Two-tier `min_rr` is deliberate.** The ratio leg uses `min_rr` (1.5, the core target), not the
M47 `MIN_RR_GATE_FLOOR` (1.0) loose signal-time floor. A fill landing in `[1.0, 1.5)` at fill is
rejected here, stricter than the signal gate — intentional, because the fill is the ground truth.

**Comparators.** Strict `<` (at-floor passes) for both `slDist_fill < slFloor` and
`tpDist_fill / slDist_fill < min_rr`, matching `meanReversionCore` (`lessThan`) and
`isRewardRiskTooLow`.

**Extended `IFillDriftContext`.** The leg's inputs (`geometryParams`, `referencePrice`, `atr14`) are
threaded through the engine-internal `IFillDriftContext`. No `packages/shared` change.

### D2.10 — `DEGENERATE_GEOMETRY_AT_FILL` joins the fill-acceptance vocabulary

On any Step-1..5 failure the leg rejects via the existing `FILL_ACCEPTANCE_REJECTED` execution-metric
path with a new **engine-local named const** sub-reason `DEGENERATE_GEOMETRY_AT_FILL`, living in
`apps/engine/src/execution/const/executionConsts.ts` alongside `wrong_side_of_sl` / `drift_over_cap`
(the sub-reason set named in §D2.1 and the shared-contract boundary table above). It is **never** a
shared `SkipReason` and **never** `DEGENERATE_VWAP_GEOMETRY` (a strategy-layer `SkipReason`, pre-trade
only). The reject routes through the **existing** `unwindRejectedFill → emitSyntheticClose` path
(§D2.5) — one clean CLOSED `FORCE_CLOSE` row, no phantom, no new close path. The unwind handles the
new sub-reason identically to the existing two.

### D2.11 — `resolveSlFloorDistance` moves to `common/utils/` (Option A)

The `slFloor` formula already exists as a private `resolveSlFloorDistance(referencePrice, atr14,
params)` in `meanReversionCore.ts`. The fill leg must reuse the **same** function, not a copy.
**Decision: Option A — move it to `apps/engine/src/common/utils/geometryUtils.ts`, barrelled from
`common/utils/index.ts`, imported by BOTH `meanReversionCore` and `exitGeometryHelper`.** Option B
(duplicate-with-parity-test) is rejected — a single source removes drift risk entirely.

**Why Option A is mandatory, not merely preferred.** Strategy modules do not import from the
execution module today (verified — no `strategy → execution` edge exists). Placing the util in
`exitGeometryHelper.ts` and importing it into `meanReversionCore` would create a **new
`strategy → execution` dependency edge / circular-dependency risk**. `common/utils/` is importable by
both layers with no new cross-module edge. The move is pure, decimal-only, and **behaviour-preserving
for mean-reversion** (same function, new home) — `meanReversionCore`'s existing call must stay
byte-identical, guarded by a `resolveSlFloorDistance` parity assertion.

### D2.12 — `GEOMETRY_ANCHOR_DRIFT` observability (log only, never gates)

At the call site (`ExecutionService.rejectAndUnwindIfUnacceptable`), log the reconstruction-vs-fill
drift in **ATR units** (`|fill − reconstructedRef| / atr14`) and absolute %, labelled
`GEOMETRY_ANCHOR_DRIFT` (engine-local label, never a shared column or `SkipReason`). The ATR-unit
form is regime-independent — it is the canary for how unreliable `reconstructReferencePrice` is in
live, feeding a future decision on replacing it wholesale (out of scope). It is a **log only; it does
not gate.** A momentum-broken-out `DEGENERATE_GEOMETRY_AT_FILL` reject-rate counter lives at the same
seam, broken out by `flow_type` so a mean-reversion over-reject is distinguishable from a momentum one.

### Invariants preserved (confirmed for M48)

- **Wrong-side check stays.** The D2.3 operative wrong-side-of-SL leg is unchanged and still fires
  first for the at/over-SL case.
- **Option B / no-rebase stays.** SL/TP **price levels** are never mutated (D1.A, §D2 Invariant 1).
  The leg rejects-or-passes; the fill is the measurement *anchor* for the new distances (a local
  variable), not a new SL/TP source. No fill-time rebase is re-introduced.
- **`evaluateFillDrift` remains live-only** (§D2.8). The new leg is not invoked in
  `BacktestOrchestrator` (it runs only the D1 rebase) and is inert in the shadow path (no exchange
  fill). Backtest fill ≈ reconstructed reference, so even a future change that invoked the leg there
  would not trip it — asserted by a parity test (`|backtest_fill − reconstructedRef| < slFloor`).
- **Backtest/shadow paths inert; the unwind path unchanged** — the reject reuses the existing
  synthetic-FLATTEN unwind verbatim.
- **No new gate check, no strategy-core change, no `entryHelpers.ts` change** — the fill-time backstop
  is this single `evaluateFillDrift` leg, not a duplicate `RiskGateService` method.
- **Money is `decimal`, never float** — the leg matches the existing `Money`/decimal.js style.
- **Mean-reversion fills also pass through the leg** — intentional defense-in-depth behind
  mean-reversion's own signal-time guard; over-rejects are surfaced by the `flow_type`-broken-out
  counter.

### Out of scope (M48)

Full replacement of `reconstructReferencePrice` (M48 only adds the drift canary), any
`entryHelpers.ts` / pure-core change, any new `RiskGateService` check, the shadow
`simulated_fill.entryPrice` "fix" (filled rows already store the real price; zero rows are correct
`missed=true` semantics), parameter re-tuning, and re-enabling any fill-time rebase (forbidden).

## Consequences

- M48: `evaluateFillDrift` gains one fill-anchored geometry-integrity leg (side-ordering → noise-floor
  → R:R ratio, all anchored to `avgFillPrice`, with the `slFloor` PCT threshold anchored to
  `intent.referencePrice`); the fill-acceptance vocabulary gains `DEGENERATE_GEOMETRY_AT_FILL`; the
  shared `slFloor` formula `resolveSlFloorDistance` moves to `common/utils/geometryUtils.ts` (single
  source for both layers); `IOrderIntentApprovedEvent` carries `geometryParams` and `IFillDriftContext`
  carries `geometryParams`/`referencePrice`/`atr14` — all engine-internal. Option B no-rebase is
  preserved; the leg is live-only and inert in backtest/shadow.
- The execution layer gains a small fill-acceptance stage (rebase + drift gate + synthetic-close
  unwind) between `createPositionFromFill` and `arm`. The synchronous-arm guarantee is preserved.
- Strategies stay pure; the live-vs-backtest contract is preserved via two pure helpers (with a
  one-time backtest re-baseline).
- A `PositionCloseCoordinatorService` consolidates the thrice-duplicated synthetic-close pattern.
- D1+D2 are additive and revert cleanly. They do **not** address the economic loss (flow selection
  = D3); their value is correctness-by-construction and clean measurement.
- The new engine-local contract fields force every `IProposedExit` producer to declare
  `tpRebaseEligible` — a compile-time guard against a future strategy silently inheriting the
  momentum rebase.

## Alternatives considered

1. **Rebase inside the strategy layer (`momentumCore`).** Rejected — the strategy is pure and has no
   fill price; injecting the fill would break determinism and the live/backtest contract.
2. **Discriminate momentum vs reversion via `stopType`.** Rejected — both set `STRUCTURAL`; there is
   no existing discriminator. An explicit `tpRebaseEligible` field is required.
3. **Re-derive `atr14 × MULTIPLIER` independently at each seam.** Rejected — last-decimal divergence
   between a live `Money` and a backtest string re-multiply would fail the parity test. Carry one
   post-clamp `atrDistance`.
4. **Rebase the SL to the fill too.** Rejected — destroys the one-R structural VWAP budget.
   Wrong-side SL is handled by D2 reject + unwind.
5. **D2 as a `SkipReasonEnum` / strategy skip.** Rejected — by fill acceptance the order has filled;
   a skip is pre-trade and would not unwind the live exchange position (phantom).
6. **D2 reject = silently drop the position row.** Rejected — leaves the engine flat in DB but
   in-position on the exchange (phantom). The synthetic FLATTEN unwind is mandatory.
7. **Put the drift-reject reason / `MAX_SIGNAL_DRIFT_PCT` in `packages/shared`.** Rejected — both are
   engine-internal (a metric counter and a risk param); neither crosses the wire.
8. **Apply D2 in the backtest.** Rejected — backtest fills are deterministic (no exchange slippage),
   so there is no drift to gate; applying it would invent rejects that cannot occur live.
9. **Tune `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER` / `MAX_SIGNAL_DRIFT_PCT` from this window.** Rejected
   — the instrument is geometry-contaminated and per-flow n is below the noise floor. No
   calibration on a contaminated instrument.

### M48 alternatives considered

10. **Re-anchor the new fill-time geometry leg (and `reconstructReferencePrice`) instead of adding a
    reject leg.** Rejected — Option B / no-rebase is the M47 invariant; the gate approves the
    signal-time geometry, so the held geometry must match it. The fill is the measurement anchor for
    the new leg's distances, never a new SL/TP source.
11. **Anchor the `slFloor` PCT threshold to the fill price.** Rejected — the floor would then shift
    with slippage and weaken the 212 guard. The floor threshold anchors to `intent.referencePrice`
    (the established mean-reversion convention); only the distances are fill-anchored.
12. **Add a new `RiskGateService` check / mirror the `meanReversionCore` signal-time degeneracy
    check.** Rejected — the gate runs pre-fill and cannot see the fill; the signal-time core check
    has no fill input and cannot be mirrored at a fill seam. The fill-time backstop is the single
    `evaluateFillDrift` leg. Three touch-points doing the same fill-time math was a DRY violation.
13. **Duplicate `resolveSlFloorDistance` into the execution helper (Option B).** Rejected — it would
    drift from the `meanReversionCore` copy and, worse, importing the execution-located util back into
    `meanReversionCore` would create a new `strategy → execution` dependency edge. Option A (move to
    `common/utils/`) gives a single source importable by both layers with no new cross-module edge.
14. **Make the new leg opt-in (inherit the magnitude leg's `if (entrySnapshot && maxDriftPct)`
    guard).** Rejected — a missing input (`geometryParams`/`entrySnapshot`/`atr_14`) is a wiring bug,
    not a license to pass a fill unchecked. The leg is unconditional and fail-closed.
15. **Re-fetch the three M47 versioned params from the DB/registry at fill time instead of stamping
    `geometryParams` on the event.** Rejected — a DB round-trip on the fill hot path. Stamping at
    gate-approval time (Amendment 1A) carries them forward with zero round-trip, matching the D1
    precedent.
16. **Emit `DEGENERATE_VWAP_GEOMETRY` (the strategy `SkipReason`) at this seam.** Rejected — that is a
    pre-trade strategy `SkipReason`; the fill seam emits `FILL_ACCEPTANCE_REJECTED` with the
    engine-local sub-reason `DEGENERATE_GEOMETRY_AT_FILL` (§D2.1 vocabulary).
17. **Invoke the new leg in backtest/shadow.** Rejected — `evaluateFillDrift` is live-only (§D2.8);
    backtest fills are deterministic (no slippage), so the leg would invent rejects that cannot occur.

## M54 reference note (2026-07-09) — guard unchanged; its pre-fill anchor is now honest

Status: informational, **not an amendment**. `isRrInsufficient` / `evaluateFillGeometry` are
byte-for-byte unchanged.

M54 (`docs/plans/M54-xmom-entry-geometry-expected-fill.md`, ADR 0047 §7) arms xmom's SL/TP off an
**expected fill price** `F_exp = P0 × (1 + halfSpread/100)` instead of the raw signal `P0`, behind
default-off params. Before M54 the arm anchored to `P0` while this guard measures realized R:R
against the actual fill `F`, so on thin books (systematically adverse fills) realized R:R was
biased **below** the arm ratio and the guard rejected fills that were never geometrically doomed —
only mis-measured at open time. After M54 (when enabled), the arm anchors to `F_exp`, so the R:R
this guard measures at fill is **centered at the arm ratio** instead of biased below it. The guard's
**meaning is unchanged** — it still measures realized R:R at the actual fill and rejects below
`min_rr` — only the pre-fill anchor it is compared against is corrected. No code in this ADR moved;
M54's change is entirely upstream, at the arm site (`MomentumOrchestratorService`).
