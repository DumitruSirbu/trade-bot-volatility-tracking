# Gemini Review: M21 Index-Shock Horizon Alignment

**Reviewer:** Gemini (independent)  
**Plan reviewed:** `docs/plans/M21-index-shock-horizon-alignment.md`  
**Date:** 2026-06-04

## Overall Assessment

**Approve for execution**, with two plan additions before dispatch: (1) an explicit **stale-halt rollout** step after engine restart (same failure mode as M19), and (2) a **downstream test/fixture sweep** beyond `StressHaltEvaluator.spec.ts`. The plan correctly separates a structural bug (BTC on 1m vs ETH on 5m) from a calibration bug (ETH floor too close to observed noise), and the atomic `isIndexShock` + `hasInvalidStressInputs` requirement is load-bearing — it matches the current dual-reference pattern in `StressHaltEvaluator.ts`.

On the question you care about most: **raising thresholds (ETH 2.0 → 2.5) is a good decision** for this bot’s survival-first posture and is supported by general crypto vol behavior. **BTC 1.5% on the 5m leg is reasonable** but is a *new* active sensor, not merely “loosening” — post-deploy monitoring should be part of success criteria, not an afterthought.

---

## Strengths

- **Correct diagnosis:** The soak showed the BTC 1m leg was empirically dead (peak 0.56% vs 1.0% floor over five days) while ETH on 5m fired on a single 2.12% reading at a 2.0% floor — classic horizon inconsistency plus hair-trigger ETH calibration.
- **Option B is the right structural fix:** Aligning both index legs to `btc_5m_move_pct` / `eth_5m_move_pct` removes apples-to-oranges logic and matches fields already on `IMarketSnapshot` (no new wiring).
- **Symmetry with ETH:** Moving BTC to engine-side `STRESS_BTC_5M_SHOCK_PCT` (like `STRESS_ETH_5M_SHOCK_PCT`) ends the awkward split where ETH used a const but BTC used `params.stress_btc_1m_shock_pct` against the wrong horizon.
- **M19/M20 discipline:** Code-only, no migration, deprecated params retained for replay — consistent with irreplaceable soak data rules.
- **Fail-closed atomicity:** Calling out that `hasInvalidStressInputs` must swap `btc_1m_move_pct` → `btc_5m_move_pct` in the same commit as `isIndexShock` is essential; without it, NaN on the field actually used would not halt.
- **Layered defense:** Breadth (hot-fixed to distance 40), same-bar count (50), spread, OI, and funding remain as OR-legs — index shock is not the only stress path.

---

## Threshold calibration — should you increase the floors?

The plan combines **two different changes**. Treat them separately when judging “raise thresholds”:

| Leg | What changes | Primary effect |
|-----|----------------|----------------|
| **BTC** | 1m @ 1.0% (param, never fired) → **5m @ 1.5%** (engine const) | **Activates** a real 5m stress leg; live behavior was not “halted by BTC” before — it was inert. |
| **ETH** | 5m @ **2.0% → 2.5%** | **Raises** the floor above the only observed near-event (2.12%) — classic false-positive reduction. |

### General crypto market volatility (2024–2026 context)

Public research and market commentary over the last two years point to a useful backdrop:

1. **BTC has matured, not gone quiet.** Fidelity Digital Assets and similar work note **lower realized volatility at much higher market caps** than in 2020–2021 (e.g. sub-50% annualized realized vol episodes while price was elevated). That supports **wider** shock floors than “early crypto” folklore, not tighter ones — but fat tails remain.

2. **5-minute granularity is standard for intraday stress.** Academic and industry intraday crypto work commonly aggregates to **5m bars** for realized variance and microstructure. Using 5m for a global halt is statistically coherent; using 1m for BTC only was the outlier.

3. **Order-of-magnitude sanity (Gaussian baseline, not a ceiling).**  
   If annualized realized vol ≈ **40–55%** (recent regime), a rough 5m 1σ move scales as  
   `σ_5m ≈ σ_annual × √(5 / (365×24×60))` → on the order of **~0.12–0.17%** per 5 minutes.  
   Crypto is **not** Gaussian: liquidation cascades, ETF flows, and macro prints produce **multi-σ 5m spikes** regularly on event days.

4. **Typical vs stress (qualitative, futures USDT-M):**
   - **Calm tape:** BTC 5m absolute moves often sit **well under ~0.5–0.8%**; ETH somewhat larger.
   - **Active but not “crash”:** **~1.0–1.5% BTC / ~1.5–2.0% ETH** in five minutes can occur on macro or correlation days without a full market breakdown.
   - **Genuine index shock / initiation:** **≥~1.5% BTC 5m** and **≥~2.0–3.0% ETH 5m** are plausible on liquidation or headline days — exactly when a mean-reversion bot should stop fading.

5. **ETH beta:** Short-horizon ETH move size is typically **~1.2–1.5× BTC**. If BTC’s shock floor is **1.5%** on 5m, a beta-consistent ETH floor is roughly **1.8–2.25%**. Proposed **2.5%** is **slightly conservative** (fewer ETH-only halts) — appropriate when the halt kills the **entire UTC day**.

### Mapping plan numbers to soak + vol

| Constant | Soak peak (5d, calm) | Buffer | Vol-informed read |
|----------|----------------------|--------|-------------------|
| `STRESS_BTC_5M_SHOCK_PCT = 1.5` | 1.04% | ~44% | Sits between “normal correlated chop” and “index initiation” in a compressed-vol regime; will still fire on macro/liquidation weeks — **desirable** for a global halt. |
| `STRESS_ETH_5M_SHOCK_PCT = 2.5` (from 2.0) | 2.12% (once) | ~18% | Fixes the demonstrated false positive at 2.0%; **statistically thin** (n=1) but directionally correct vs ETH beta. |
| Old `stress_btc_1m_shock_pct = 1.0` | 0.56% | never fired | Dead path — fixing horizon is hygiene, not loosening live BTC halts. |

**Verdict on increasing thresholds:**

- **ETH 2.0 → 2.5: Yes — good decision.** General vol structure (ETH > BTC on 5m) and soak evidence both support lifting a floor that clipped a lone 2.12% move. Re-tightening toward 2.0% without new data would repeat the soak failure mode.
- **BTC 1.5% on 5m: Yes — reasonable first cut, with caveats.** It is **not** proven optimal from five calm days; it is a defensible stress floor between soak peak (1.04%) and typical “big but not crash” 5m moves seen in broader markets. Expect **more BTC index halts than today** (today: zero from BTC) on volatile weeks — that is the trade for having a non-dead sensor.
- **Do not confuse “raise ETH” with “loosen everything.”** BTC change **adds** 5m sensitivity the bot never had; risk is **under-halting** moderate drift below 1.5%/2.5%, mitigated by other stress OR-legs and the documented sub-5m blind spot.

**Post-deploy recommendation (add to plan verification):** For 2–4 weeks, log near-misses `|btc_5m| ∈ [1.2, 1.5)` and `|eth_5m| ∈ [2.0, 2.5)` and count index-leg halts vs macro days. Revisit floors only with that distribution, not another short calm soak.

---

## Issues and recommendations

### 1. Stale `risk_state.is_halted` after restart (HIGH — rollout)

M21 is picked up by **engine restart only**. `RiskGateService` still short-circuits on persisted halt for the UTC day before re-evaluating stress. A halt flipped under **old** ETH 2.0% or other stress legs will **remain** until rollover or explicit clear — same class of issue documented for M19 operational follow-up.

**Add to plan (Verification or DB safety):**

- After backup and user-confirmed restart, inspect today’s `risk_state`.
- If `is_halted = true`, `halt_reason = market_stress`, and live snapshots are calm under **new** floors, clear today’s false halt via `clearHaltForDate` (dump + explicit confirmation per CLAUDE.md #8/#9).
- Separate verification failures: “stale persisted halt” vs “new thresholds still firing.”

### 2. Test/fixture blast radius (MEDIUM — QA scope)

The plan centers QA on `StressHaltEvaluator.spec.ts`, but stress is also exercised via **`btc_1m_move_pct`** in:

- `apps/engine/tests/risk/service/RiskGateService.spec.ts`
- `apps/engine/tests/risk/adversarial/M4-adversarial.spec.ts`
- `apps/engine/tests/risk/RiskGateService.bus.spec.ts` (+ adversarial variant)

After M21, high `btc_1m_move_pct` with calm `btc_5m_move_pct` must **not** halt. Tests may still pass while encoding the **old** contract.

**Add to QA wave:**

- Migrate stress scenarios to `btc_5m_move_pct` / `eth_5m_move_pct` at new constants.
- Rename `describe('BTC 1m shock trigger')` → 5m semantics.
- Refresh stale comments (e.g. breadth distance **40** post–June hotfix, not 30 in file header).

### 3. `hasInvalidStressInputs` — swap, do not accumulate (LOW)

When moving the guard to `btc_5m_move_pct`, **remove** `btc_1m_move_pct` from the `scalars` array unless another consumer still requires fail-closed on 1m. Today nothing in `isStressed` reads 1m after M21; leaving it in the list would allow **spurious halts** on bad 1m data while 5m is fine. The plan implies swap; implementers should **replace**, not append.

### 4. Backtest / replay contract (LOW — quant reviewer)

Deprecated `stress_btc_1m_shock_pct` / `stress_eth_1m_shock_pct` remain in schema and backtest fixtures (`BacktestRunnerService.spec.ts`, etc.). Historical replay must still parse JSON; **live halt logic** will ignore the BTC 1m param. Quant review should confirm backtest stress paths use the same `StressHaltEvaluator` semantics after M21 (M19 already caught a breadth-seeding blocker in backtest).

### 5. Flash-crash deferral (ACKNOWLEDGED)

Accepting 5m-only index shock with a documented sub-5m blind spot is reasonable **given** the 1m leg never fired and faster proxies exist (spread, same-bar). This is not a go-live blocker for a conservative bot; log as MEDIUM tech-debt as planned.

---

## Minor implementation notes

- **Boundary tests:** Plan correctly requires fire at `>=` const, silent just below — matches existing ETH tests against `STRESS_ETH_5M_SHOCK_PCT`.
- **ADR 0004 §6c:** Update the stress-input bullet list (currently still describes `btc_1m` as the BTC shock path in prose) when architect amends.
- **30-minute calm-market check:** Good operational gate; pair with stale-halt clear so the check measures **new** logic, not a row halted yesterday.

---

## Conclusion

| Question | Answer |
|----------|--------|
| Is the plan sound? | **Yes** — fixes real horizon mismatch and ETH false positive with minimal blast radius. |
| Is raising ETH 2.0 → 2.5 a good decision? | **Yes** — aligned with ETH short-horizon beta and soak evidence; avoids repeating day-killing halts on marginal moves. |
| Is BTC 1.5% on 5m a good decision? | **Reasonable yes** — activates a non-dead leg at a vol-informed stress tier; not statistically “proven” on five calm days alone. |
| Blockers before dispatch? | **No code blockers** — add stale-halt rollout + broader test sweep to the written plan. |

Dispatch order in the plan (architect → shared deprecation comments → engine atomic swap → QA → quant-inclusive review → scribe) is appropriate. Proceed after folding rollout and test-scope additions into the milestone doc.
