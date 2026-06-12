# Independent Review — M21 Index-Shock Horizon Alignment

**Plan reviewed:** `docs/plans/archive/M21-index-shock-horizon-alignment.md`  
**Codebase snapshot:** 2026-06-04 (pre-implementation)  
**Reviewer:** Composer (independent analysis)

---

## Executive Verdict

M21 correctly closes the last soak miscalibration from the June 3–4 review: BTC and ETH index-shock legs currently measure **different horizons**, the BTC 1m leg is **empirically dead** at the seeded 1.0% param, and ETH at 2.0% clipped a **single 2.12%** move that is plausibly normal alt-beta noise rather than a day-killing index event. **Option B** (both legs on `btc_5m_move_pct` / `eth_5m_move_pct`, engine-side consts) is architecturally sound and matches the 5m bar cadence the strategy already uses.

**Assessment:** **Approve with amendments** — ship after adding stale-halt rollout (M19 pattern), widening the QA fixture sweep beyond `StressHaltEvaluator.spec.ts`, and locking boundary semantics in §6c. On your main question: **raising ETH 2.0 → 2.5 is a good decision** for this bot; **BTC 1.5% on the 5m leg is a reasonable first cut but activates a leg that was previously inert** — treat post-deploy telemetry as part of the milestone, not optional.

| Area | Grade | Assessment |
|------|-------|------------|
| Problem diagnosis | A | Horizon mismatch and dead BTC 1m leg match `StressHaltEvaluator` + soak narrative. |
| Architectural fix (Option B) | A | Aligns legs; `btc_5m_move_pct` already on snapshot — no wiring work. |
| Atomic fail-closed swap | A | Correctly flagged; silent fail-open if guard lags `isIndexShock`. |
| Threshold calibration (ETH) | A- | Raising floor above lone 2.12% event is directionally right. |
| Threshold calibration (BTC) | B+ | 1.5% vs 1.04% soak peak is thin evidence; market norms support order-of-magnitude, not optimality. |
| Calibration sample | C+ | Five calm days — enough to fix false halt, not enough to close tuning. |
| Test / rollout plan | B | Good unit focus; missing downstream suites + stale `risk_state` step. |
| Cross-module const drift | C | Orphan `tieringConsts` shock values (3% / 4%) unrelated to M21 — confusion risk. |

**Bottom line:** M21 is a tight, migration-free milestone. **Yes, increase ETH to 2.5%.** **Yes, move BTC to 5m @ 1.5%** — but understand that is partly **turning on** a new halt path, not only loosening an existing one.

---

## Verified Current State

### Index shock today — mismatched horizons

```63:67:apps/engine/src/risk/service/StressHaltEvaluator.ts
    private isIndexShock(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        const btcShock = Math.abs(snapshot.btc_1m_move_pct) >= params.stress_btc_1m_shock_pct;
        const ethShock = Math.abs(snapshot.eth_5m_move_pct) >= STRESS_ETH_5M_SHOCK_PCT;

        return btcShock || ethShock;
    }
```

- BTC: strategy param `stress_btc_1m_shock_pct` (seed **1.0%**) vs **`btc_1m_move_pct`**
- ETH: engine const **`STRESS_ETH_5M_SHOCK_PCT = 2.0`** vs **`eth_5m_move_pct`**

`riskConsts.ts` documents the historical accident (ETH 5m field vs 1m param name).

### Fail-closed guard is coupled to BTC 1m today

```49:60:apps/engine/src/risk/service/StressHaltEvaluator.ts
    private hasInvalidStressInputs(snapshot: IMarketSnapshot): boolean {
        const scalars = [
            snapshot.btc_1m_move_pct,
            snapshot.eth_5m_move_pct,
            ...
        ];

        return scalars.some((value) => !Number.isFinite(value));
    }
```

M21’s atomicity requirement is **correct and load-bearing**.

### Snapshot fields are populated on the live path

At `volatility.detected` emit time, `MarketDataService` sets both horizons from `MarketContextService`:

- `btc5mMovePct` → rolling **5m** window move (`referenceMove`, 5m)
- `btc1mMovePct` → rolling **1m** window move

Stress halt consumes the **persisted snapshot** fields (`btc_5m_move_pct`, `btc_1m_move_pct`), not bar-to-bar close return. That is the same rolling-window semantics idiosyncrasy uses for the numerator at trigger time. §6c should say **“rolling N-minute tape move at bar close”**, not imply OHLC close-to-close only — operators calibrating from candle charts may misread peaks otherwise.

### Orphan market-data thresholds (out of M21 scope but confusing)

`apps/engine/src/market-data/const/tieringConsts.ts` defines **different** shock constants (`BTC_5M_SHOCK_PCT = 3`, `ETH_5M_SHOCK_PCT = 4`) used only in unused `MarketContextService.stressInputs()`. They do **not** drive `StressHaltEvaluator`. Recommend MEDIUM tech-debt: delete or align after M21 so two “BTC 5m shock” numbers do not coexist.

### Test drift already present

`StressHaltEvaluator.spec.ts` header/comments still say `STRESS_BREADTH_DISTANCE_PCT=30`; live const is **40** (June hotfix). M21 QA should refresh breadth comments while editing the file.

### Downstream tests still exercise BTC **1m** for stress

| File | Pattern |
|------|---------|
| `RiskGateService.spec.ts` | `btc_1m_move_pct: 2.0` / `5.0` for stress → halt |
| `M4-adversarial.spec.ts` | `btc_1m_move_pct: 5.0` |
| `StressHaltEvaluator.spec.ts` | entire `BTC 1m shock trigger` describe block |

After M21, **shocked 1m + calm 5m must not halt** on the index leg alone. Plan’s QA scope should explicitly include at least one **RiskGateService** integration case (GBT review H2 — I agree).

---

## Threshold calibration — is raising the floors a good decision?

This is the decision you asked about. The plan bundles **two different changes**:

| Leg | What changes | Effect on live behavior |
|-----|----------------|-------------------------|
| **BTC** | 1m @ 1.0% (param) → **5m @ 1.5%** (engine const) | **Activates** a leg that **never fired** in soak (1m peak **0.56%**). Not “raise to trade more” — **new measurement + new knob**. |
| **ETH** | 5m @ **2.0 → 2.5** (engine const) | **Raises** floor above the only observed near-miss (**2.12%**, once in 5 days). Classic false-positive reduction. |

Do not treat M21 as uniformly “loosening halts.” ETH yes; BTC is **horizon repair + enabling a previously dead OR-branch**.

### General crypto volatility context (2024–2026)

**Regime:** Post–spot-ETF BTC has **lower realized volatility** at comparable prices than 2020–2021. Fidelity Digital Assets and CFA Institute work both describe compressing annualized realized vol and fatter-but-less-frequent extreme days. For a **survival-first** mean-reversion bot, that supports **wider index-shock floors** than legacy “crypto always moves 5% a day” intuition — not tighter ones.

**Order-of-magnitude intraday scaling (BTC):**

- Rough rule: if annualized realized vol ≈ **50%**, a naïve Gaussian **5-minute** 1σ move is on the order of **~0.1–0.2%** (50% / √252 / √288). Crypto is **not** Gaussian; fat tails and vol clustering mean **~0.5–1.0%** absolute 5m moves happen regularly on calm weeks, and **1.5–3%+** on macro/CPI/liquidation days.
- Practitioner summaries (e.g. hourly **~50 bps** “typical” for much of the distribution, with **150–200 bps in the first minute** around major prints) align with using **multi-σ** thresholds for **halt** semantics, not noise filters.

**ETH short horizon:** ETH futures beta to BTC on 5m horizons is commonly **~1.2–1.5×**. If BTC halt is **1.5%** on 5m, a beta-consistent ETH floor is **~1.8–2.25%**. Proposed **2.5%** is **slightly conservative** (harder to trip than strict beta parity) — appropriate when the penalty is **UTC-day global halt** for all mean-reversion entries.

**1m vs 5m:** A violent **1m** spike can be **< 1.5%** on the **rolling 5m** field if price mean-reverts inside the window (plan’s accepted blind spot). Conversely, a **slow 5m drift** can trip 5m without a 1m spike > 1%. Moving BTC to 5m trades **flash sensitivity** for **sustained index displacement** — consistent with “trend initiation” intent in ADR 0004 §6.

### Soak evidence vs market reality

| Metric | Soak (5d, calm) | Proposed floor | Buffer | Verdict |
|--------|-----------------|----------------|--------|---------|
| `btc_5m` peak | **1.04%** | **1.5%** | ~44% | Reasonable **first** floor; will stay quiet on same tape; **will** fire on macro/liquidation weeks. |
| `btc_1m` peak | **0.56%** (never fired @ 1.0%) | (retired for halt) | — | Confirms old leg was dead; M21 fixes hygiene. |
| `eth_5m` single event | **2.12%** | **2.5%** | ~18% | **Good** false-positive fix (n=1); slightly tight statistically but directionally correct. |
| Old ETH floor | 2.12% > 2.0% | — | — | Explains soak halt contribution from ETH leg. |

**Five calm soak days** justify **fixing the ETH false trip** and **retiring the dead BTC 1m path**. They do **not** prove 1.5% / 2.5% are optimal across regimes.

### Recommendation on thresholds (explicit)

For a bot whose invariant is **“no order path bypasses risk; survival over trade count”**:

1. **ETH 2.0 → 2.5%:** **Yes — good decision.** Aligns with higher short-horizon ETH beta, compressed BTC vol regime, and soak’s demonstrated false positive at 2.0%. I would **not** re-tighten toward 2.0% without new data.

2. **BTC 5m @ 1.5% (new const):** **Yes — reasonable decision**, with caveats:
   - **Pros:** Symmetric with ETH; matches existing snapshot field; ~1.5% is a **genuine stress** move in a ~50% annualized-vol regime (multi-σ), not microstructure noise; still below orphan `tieringConsts` 3% (if anyone reads it).
   - **Cons:** Only **~0.46%** headroom above soak peak — a normal volatile week (not a crash) could approach 1.5% on rolling 5m BTC; you may see **more** index-leg halts than the soak implied, which may be **desirable** for survival but should be monitored.
   - **Alternative band (if post-deploy fires too often):** **1.75–2.0%** BTC 5m before touching ETH again. **Alternative band (if still too quiet):** **1.25%** — I would not go below soak peak + tiny epsilon without longer telemetry.

3. **Do not conflate with “raise all stress thresholds.”** Breadth distance and same-bar count were already hot-fixed separately; M21 should stay scoped to index legs only.

**Post-deploy calibration (should be in Verification, not optional):**

- Log daily max `|btc_5m_move_pct|`, `|eth_5m_move_pct|` from `decisions.market_snapshot` for **14 days**.
- Track **near-miss** bands: BTC ∈ [1.2, 1.5), ETH ∈ [2.0, 2.5).
- If index leg fires on days with no breadth/OI/spread co-stress, revisit floors before cloud soak scale-up.

---

## Must-fix before dispatch

### H1 — Stale `risk_state.is_halted` survives engine restart (M19 class)

M21 stops **new** false index halts but does not clear a row already halted under old thresholds. `RiskGateService` still returns `GLOBAL_HALT` when `state.today.isHalted` before re-evaluating stress.

**Add to Verification / scribe checklist:**

- After backup + user confirm: if today’s row is `market_stress` and live snapshots are calm under **new** floors, `clearHaltForDate` for today only — or document UTC rollover wait.
- Separate verification failures: “stale persisted halt” vs “new threshold still halting.”

### H2 — QA blast radius wider than plan lists

Extend `bot-qa-engineer` dispatch to update fixtures in `RiskGateService.spec.ts`, `M4-adversarial.spec.ts`, and bus specs:

- Index stress triggers: set **`btc_5m_move_pct`**, not `btc_1m_move_pct`.
- Add contrast test: **1m shocked / 5m calm → not index-stressed**; **5m shocked / 1m calm → stressed**.

---

## Should-fix before dispatch

### M1 — ADR 0004 §6 must be superseded, not duplicated

§6 still lists `stress_btc_1m_shock_pct` as active and “params-driven on 1m.” §6c should **replace** threshold bullets with:

- Both index legs: 5m fields + `STRESS_BTC_5M_SHOCK_PCT` / `STRESS_ETH_5M_SHOCK_PCT`
- Deprecated strategy keys (replay-readable)
- `btc_1m_move_pct` remains on snapshot for telemetry/idiosyncrasy, **exits** stress halt
- Rolling-window measurement semantics (see above)

### M2 — Lock inclusive boundary in plan + tests

Existing code uses `>=` for both legs. State explicitly: **at threshold → stressed** (same as current ETH tests).

### M3 — `hasInvalidStressInputs`: intentionally drop `btc_1m_move_pct`

After swap, invalid 1m no longer fail-closes globally — **correct** if 1m leaves the stress contract. Document in §6c so it is not “fixed” back without a consumer.

### M4 — Align or delete orphan `tieringConsts` shock constants

`BTC_5M_SHOCK_PCT = 3` / `ETH_5M_SHOCK_PCT = 4` vs M21’s **1.5 / 2.5** invites operator confusion. Not a blocker for M21 code path (unused `stressInputs()`), but scribe should log tech-debt.

### M5 — Backtest fidelity note

`BacktestRunnerService` sets `btc1mMovePct: 0` and populates `btc5mMovePct`. M21 **improves** backtest/risk alignment for BTC index shock (was effectively ETH-only + other legs). Mention in milestone-log so replay reviewers expect changed halt frequency on historical runs with real BTC bars.

---

## What looks good

- **Option B** removes apples-to-oranges BTC 1m vs ETH 5m comparison.
- **Engine-side consts for both legs** ends param/horizon mismatch for BTC.
- **Atomic `isIndexShock` + `hasInvalidStressInputs`** — right lesson from prior silent fail-open bugs; NaN test is the proof.
- **Deprecation without schema removal** — replay-safe, M19-discipline consistent.
- **Flash-crash deferral** is honest given dead 1m leg; spread + same-bar + breadth OR-chain is adequate backup for go-live **if** floors are monitored.
- **`bot-review-quant` in dispatch** — correct owner for 1.5/2.5 vs soak peaks.
- **No dashboard scope** — no new reject reason.
- **DB safety section** — correct; backup-before-restart matches CLAUDE.md #8/#9.

---

## Comparison to GBT independent review

A parallel review exists at `docs/archive/independent-analysis/gbt/M21-index-shock-horizon-alignment-review.md`. Conclusions align on: approve direction, ETH raise is clearly good, BTC 1.5% is reasonable but thinly calibrated, stale halt + test sweep amendments, §6c supersession. This Composer review adds emphasis on **BTC as enabling a new leg**, **rolling-window measurement semantics**, and **orphan `tieringConsts` drift**.

---

## Recommended dispatch adjustment (summary)

1. Architect §6c **supersedes** §6 threshold list (M1).  
2. Engine atomic swap (plan as written).  
3. QA: `StressHaltEvaluator` + **RiskGateService** + adversarial/bus fixtures (H2).  
4. Rollout: stale halt inspection after restart (H1).  
5. Verification: 30 min calm check **plus** 14-day max-move / near-miss logging (M4 in plan Verification).  

With those additions, M21 finishes the soak miscalibration arc. **Increasing ETH to 2.5% is a good decision grounded in both soak evidence and general crypto short-horizon volatility.** **BTC 1.5% on the 5m leg is a defensible survival-first choice** but should be validated on the first active macro week, not declared optimal from five calm days alone.
