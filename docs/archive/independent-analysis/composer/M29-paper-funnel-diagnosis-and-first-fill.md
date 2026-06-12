# Independent Review — M29 Paper Funnel Diagnosis + First-Fill Enablement

**Plan reviewed:** `docs/plans/archive/M29-paper-funnel-diagnosis-and-first-fill.md`  
**Codebase snapshot:** 2026-06-10 (pre-implementation)  
**Reviewer:** Cursor (independent analysis)

---

## Executive Verdict

M29 is the correct hinge milestone after M24–M28: the soak still shows **zero positions, zero transactions, zero gate approvals**, so building the correlated slot-C strategy (WIP) would add a second unattributable path on top of a never-filled idiosyncratic leg. The plan’s **diagnostic-first, minimum-touch** posture — one conservative sizing clamp (D2), funnel observability (D3), correlated-plumbing pins (D4), config hygiene (D6) — aligns with CLAUDE.md survival priorities and ADR 0004’s “shrink, never grow” pattern.

The root-cause analysis for **`exposure_cap_per_coin` with zero open positions** is load-bearing and **code-consistent**: `checkExposureCaps` sums open + active + `intent.sizing.notional`, so with an empty book the rejection predicate is purely `intent.sizing.notional > maxExposurePerCoinUsdt`. Clamping in `PositionSizer` before the gate is the right seam (same shape as `clampToMaxLeverage`).

Two issues prevent a clean dispatch as written: (1) **implementation step 2 names the wrong caller** — sizing happens in `StrategyService.buildOrderIntent` and `BacktestOrchestrator`, not in `RiskGateService`; (2) **root cause #2 mischaracterizes `sl_outside_liquidation`** — the gate **tightens** stops that exceed the liquidation buffer; it **rejects** only when `clampStopInsideLiquidation` returns `null` (wrong-side stop, invalid leverage, non-positive liquidation fraction). The 66 soak rejections need attribution against that contract, not “stop too far.”

**Assessment:** **Approve with amendments** — ship D2 + D3 + D4 + D6 after fixing the sizing call-site list, correcting the `sl_outside_liquidation` diagnosis/tech-debt wording, and threading the cap through **both** live and backtest sizing paths for parity.

| Area | Grade | Assessment |
|------|-------|------------|
| Sequencing / D1 (defer slot C) | A+ | Evidence-driven; WIP prerequisite still 100% unmet. |
| Root cause #1 (sizer vs cap) | A | Correct math and conservative fix (clamp, not raise). |
| Root cause #2 (`sl_outside_liquidation`) | C+ | **Mechanism misstated**; tighten-vs-reject conflated. |
| Root cause #3 (correlated plumbing) | A | Code matches plan; WIP “never correlated” is stale. |
| D2 clamp design | A | Defence-in-depth with unchanged `checkExposureCaps` is sound. |
| Implementation steps | B | **Wrong service for sizing thread**; backtest path omitted. |
| D3 funnel observability | A- | `packages/analysis` is the right home; endpoint optional. |
| D4 correlated pin tests | B+ | Partial coverage already exists; extend, don’t duplicate. |
| D5 out-of-scope discipline | A | Correct refusal to hand-edit VWAP stop / depth / idio floor. |
| D6 config hygiene | A | `.env.example` duplicate is real; verify live `.env` too. |
| Post-deploy / success criteria | B+ | Honest about monitoring; **first fill not guaranteed** by D2 alone. |
| DB safety / ops | A | No migration; pg_dump + stale-halt clear correctly required. |

**Bottom line:** **Yes** to M29 scope and D1/D2/D3/D5/D6. **Amend** step 2 to thread `maxExposurePerCoinUsdt` through **`StrategyService.buildOrderIntent`** and **`BacktestOrchestrator.buildIntent`** (and any other `sizer.size` call sites), not `RiskGateService`. **Correct** root cause #2 and tech-debt (b) to reflect actual `SL_OUTSIDE_LIQUIDATION` triggers. Expect D2 to remove at most **~36 / 256** reachable rejects; **`sl_outside_liquidation` (66)** may remain the dominant blocker until a strategy milestone.

---

## Verified Current State

### Zero-fill funnel is real and upstream of fill mechanics

M24–M28 fixed open-fill wiring, paper stress relaxation, shadow counterfactuals, decision stamping, and same-bar recalibration — yet the plan’s soak metrics (0 positions, 0 transactions, 0 `gate_allowed=true`) show the bottleneck is still **gate approval**, not execution. That justifies M29’s framing over the WIP’s correlated-leg build.

### `exposure_cap_per_coin` with empty book = intent notional exceeds cap

```1149:1156:apps/engine/src/risk/service/RiskGateService.ts
    private checkExposureCaps(intent: IOrderIntent, context: IRiskGateContext, state: ILoadedState, ledger: ReservationLedger): RejectReasonEnum | null {
        const active = ledger.listActive();

        const perCoin = this.sumNotionalForSymbol(state.openPositions, active, intent.symbol).plus(intent.sizing.notional);

        if (perCoin.greaterThan(context.limits.maxExposurePerCoinUsdt)) {
            return RejectReasonEnum.EXPOSURE_CAP_PER_COIN;
        }
```

With `openPositions = []` and `active = []`, rejection is `intent.sizing.notional > maxExposurePerCoinUsdt`. Plan’s root-cause #1 holds.

### `PositionSizer` has no per-coin cap today — only leverage clamp

```47:49:apps/engine/src/risk/service/PositionSizer.ts
        const baseNotional = riskPerTradeUsdt.dividedBy(stopDistance).times(input.entryPrice);
        const fundedNotional = this.applyFundingCut(baseNotional, input);
        const leverageClampedNotional = this.clampToMaxLeverage(fundedNotional, input.allocatedCapital);
```

`ISizingInput` has no `maxExposurePerCoinUsdt`. Low-ATR coins can produce risk-targeted notionals well above `$500` while leverage clamp (`$4,500` at 3× on `$1,500` capital) stays non-binding — exactly the tension the plan describes.

### Sizing is **not** called from `RiskGateService`

Live path:

```216:226:apps/engine/src/strategy/service/StrategyService.ts
        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(this.config.accountCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: this.activeParams.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: this.activeParams.funding_rate_suppress_threshold,
            instrument,
        });
```

Backtest path (`BacktestOrchestrator`, same gap):

```205:215:apps/engine/src/backtest/service/BacktestOrchestrator.ts
        const sizingResult = this.sizer.size({
            allocatedCapital: new Money(ctx.allocatedCapitalUsdt),
            atr14: new Money(event.atr14),
            atrStopMultiplier: ctx.params.atr_stop_multiplier,
            entryPrice,
            tradeSide: signal.tradeSide,
            fundingRate: event.fundingRate,
            fundingRateAnnualized: event.fundingRateAnnualized,
            fundingRateSuppressThreshold: ctx.params.funding_rate_suppress_threshold,
            instrument,
        });
```

`RiskGateService` consumes `intent.sizing` after the fact. Plan step 2 (“thread cap into sizing call” via `RiskGateService`) is **incorrect** — implementers must update **both call sites** and pass `this.config.maxExposurePerCoinUsdt` (live) / `MAX_EXPOSURE_PER_COIN_USDT` or context equivalent (backtest).

### `sl_outside_liquidation` does **not** reject “stop too far” — it tightens

```1080:1086:apps/engine/src/risk/service/RiskGateService.ts
        const stopDistance = intent.entryPrice.minus(intent.proposedExit.stopLossPrice).abs();

        if (stopDistance.lessThanOrEqualTo(safeDistance)) {
            return intent.proposedExit;
        }

        return this.tightenStop(intent, safeDistance);
```

Rejection happens only when `clampedExit === null`:

```442:446:apps/engine/src/risk/service/RiskGateService.ts
        const clampedExit = this.clampStopInsideLiquidation(intent);

        if (clampedExit === null) {
            return this.rejected(intent, RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        }
```

`null` paths: invalid leverage, non-positive liquidation fraction, **wrong-side stop** (`isWrongSideStop`). Tests explicitly cover LONG stop `>= entry` and SHORT stop `<= entry` as `sl_outside_liquidation`.

For v2 momentum, VWAP is the structural stop:

```45:50:apps/engine/src/strategy/strategies/momentumCore.ts
    return {
        takeProfitPrice,
        // SL sits at VWAP — a structural price level, not an ATR-distance stop.
        stopLossPrice: new Money(event.vwapSession),
        stopType: StopTypeEnum.STRUCTURAL,
```

The plausible link to 66 rejections is **wrong-side VWAP** (e.g. LONG with `vwapSession >= entryPrice`), not “VWAP too far from entry.” A wide VWAP stop should **approve with tightened stop**, not reject — unless tightening is impossible because the stop is on the wrong side of entry. **Recommend:** before locking tech-debt (b), sample soak `decisions` rows rejected `sl_outside_liquidation` and compare `entry` vs `stop_loss` / `vwap_session` in snapshot JSON.

### Correlated path is plumbed; strategy is undifferentiated — plan is right, WIP is stale

```81:86:apps/engine/src/strategy/mapper/marketSnapshotMapper.ts
function resolveCorrelationMode(input: IMarketSnapshotInput): CorrelationModeEnum {
    if (Math.abs(input.event.btc5mMovePct) >= input.params.btc_correlated_move_threshold_pct) {
        return CorrelationModeEnum.CORRELATED;
    }

    return CorrelationModeEnum.IDIOSYNCRATIC;
}
```

`StrategyService` buffers correlated opens per bar and flushes the best `signalScore` — tests already exist (`StrategyService.spec.ts`: correlated buffer, `btc_correlated_not_best_candidate`). `BacktestOrchestrator` has `resolveCorrelationMode` tests (O7). D4 should **extend** existing specs, not greenfield duplicate.

WIP line “nothing emits `correlation_mode = correlated`” is **out of date** relative to live mapper code; empty `correlation_mode` on historical `decisions` is a **persistence / pre-stamp** artifact, as the plan notes.

### `MAX_OPEN_POSITIONS` duplicate — `.env.example` confirmed

`.env.example` sets `MAX_OPEN_POSITIONS=1` at line 218 and documents `MAX_OPEN_POSITIONS=3` as a commented paper override at line 291. Plan D6 is valid for **example + operator `.env`**; grep did not find `MAX_OPEN_POSITIONS` in the repo’s tracked `.env` (may be local-only). Scribe should fix **both** `.env.example` and operator guidance.

### `global_halt` (283) still masks reachable funnel on halted days

As in M25 review: once `risk_state.is_halted=true`, subsequent intents surface `global_halt`, not the underlying stress leg. D2 does not address this. Post-deploy **stale-halt inspection + evidence-gated `clearHaltForDate`** (plan checklist step 2) is **mandatory** for the clamp to be exercised — not optional polish.

### M27 `gate_allowed` NULL vs false

510 open rows with `gate_allowed` NULL (pre-M27 stamp) vs 29 `false` affects funnel rollup semantics. D3 query should document three buckets: `true`, `false`, `NULL` (legacy / skip / pre-stamp), not treat NULL as rejection.

---

## Decision Critique — Pros and Cons

### D1 — Defer correlated slot-C strategy; diagnose idiosyncratic funnel first

| Pros | Cons |
|------|------|
| WIP’s own prerequisite (“zero closed trades”) is still true after M24–M28. | 14-day soak gate delays slot-C work — acceptable trade-off. |
| Avoids unattributable P&L from two untested paths. | Correlated buffer already consumes some signals (`btc_correlated_not_best_candidate`); deferring strategy design doesn’t defer those rejects. |
| Reverses WIP lean with fresh DB evidence, not opinion. | — |

**Verdict:** **Ship.** Strongest decision in the plan.

---

### D2 — Clamp intent notional to per-coin cap in `PositionSizer`

| Pros | Cons |
|------|------|
| Safe direction only (shrink, never grow). | Realized risk per trade **below** 1% target on low-vol coins — telemetry must read `riskPerTradeUsdt` vs actual notional. |
| Mirrors existing leverage clamp pattern. | Step-rounding **after** clamp can drop notional further; plan accounts for this. |
| `checkExposureCaps` unchanged — defence in depth for open+reservation cases. | If clamp → `below_min_notional`, coin still won’t open (correct fail-closed). |
| Deterministic pure decimal — backtest parity preserved **if** backtest call site updated. | — |

**Verdict:** **Ship**, after fixing call-site list (see H1).

**Rejected alternatives** (raise cap, lower `RISK_PER_TRADE_PCT`, accept zero fills): correctly rejected.

---

### D3 — Funnel observability (query preferred over endpoint)

| Pros | Cons |
|------|------|
| `packages/analysis` already hosts canonical SQL (`getDecisions`, `selectHaltState`, etc.). | No dashboard widget — operator still runs query or hits API. |
| No schema migration — aligns with M27/M28 code-only pattern. | `market_stress%` prefix match must stay consistent with M23/M28 suffixed legs. |
| Answers “what blocks fills now?” post-D2. | — |

**Verdict:** **Prefer committed SQL in `packages/analysis`** (with tests mirroring other query modules). Add endpoint only if DI cost is truly low.

---

### D4 — Pin correlated plumbing + differentiation gap with tests

| Pros | Cons |
|------|------|
| Closes WIP ambiguity in code, not prose. | Some tests already exist — risk of duplicate maintenance. |
| “Absence of differentiated path” assertion forces future milestone acknowledgment. | Correlated winner === same `momentumCore` may be brittle if v3 hybrid routing changes. |

**Verdict:** **Ship** as **delta tests** on `marketSnapshotMapper`, `StrategyService`, and one explicit “no correlated-specific entry” assertion.

---

### D5 — Do not touch VWAP stop, depth floor, idiosyncrasy threshold

| Pros | Cons |
|------|------|
| Prevents over-fitting one milestone to “force a trade.” | First fill may **not** arrive in 24–48h if `sl_outside_liquidation` / depth / idio dominate after D2. |
| Each lever has its own ADR / calibration track. | Operators need clear expectation: M29 unblocks **one** choke-point, not the whole funnel. |

**Verdict:** **Correct discipline.**

---

### D6 — Remove duplicate `MAX_OPEN_POSITIONS`

| Pros | Cons |
|------|------|
| Eliminates “read 1, run 3” operator hazard. | No runtime change if last-wins already 3. |
| Documents sizing/cap relationship in `.env.example`. | — |

**Verdict:** **Ship** (docs + example; verify operator `.env`).

---

## Must-fix before dispatch

### H1 — Sizing call sites: `StrategyService` + `BacktestOrchestrator`, not `RiskGateService`

Plan scope item 2 and implementation step 2 reference `RiskGateService` threading the cap into `PositionSizer.size`. **There is no such call.**

**Required:**

- Add `maxExposurePerCoinUsdt` to `ISizingInput` and `clampToCeilings` in `PositionSizer`.
- Pass `new Money(this.config.maxExposurePerCoinUsdt)` in `StrategyService.buildOrderIntent`.
- Pass the backtest limit in `BacktestOrchestrator.buildIntent` (use the same `MAX_EXPOSURE_PER_COIN_USDT` constant already wired into `buildGateContext.limits` for consistency).
- Update `PositionSizer.spec.ts` and add one backtest-orchestrator sizing parity test if not covered.
- Leave `RiskGateService.checkExposureCaps` **unchanged** (plan already says this — keep it).

### H2 — Correct root cause #2 / tech-debt (b) for `sl_outside_liquidation`

Replace prose that says the gate rejects when “stop distance exceeds liquidation buffer.” Actual behaviour:

- **Tighten** when stop is correct-side but wider than `safeDistance`.
- **Reject** when `clampStopInsideLiquidation` returns `null` (wrong-side VWAP, bad leverage, etc.).

Tech-debt entry should say: “Investigate wrong-side VWAP structural stops under momentum follow; quantify rejections; strategy/quant milestone — not a hand-edit to buffer factor.” Optional: add funnel query column or post-hoc SQL for `entry` vs `stop_loss` on `sl_outside_liquidation` rows.

### H3 — Funnel rollup must handle `gate_allowed IS NULL`

D3 canonical query should split:

- `gate_allowed = true` → approvals  
- `gate_allowed = false` → explicit gate rejects  
- `gate_allowed IS NULL` → pre-M27 / skip / non-gate rows (do not lump with rejects)

---

## Should-fix before dispatch

### M1 — Set expectations: D2 alone does not guarantee first fill

Reachable reject counts (plan table): after removing ~36 `exposure_cap_per_coin`, **~220** reachable rejects remain among non-halted attempts (`sl_outside_liquidation` 66, `market_stress` 48, `coin_book_too_thin` 46, `no_eligible_slot` 38, etc.). Binary success (`positions >= 1`) is the right acceptance signal but may require **multiple sessions**, **halt clear**, and luck on blocker ordering. Success criteria prose should say “removes the cap choke-point” not “opens the funnel” globally.

### M2 — D4: extend existing tests

- `apps/engine/tests/strategy/service/StrategyService.spec.ts` — correlated buffer (lines ~536–609).  
- `apps/engine/src/backtest/service/__tests__/BacktestOrchestrator.spec.ts` — O7 `resolveCorrelationMode`.  
- Add `marketSnapshotMapper` boundary test at 1.5% if missing.

### M3 — ADR 0004 §8 amendment: note `riskPerTradeUsdt` semantics after clamp

`IIntentSizing.riskPerTradeUsdt` reflects the **1% risk target**, not post-clamp effective risk. Document so funnel/PnL readers don’t assume full risk budget on capped notionals.

### M4 — `.env.example` M25 block vs D6

After D6, ensure the paper exploration block doesn’t re-introduce a second `MAX_OPEN_POSITIONS` comment that conflicts with the single authoritative line. One commented paper profile section is enough.

### M5 — Correlated-mode snapshot on historical decisions

D3 rollup may want optional join to `market_snapshot->>'correlation_mode'` where present, or document that correlated vs idio split is **live-only** until backfill — avoids misreading Jun 7 batch as idiosyncratic in SQL.

---

## Test plan additions (for `bot-qa-engineer`)

Beyond the plan’s list:

1. **`StrategyService` integration:** open intent that would have been `exposure_cap_per_coin` at old sizing now builds intent with `notional <= maxExposurePerCoinUsdt` before gate.  
2. **Backtest parity:** same inputs through `BacktestOrchestrator` sizing produce the same capped notional as live.  
3. **`sl_outside_liquidation` regression:** wide correct-side stop **approves** with tightened stop (proves tighten path still works after D2).  
4. **Funnel query unit test:** NULL `gate_allowed` bucket; `market_stress%` matches `market_stress:btc_5m` style suffixed reasons.

---

## Post-deploy notes (agree with plan; one emphasis)

1. **pg_dump** before restart — correct, no migration.  
2. **Stale-halt clear** — **blocking** for validating D2; 283/539 `global_halt` share means many days never reach per-decision checks.  
3. **First-fill watch** — look for `gate_allowed=true` **and** `reason` not in post-clamp pre-gate skips; confirm `approvedSizing.notional <= 500`.  
4. **24–48h** — expect `exposure_cap_per_coin` on empty book → ~0; watch whether `sl_outside_liquidation` becomes #1 **reachable** blocker (likely, but for wrong-side/tighten semantics per H2).  
5. **14-day soak** — only then gate correlated-strategy milestone; measured negative edge is valid.

---

## Conclusion

M29 is **well-scoped, conservatively aligned, and correctly deprioritizes slot-C work** until idiosyncratic fills exist. The **`exposure_cap_per_coin` diagnosis and D2 clamp** are the highest-value, lowest-risk change in the plan. Fix the **sizing call-site error**, **correct `sl_outside_liquidation` mechanics in prose and tech-debt**, and **thread the cap through backtest sizing** before dispatch. With those amendments, **approve for implementation** under the standard wave: `bot-engine-nestjs` → `bot-qa-engineer` → parallel reviewers → `bot-scribe`.
