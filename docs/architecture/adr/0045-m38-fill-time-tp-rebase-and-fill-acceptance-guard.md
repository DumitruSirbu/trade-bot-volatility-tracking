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

## Consequences

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
