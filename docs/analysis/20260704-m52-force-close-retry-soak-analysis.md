# EXP-018 — M52 force-close + retry soak (first 24h post-M52a fix)

**Date:** 2026-07-04
**Window:** 2026-07-03 16:55 → 2026-07-04 14:00 UTC (rolling 24h), PAPER soak, `strategy_version_id = 20` (xmom)
**Method:** Row-level forensic read of `positions` (opens in the last 24h). No treatment applied — this is a mechanism-verification + diagnostic pass on the M52 D1–D3 force-close/retry mechanism after the M52a cooldown/consecutive-loss fix.
**Status:** SEEDING — mechanism confirmed working; one high-value design tension isolated (see Finding 2). No parameter change made yet.

> **Caveat — operator-triggered sample.** Of 6 rebalance batches in this window, only the `01:07` batch was `scheduled`; the other 5 were `manual` triggers fired to accelerate data collection. Trigger frequency inflates every open-side count (especially force_close). Rates below are descriptive of *this* sample, not a steady-state daily expectation.

---

## 1. What happened (21 positions, 6 rebalance batches)

| exit_reason | n | still open | of which retry entries | Σ realized PnL | avg PnL |
|---|---|---|---|---|---|
| `force_close` | 14 | 0 | 3 | **−$2.96** | −$0.21 |
| `stop_loss` | 4 | 0 | 1 | **−$55.50** | −$13.88 |
| `take_profit` | 2 | 0 | 0 | **+$54.55** | +$27.28 |
| _(open)_ | 1 | 1 | 0 | — | — |
| **Total** | **21** | 1 | 4 | **−$3.91** | — |

Two populations, cleanly separable by duration:

- **14 `force_close` — duration = 0 s, PnL ≈ −$0.15…−$0.62 each.** These never lived. They opened, the fill was evaluated, the fill-acceptance geometry guard rejected it, and the position was unwound in the same tick. The loss is round-trip fees on a small notional. **These are protective rejections, not trades.**
- **6 real trades (2 TP / 4 SL) + 1 still open.** 2 TP (+$24.40, +$30.15) vs 4 SL (−$15.01, −$15.90, −$12.90, −$11.70). Net on the traded book: **−$0.95** — essentially flat, a 2:4 win:loss count rescued by the ≥1.5 R:R geometry (winners ~2× the losers). Small n; not significant, but not alarming.

All 21 positions are **long** (xmom basket is long-only in this window) and all on thin paper-relaxed coins (RIF, MAGMA, XPL, TLM, HMSTR, LAB, VELVET). The `coin_tier` labels (`tier1`/`tier2`) reflect the M51 `PAPER_RELAX_PER_COIN_LIQUIDITY` reclassification, **not** true tier-1 majors — these are structurally thin books, which is central to Finding 2.

---

## 2. Force_close root cause — the geometry guard has ZERO slack against the entry geometry

This is the headline finding and the one actionable lever.

**The two thresholds are the same number with no buffer between them:**

- **Signal time** (`MomentumOrchestratorService.ts:618`): the TP is placed at exactly `entryPrice + stopDistance × xmom_min_rr`, with `min_rr = 1.5`. So every momentum long is armed at **exactly 1.5 R:R at the signal price**, and `tpRebaseEligible = false` — the TP anchor is frozen at the signal, never re-anchored to the fill.
- **Fill time** (`exitGeometryHelper.ts::evaluateFillGeometry`, `isRrInsufficient`): the fill-acceptance guard rejects the fill with `degenerate_geometry_at_fill` when realized `tpDist / slDist < min_rr` (again 1.5).

Because the TP is frozen and the entry is armed at *exactly* the reject threshold, **any adverse entry slippage on a long tips realized R:R below 1.5 and force-closes the fill.** For a long that fills above the signal price: `slDist = fill − SL` grows, `tpDist = TP − fill` shrinks (TP frozen) → ratio drops under 1.5 → reject. It is close to a coin-flip on slippage *direction* whether a fill survives, and on thin books slippage is both frequent and directional.

The data confirms it exactly. Realized R:R at the recorded fill price, force_close vs traded:

| Outcome | example ids | realized R:R at fill (tpDist/slDist) |
|---|---|---|
| `force_close` | 242, 252, 254, 259 | **0.13 – 1.50** (all **< 1.5**) |
| `force_close` | 241, 243, 244, 245, 257 | 1.11 – 1.50 |
| traded (SL/TP/open) | 247, 249, 253, 255, 256, 258 | **1.51 – 2.91** (all **≥ 1.5**) |

The split is razor-sharp: id 243 (XPL) at R:R **1.50** was rejected; id 247 (MAGMA) at **1.51** filled and traded. The guard is behaving *exactly* as specified — it is not a bug. The problem is that **the entry geometry gives it nothing to work with**: we arm at the floor, then reject anything that lands below the floor, so slippage alone decides ~2/3 of outcomes.

**This is why force_close is so frequent, and it can be improved upstream.** Candidate treatments (for a shadow test / architect review — do **not** ship blind):

1. **Arm with headroom.** Set the signal-time TP to `min_rr + buffer` (e.g. target 1.7–1.8 R:R at signal) while keeping the fill guard at 1.5, so that expected adverse slippage still clears the floor. Lowest-risk, most direct.
2. **Rebase the momentum TP to the fill** (`tpRebaseEligible = true` for xmom): re-anchor TP to `fill + atrDistance` so the R:R is reconstituted at the actual fill rather than measured against a stale signal anchor. Bigger behavioral change; interacts with the frozen-SL leg — needs quant review.
3. **Pre-fill RR gate with a slippage budget** at signal selection, so predictably-degenerate thin-coin candidates are filtered *before* the order rather than opened-and-unwound (saves fees + slot churn).

Note EXP-002 already ruled out re-tuning TP:SL *for profitability* (win rate is the binding constraint). This is a **different** objective: reduce the fee/slot waste and slot-occupancy churn of predictable fill-time rejections. It does not claim to change edge.

---

## 3. Reopening after first force_close — the M52 retry mechanism works as designed

Direct answer to the original question: **yes, the retry fires reliably.** 4 retry entries (`is_retry_entry = true`) landed after a prior force_close in-window, and the M52a fix (cooldown exemption + `force_close` excluded from the consecutive-loss veto) is doing its job — retries are no longer deadlocked.

Retry outcomes:

| retry id | symbol | followed force_close of | outcome | note |
|---|---|---|---|---|
| 247 | MAGMA | id 244 (01:07) | **stop_loss** (real trade, −$15.90) | ✅ recovered into a live position, R:R 1.51 at fill, held ~2h53m |
| 251 | HMSTR | id 248 (08:23) | force_close (−$0.19) | re-rejected, R:R 1.27 at fill |
| 260 | LAB | id 257 (13:59) | force_close (−$0.20) | re-rejected, R:R 1.34 at fill |
| 261 | VELVET | id 259 (13:59) | force_close (−$0.15) | re-rejected, R:R 1.35 at fill |

**1 of 4 retries recovered into a genuine position; 3 re-hit the same geometry reject.** That is expected and correct given Finding 2: the retry re-enters the *same thin coin* whose fill R:R is still governed by the same zero-slack threshold, so unless slippage lands favorably the second time, it re-rejects. The retry is not "failing" — it is faithfully re-attempting, and the underlying degeneracy is deterministic-ish for that coin/tick.

**Possible refinement (low priority):** the 3 re-rejections cost only fees, but they also consume a retry attempt and a slot cycle. If the fill-time reject is RR-insufficiency on a coin whose signal-time geometry was *already* at the 1.5 floor, a same-symbol retry is low-probability by construction. Consider either (a) applying the Finding-2 headroom to the retry arm specifically, or (b) capping same-symbol retries when the reject reason is `degenerate_geometry_at_fill` with an RR cause. Only worth doing after Finding 2 is addressed — the headroom fix would likely lift the retry recovery rate on its own.

---

## 4. Stop-loss population — full-size losers, one clear give-back

4 stop-losses, avg MAE −3.29%, avg MFE +2.44%. Compared to the 2 TPs (avg MFE +7.52%): **winners run far past their peak-adverse excursion; losers reverse after a modest favorable move.** That is consistent with momentum entries that either sustain (→ TP) or fade quickly (→ SL) — not a stop-placement defect per se.

The give-back worth flagging is **id 247 (MAGMA retry): MFE +4.76%, then round-tripped to MAE −3.44% and stopped for −$15.90.** Its TP was at +4.79% — it came within a hair of the target, then gave the entire move back to a full stop. This is the single most improvable trade in the window.

Candidate treatment (shadow only): a **break-even / partial de-risk after +1R**. Moving the stop to break-even once price reaches ~1R would have converted id 247 from −$15.90 to ~flat, and would not have touched the two clean TPs (they ran monotonically to target). **Caveat:** EXP-001/EXP-002 established that win rate is the binding constraint and that exit-geometry tweaks don't fix expectancy — a break-even stop trades win-rate (more scratches) for smaller left tail, so it must be shadow-tested for expectancy, not assumed positive. The stop *distances* themselves (1.5–3.1%) are ATR-driven and behaving normally; no evidence the stops are mis-sized.

---

## 5. Overall health

- **Mechanically healthy.** The M52 retry mechanism fires and recovers; the M52a deadlock fix holds; the fill-acceptance geometry guard is protecting capital exactly as specified (0-duration, fee-only rejects instead of doomed positions). Nothing is broken.
- **Force_close rate (14/20 opens ≈ 67%) is high but cheap** (−$2.96 total). It is *inflated by manual triggering* and *structurally caused* by the zero-slack entry/guard threshold on thin coins (Finding 2). It is not a mechanism fault.
- **Traded book is ~flat** (−$0.95 over 6 trades, 2:4 win:loss saved by RR). Far too small a sample to read edge; consistent with the long-standing finding that xmom's binding constraint is entry selectivity, not exit mechanics.
- **Highest-leverage improvement:** the Finding-2 headroom/rebase change — it attacks the force_close churn *and* would likely lift retry recovery, without claiming an edge change.

---

## Rules out / do not re-investigate

- Do **not** treat the high force_close count as a retry-mechanism failure or an M52a regression — the retry fires correctly and the guard is protective. The cause is the entry/guard threshold coincidence (Finding 2), not the retry.
- Do **not** widen `min_rr` on the *fill guard* to reduce force_closes — that would admit the sub-1.5 fills the guard exists to reject. The lever is the **signal-time arm** (add headroom / rebase), not the guard.
- Do **not** read the −$55.50 stop-loss sum as edge deterioration — n=4, and it is offset by +$54.55 of TP. Sample is operator-accelerated and far below significance.

## Seeds

- **Shadow test:** signal-time TP headroom (`min_rr = 1.5` guard, arm at 1.7–1.8 R:R) vs `tpRebaseEligible = true` for xmom — measure force_close rate, retry recovery rate, and expectancy on the traded book.
- **Shadow test:** break-even stop after +1R on xmom — measure expectancy vs baseline (guard against the EXP-001/002 win-rate trap).
- Route both through `bot-architect` (touches the strategy/execution geometry contract) before any code.

---

## Logic review — TP headroom proposal (bot-review-logic)

**Verdict: SUPPORT — WITH ONE MANDATORY MODIFICATION.** The diagnosis in §2 is correct and the headroom lever is the right one, but the proposal **cannot be implemented as literally stated** ("change the arm to 1.7–1.8, keep the guard at 1.5"). The arm ratio and the guard floor are the **same single parameter** today, so any change moves both together and buys zero slack. Headroom requires **decoupling into two params first**. Details below.

### 1. The arm and the guard are the SAME param — this is the load-bearing finding

For the xmom path (`MomentumOrchestratorService`, ADR 0048 — **not** `momentumCore.ts`, which is the retired VWAP-momentum path), `xmom_min_rr` is a single schema field (`momentumParamsSchema.ts:16`, default `1.5`) consumed in exactly two places:

- **Signal-time arm** — `MomentumOrchestratorService.ts:618`: `takeProfitPrice = entryPrice + stopDistance × params.xmom_min_rr`. Arms the LONG TP at exactly `xmom_min_rr` R:R off the signal price, `tpRebaseEligible = false` (`:667`), TP frozen.
- **Fill-acceptance guard floor** — threaded `params.xmom_min_rr` → `gateStrategyParams.min_rr` (`:857`) → stamped as `geometryParams.min_rr` on the OPEN approval (`:772-777`, only `isOpen`) → `exitGeometryHelper.ts:150` `isRrInsufficient(ratio, geometryParams.min_rr)` (strict `<`, pass at exactly the floor, `:188-189`).

So `geometryParams.min_rr === xmom_min_rr === the arm ratio`, always. **Bumping `xmom_min_rr` to 1.7 would raise the arm to 1.7 AND the reject floor to 1.7 simultaneously** — the zero-slack coincidence in §2 is preserved verbatim, one notch higher, and force_close frequency is unchanged. The premise "keep the guard at 1.5" is unreachable through this one param.

**Required change:** introduce a second param — e.g. `xmom_arm_rr` (default 1.5 to preserve current behavior) — consumed *only* at the arm (`:618`), and leave `xmom_min_rr` as the guard floor (`:857` → `geometryParams.min_rr`). Set `xmom_arm_rr = 1.7–1.8`, `xmom_min_rr = 1.5`. Only then does the arm sit above the reject floor and normal slippage clears it.

### 2. This is therefore NOT a pure config change (correction to the §2 framing)

Because a single value drives both seams, headroom **cannot** be delivered by editing `strategy_versions.params` alone. It needs: a `momentumParamsSchema` field addition + `IMomentumParams` type + the `:618` arm edit to read the new field. That is a **code + schema change**, so it must run the full architect → dev/QA → review waves (contract touch on the momentum params → `bot-shared-maintainer` + `bot-architect`), not a bare param bump. The seed in §Seeds line 108 should be re-scoped accordingly. Once wired, the new field is plain data read inside a pure function (no clock/rand/I-O at `:618`), so **determinism/purity is preserved** (Q4 ✅).

### 3. No adverse interaction with M52/M52a retry logic or ADR 0051 (Q2 ✅)

The retry breaker's primary gate keys on `event.atrUnitsDrift` (`MomentumOrchestratorService.ts:366`, vs `MOMENTUM_RETRY_MAX_ATR_DRIFT = 1.0`). `atrUnitsDrift` is the fill-acceptance guard's measured **anchor drift in ATR units** (`PositionRepository.ts:255-261`, `PositionEntity.ts:127-129`) — i.e. |fill − reference| / ATR, a function of entry slippage, **independent of TP width**. Widening the arm does not move it, so `MOMENTUM_RETRY_MAX_ATR_DRIFT` needs no recalibration and retry-eligibility (`:340-381`) is unaffected. The M52a deadlock fix (cooldown exemption + force_close excluded from the consecutive-loss veto, ADR 0051) is orthogonal machinery — it gates *whether* a force_close may retry, not the TP geometry. Net expected effect is benign and in the intended direction: fewer 0-duration force_closes → fewer retries fired, higher recovery on those that do (consistent with §3's 1-of-4 recovery being geometry-bound).

### 4. Side handling is safe today, but the decoupled param must stay symmetric (Q3 ✅ with a note)

The xmom arm is **hardcoded LONG** (`:618` `entryPrice.plus(...)`, `:626/:648` `PositionSideEnum.LONG`); there is no SHORT xmom path, so no directional bug is introduced by a LONG-only arm edit. The fill guard is already side-symmetric (`exitGeometryHelper.ts:159-171` `isSlOrderingViolated` / `resolveSignedDistances`), so it needs nothing. **Flag for the architect:** if `xmom_arm_rr` is added, apply it symmetrically (`entryPrice − stopDistance × xmom_arm_rr` on SHORT) *when* a short path is ever introduced, so the two seams never diverge by side.

### 5. Edge cases — widening moves AWAY from degeneracy (Q5 ✅)

`stopDistance = atr24h × xmom_atr_stop_multiplier` (`:616`) and `SL = entry − stopDistance` (`:617`) are **independent of the arm ratio**, so a higher `xmom_arm_rr` only pushes the TP farther from entry — it cannot shrink `slDist`, cannot trip the SL-floor legs (`isSlCollapsed` / `isSlBelowFloor` with `atr_floor_multiplier` / `entry_pct_floor`, `exitGeometryHelper.ts:140-146`), and cannot produce a degenerate/unreachable-by-geometry TP. Realized R:R at fill rises, clearing `isRrInsufficient` more easily. Note the xmom arm applies **no `max_tp_dist_factor` cap** (that cap lives only in the retired `momentumCore.ts:142`), so there is no cap interaction to worry about here. The only real downside is **expectancy**, not correctness: a farther TP is reached less often (more SL/time-stop exits), so — exactly as §2 already flags via EXP-002 — this must be **shadow-tested for expectancy on the traded book**, not assumed positive. It legitimately reduces fee/slot churn regardless.

### Bottom line

Support the headroom direction. Blocker to fix before it becomes a milestone: **decouple the arm ratio from the guard floor** (new `xmom_arm_rr`), otherwise the change is a no-op against force_close. Prefer this over Option 2 (`tpRebaseEligible = true`) as the first step — it is the smaller, gate-safe change (a wider signal-time TP still passes the gate's `min_rr` floor and keeps the ADR 0045 pre-fill-geometry guarantee intact), whereas fill-time rebase re-opens the single-leg-rebase-voids-the-gate hazard that `momentumCore.ts:86-95` documents as REJECTED.

## Quant review — TP headroom proposal (bot-review-quant)

**Verdict: SUPPORT-WITH-MODIFICATION.** The headroom idea is directionally right and the mechanics
check out, but two facts change the recommendation: (a) as the code stands today the arm ratio and
the guard floor are the *same param* (`xmom_min_rr`), so headroom is **not** a free param bump — it
needs a code change either way; and (b) once you're changing code, the *rebase* (option 2) is the
quantitatively cleaner fix because it does **not** widen the profit target for the trades that fill,
so it sidesteps the EXP-002 win-rate trap that headroom flirts with. Recommended target below.

### 1. Does headroom work mechanically? Yes — quantify the slack it buys

LONG, signal price `P0`, `D = stopDistance = atr × xmom_atr_stop_multiplier` (default mult **2.0**),
`SL = P0 − D`, TP armed at ratio `a`: `TP = P0 + a·D` (frozen). Fill `F = P0 + s·D`, where `s` is
adverse slippage as a fraction of `D` (`s > 0` = filled above signal). At the fill:

- `slDist = F − SL = D(1 + s)`
- `tpDist = TP − F = D(a − s)`
- realized `R:R = (a − s) / (1 + s)`

The guard rejects when realized R:R `< g` (`g = min_rr = 1.5`). Setting `(a − s)/(1 + s) = g` gives the
**max adverse slippage absorbed before re-trigger**:

> **`s* = (a − g) / (1 + g)`**

| arm `a` | `s*` (frac of `D`) | `s*` in ATR (`D=2·ATR`) | `s*` in price¹ |
|---:|---:|---:|---:|
| 1.5 (today) | **0.000** | 0 | **0%** — zero slack, confirms Finding 2 |
| 1.7 | 0.080 | 0.16·ATR | ~0.12–0.25% |
| 1.8 | **0.120** | 0.24·ATR | ~0.18–0.37% |
| 2.0 | 0.200 | 0.40·ATR | ~0.30–0.62% |

¹ using the window's observed stop distances of 1.5–3.1% price (⇒ ATR ≈ 0.75–1.55%).

So raising the arm 1.5 → 1.8 moves the tolerance from **exactly zero** to **12% of the stop
distance** (~0.18–0.37% price on these books). That is a real, non-marginal widening — it is the
difference between "any slippage rejects" and "a normal thin-book fill survives."

### 2. Would it have saved the 14 force_closes? Mostly yes — and it correctly leaves the tail rejected

Invert the recorded realized R:R `r` back to the slippage that produced it (`s = (g − r)/(1 + r)`,
arm `a=1.5` in-window), then test against `s* `:

| force_close | recorded R:R at fill | implied slippage `s` | saved at 1.7 (`s*`=.08) | saved at 1.8 (`s*`=.12) |
|---|---:|---:|:---:|:---:|
| retry 251 (HMSTR) | 1.27 | 0.101 | ✗ | ✓ |
| retry 260 (LAB) | 1.34 | 0.068 | ✓ | ✓ |
| retry 261 (VELVET) | 1.35 | 0.064 | ✓ | ✓ |
| near-floor cluster (243/244/245/257…) | 1.11–1.50 | 0.00–0.185 | partial | **most** |
| extreme tail (r≈0.13) | 0.13 | **1.21** | ✗ | ✗ |

Two reads: (a) **1.8 rescues the marginal cluster that 1.7 misses** (e.g. the 251 retry at `s=0.101`
needs `a≥1.75`), so **1.8, not 1.7, is the calibrated choice**; (b) the `r≈0.13` tail is a fill
**1.2 stop-distances above the signal** — a chase fill that *should* stay rejected. No sane arm
ratio saves it (`a≥2.7` required), and we don't want it to. This is the reassuring result: **1.8
absorbs realistic thin-book slippage while the guard still euthanises genuinely degenerate fills.**

### 3. Expectancy risk of headroom (question 2) — real but smaller than EXP-002 implies

Headroom widens the *actual profit target* for **every** trade, including clean (zero-slippage)
fills — a clean fill now aims at 1.8R instead of 1.5R. That is structurally the EXP-002 lever
(raise TP:SL ⇒ realized RR up, win-rate down). Two things bound the damage as **low**:

- **EXP-002's own numbers show expectancy is flat across ratios**, not cliff-shaped: 1.5:1 → 2:1
  moved expectancy −1.471 → −1.417 (a slight *improvement*) and cut max-DD 31% → 28%. The 1.5 → 1.8
  step is smaller (+0.3) and lands inside that noise band. EXP-002's message was "RR tuning won't
  *fix* profitability," not "widening RR destroys it" — and this proposal explicitly does not claim
  an edge change.
- **Winners overshoot the target with room to spare.** §4 records winner MFE **+7.52%** against a
  1.5R TP at ~+4.79%. A 1.8R TP sits at ~+5.7% — still well inside the winners' realized MFE, so
  genuine momentum winners keep hitting it. The conversion of near-TP winners into time-stops is
  therefore small (and per EXP-001 the marginal timed-out trade is a loser-in-waiting anyway).

Net: headroom's expectancy drag is within noise, but it is *non-zero and in the wrong direction*,
and it is paid on the healthy trades to rescue the marginal ones. That is the case for preferring
the rebase.

### 4. The rebase (option 2) is cleaner — but it is mis-wired today, do not ship as-is

Rebasing anchors TP to the **fill** instead of the stale signal, so it fixes the R:R the slippage
ate **without touching the target geometry for clean fills** — a zero-slippage fill gets an
identical TP either way; only slipped fills get a compensating nudge. Done right it holds realized
R:R at the design 1.5 for *every* accepted fill, so it eliminates RR-force_closes entirely **and**
carries **no** EXP-002 exposure (the ratio never leaves 1.5). Quantitatively this dominates headroom.

**Blocker if pursued:** the wired rebase offset is wrong for momentum. `rebaseMomentumTakeProfit`
(`exitGeometryHelper.ts:47`) sets `TP = fill + atrDistance`, and momentum passes
`atrDistance = atr24h` (`MomentumOrchestratorService.ts:668`) — i.e. **1×ATR = 0.5·D** at the
default mult 2.0. That yields realized `R:R = 0.5/(1+s) < 1` for *any* fill, so flipping
`tpRebaseEligible = true` alone would make the guard reject **every** momentum open. To preserve
R:R the offset must be **`min_rr × slDist = 1.5·(fill − SL)`** (or at minimum `min_rr × D`), not
`atr24h`. This needs a real code change to the rebase offset, not a flag flip.

**One caveat that favors headroom:** a perfect R:R-preserving rebase also neutralises the guard's
*implicit* chase-fill rejection — the `r≈0.13` tail would be *accepted* at a reconstituted 1.5R.
Headroom keeps rejecting it. If rebase is chosen, pair it with an explicit slippage budget (the
`DRIFT_OVER_CAP` magnitude leg, currently shipped-disabled, or option 3's pre-fill gate) to restore
that protection. This matters for the repo's conservative-survival mandate.

### 5. Recommended parameter and shape

- **If minimal surface is the priority (recommended first step):** arm at **1.8R** with a *new,
  separate* param — e.g. `xmom_tp_arm_rr = 1.8` used at `MomentumOrchestratorService.ts:618`, while
  the guard floor at `:857` stays wired to `xmom_min_rr = 1.5`. **Do NOT raise `xmom_min_rr`
  itself** — today lines 618 and 857 both read it, so bumping it moves the arm *and* the guard
  together and buys zero slack (the whole bug). 1.8 (not 1.7) is the calibrated value: `s* = 0.12`
  covers the observed marginal cluster (`s` up to ~0.10) with margin, while still rejecting the
  chase tail. Expectancy risk: low (§3).
- **If the cleaner fix is acceptable (preferred on expectancy grounds):** enable rebase for xmom
  **with the offset corrected to `min_rr × slDist`**, and enable the magnitude/slippage-budget guard
  to retain chase-fill rejection.
- Either path is a strategy/execution-geometry contract change → route through `bot-architect`, and
  **shadow-test** force_close rate, retry-recovery rate, *and* traded-book expectancy before
  promoting (per the EXP-001/002 win-rate-trap discipline). Do not read a force_close-rate drop in
  isolation as success.

## Offline validation feasibility check — xmom TP-arm (bot-review-quant)

**Verdict: the offline reconstruction is feasible and was run on all 31 xmom positions
(`strategy_version_id = 20`), but it structurally CANNOT answer the expectancy question the
milestone hinges on. That negative result is the finding: the 1.5→1.8 arm decision must be settled
by a paper shadow soak, not an offline check or a backtest.** Reproduction script (read-only,
`pg` + `decimal.js`, reproduces the doc's §3 realized-R:R values to the row):
`packages/analysis/research/xmom_tp_arm_reconstruction.mjs`.

### 1. Data model — verified, not assumed

The recorded `positions` triple is NOT a self-consistent 1.5R geometry:
`entry_price` = the **fill** (post-slippage); `stop_loss_price` / `take_profit_price` = the
**signal-frozen** SL/TP (`MomentumOrchestratorService.ts:617-618`, `tpRebaseEligible = false`).
So `TP_old − SL = 2.5·D` with `D = stopDistance`, giving a clean inversion with no path
assumptions:

- `D = (TP_old − SL) / 2.5`, signal price `P0 = SL + D`
- slippage `s = (entry − P0) / D`  (fraction of the stop distance; `s > 0` = filled above signal)
- `realizedRR_at_fill(a) = (P0 + a·D − entry) / (entry − SL)` — the fill-accept guard rejects
  (→ force_close) when this is `< 1.5` (guard floor held at 1.5; only the arm `a` moves).

This reconstruction **reproduces the doc's independently-computed §3 realized-R:R values to the row**
(id 243→1.500, 247→1.51, 251→1.27, 260→1.34, 261→1.35), confirming the model is correct.

### 2. Per-position reconstruction (all 31, arm 1.5 → 1.8, guard held at 1.5)

`s` = slippage (frac of D); `rr1.5`/`rr1.8` = realized R:R at fill under each arm; `a15`/`a18` =
fill accepted (Y) or force_closed (N); `tpd%18` = 1.8R TP distance from fill; `mfe%` = peak
favorable excursion. `RTY` = retry entry.

| id | sym | exit | rtry | dur s | s | rr1.5 | rr1.8 | a15 | a18 | tpd%18 | mfe% | pnl |
|---|---|---|---|---:|---:|---:|---:|:--:|:--:|---:|---:|---:|
| 231 | ALLO | stop_loss | | 43146 | −0.108 | 1.803 | 2.139 | Y | Y | 9.80 | 7.81 | −13.95 |
| 232 | TLM | take_profit | | 2281 | −0.027 | 1.569 | 1.877 | Y | Y | 12.95 | 11.33 | 24.16 |
| 233 | RE | force_close | | 0 | 0.198 | 1.087 | 1.338 | N | N | 2.49 | n/a | −0.20 |
| 234 | FARTCOIN | force_close | | 0 | 0.881 | 0.329 | 0.489 | N | N | 1.10 | n/a | −0.20 |
| 235 | WLD | force_close | | 0 | 0.661 | 0.506 | 0.686 | N | N | 1.35 | n/a | −0.20 |
| 236 | TLM | take_profit | | 2430 | −0.052 | 1.638 | 1.954 | Y | Y | 11.18 | 9.38 | 23.51 |
| 237 | M | stop_loss | | 1274 | −0.014 | 1.536 | 1.841 | Y | Y | 7.42 | 0.06 | −14.91 |
| 238 | TLM | stop_loss | | 1754 | −0.155 | 1.958 | 2.312 | Y | Y | 11.13 | 0.73 | −12.58 |
| 239 | M | force_close | | 0 | 0.297 | 0.928 | 1.159 | N | N | 5.80 | n/a | −0.15 |
| 240 | FARTCOIN | force_close | | 0 | 0.239 | 1.018 | 1.260 | N | N | 2.13 | n/a | −0.20 |
| 241 | RIF | force_close | | 0 | 0.120 | 1.231 | 1.499 | N | N | 6.35 | n/a | −0.16 |
| 242 | MAGMA | force_close | | 0 | 0.617 | 0.546 | 0.732 | N | N | 3.38 | n/a | −0.20 |
| 243 | XPL | force_close | | 0 | 0.000 | 1.500 | 1.800 | N | **Y** | 2.32 | n/a | −0.20 |
| 244 | MAGMA | force_close | | 0 | 0.182 | 1.115 | 1.369 | N | N | 5.14 | n/a | −0.19 |
| 245 | TLM | force_close | | 0 | 0.121 | 1.230 | 1.497 | N | N | 8.62 | n/a | −0.62 |
| 246 | HMSTR | stop_loss | | 1365 | −0.361 | 2.911 | 3.381 | Y | Y | 5.05 | 2.61 | −15.01 |
| 247 | MAGMA | stop_loss | RTY | 10383 | −0.003 | 1.508 | 1.810 | Y | Y | 5.74 | 4.76 | −15.90 |
| 248 | HMSTR | force_close | | 0 | 0.267 | 0.973 | 1.210 | N | N | 4.94 | n/a | −0.19 |
| 249 | TLM | take_profit | | 4183 | −0.009 | 1.522 | 1.825 | Y | Y | 8.85 | 7.88 | 24.40 |
| 250 | LAB | force_close | | 0 | 0.377 | 0.815 | 1.033 | N | N | 4.51 | n/a | −0.19 |
| 251 | HMSTR | force_close | RTY | 0 | 0.102 | 1.269 | 1.541 | N | **Y** | 5.46 | n/a | −0.19 |
| 252 | TLM | force_close | | 0 | 1.127 | 0.176 | 0.317 | N | N | 2.86 | n/a | −0.14 |
| 253 | HMSTR | take_profit | | 875 | −0.241 | 2.293 | 2.688 | Y | Y | 7.35 | 7.16 | 30.15 |
| 254 | LAB | force_close | | 0 | 1.213 | 0.130 | 0.265 | N | N | 1.63 | n/a | −0.20 |
| 255 | TLM | stop_loss | | 663 | −0.306 | 2.603 | 3.035 | Y | Y | 9.50 | 1.57 | −12.90 |
| 256 | HMSTR | stop_loss | | 333 | −0.241 | 2.294 | 2.689 | Y | Y | 6.80 | 0.80 | −11.70 |
| 257 | LAB | force_close | | 0 | 0.047 | 1.388 | 1.675 | N | **Y** | 5.05 | n/a | −0.20 |
| 258 | TLM | stop_loss | | 2639 | −0.052 | 1.637 | 1.954 | Y | Y | 9.87 | 1.81 | −14.16 |
| 259 | VELVET | force_close | | 0 | 0.396 | 0.790 | 1.005 | N | N | 5.75 | n/a | −0.15 |
| 260 | LAB | force_close | RTY | 0 | 0.067 | 1.342 | 1.623 | N | **Y** | 4.99 | n/a | −0.20 |
| 261 | VELVET | force_close | RTY | 0 | 0.062 | 1.353 | 1.636 | N | **Y** | 7.12 | n/a | −0.15 |

Aggregate: 19 force_close, 12 filled (4 take_profit, 8 stop_loss). Traded-book realized PnL sum
= −$8.88; force_close PnL sum = −$3.92. All 31 are long.

### 3. What the reconstruction CAN show (solid, geometry-only)

Holding the guard floor at 1.5 and moving only the arm to 1.8:

- **5 of 19 force_closes would clear the guard and fill** (ids 243, 251, 257, 260, 261) — exactly
  the set with `s ≤ s* = (1.8 − 1.5)/(1 + 1.5) = 0.12`. The doc's `s*` algebra is confirmed to the row.
- **All 14 remaining force_closes still reject**, including every chase fill (`s` from 0.18 up to
  1.21). The guard still euthanises genuinely degenerate fills — the reassuring result.
- **1.8 is on the edge, not comfortably past it:** ids 241 and 245 miss rescue by a hair
  (rr@1.8 = 1.499 and 1.497). The doc's "rescues most of the near-floor cluster" overstates it — the
  real figure is 5/19, and the marginal cluster sits right on the 1.8 boundary. A hair more adverse
  slippage and those re-reject.
- **No already-accepted fill flips to reject** at 1.8 (widening only raises realized R:R at fill).

### 4. What it CANNOT show — and why this is decisive

- Of the 12 filled trades, the **8 stop-losses are invariant** to widening (SL price unchanged, TP
  moves further away → still SL). The only outcome-changing trades are the **4 take-profit winners**
  (232, 236, 249, 253) — and for exactly those, `mfe_pct` is **truncated at the 1.5 TP** because the
  position closed there. MFE therefore cannot say whether price would have reached a wider 1.8 TP.
  (In all 4, MFE ≈ the trade's own 1.5-TP distance — a truncation artifact, not evidence that the
  winners would be lost.) **Neither the reassuring nor the alarming reading of the traded book is
  supported.** This also retires the "winners overshoot with room to spare" reassurance from the
  earlier § Quant review pt.3: matched to its own geometry, each winner's MFE falls below its own
  1.8 TP — but only because MFE was capped at the 1.5 exit, so it proves nothing either way.
- The **5 rescued force_closes have zero post-fill data** (0-duration), so their expectancy is
  entirely unobserved.
- **Reframe of the "free churn reduction" claim:** rescuing a force_close is NOT free. It converts a
  −$0.20 fee-only reject into a full-size live position whose stop-loss in this sample runs −$12 to
  −$16. The prior framing of headroom as "reduces fee/slot churn regardless of edge" understates the
  risk — the 5 rescued fills take on real, unmeasured downside exposure of unknown sign.
- The **724 `decisions` rows cannot widen the sample**: all are `action=open` intents carrying
  `atr_14` but **no forward price path and no fill/outcome**, so they cannot inform any TP-hit
  reconstruction (`market_snapshot` also carries many degenerate paper zeros). Not usable here.

### 5. Statistical power — nowhere near decision-grade

The decision-relevant events are **4 unresolvable winners + 5 no-data rescues ≈ 9**, against
EXP-011/012 (n ≈ 320) and EXP-002 (n ≈ 200–240) — one to two orders of magnitude short. n = 31
total is a mechanism-verification sample, not an expectancy sample.

### 6. Recommendation

**Do not gate this on an offline backtest.** A bar-replay backtest is not even feasible today
(`MomentumOrchestratorService` is unwired from `BacktestOrchestrator`), and building one would still
lack the intrabar path needed to price the rescued fills and the truncation-free winner outcomes.
The offline check has done its job: it validates the geometry/mechanics, confirms the chase tail
stays rejected, and **establishes that the expectancy question is unanswerable offline with current
data** — a useful stop against over-trusting a thin number.

Ship the decoupled `xmom_tp_arm_rr` param (default 1.5 = no-op, per the logic review) and settle
1.5-vs-1.8 with a **paper shadow soak** (`shadow_decisions` + `simulated_fill`), the only instrument
that observes the post-fill path for rescued fills and the truncation-free outcome for widened
winners. Target EXP-011/012 sample sizes (n ≈ 300+ trades) and read force_close rate, retry-recovery
rate, **and** traded-book expectancy together before promoting.

## Real-price replay — xmom TP ratio sweep (bot-review-quant)

**Script:** `packages/analysis/research/xmom_tp_ratio_replay.mjs` (read-only research; reruns as
more soak data accumulates). Closes the gap left by `xmom_tp_arm_reconstruction.mjs`: that script
could only test the fill-accept guard (`realizedRR_at_fill ≥ 1.5`) because `mfe_pct`/`mae_pct` are
single peak values — truncated for winners, absent for 0-duration force_closes. This script fetches
**real Binance USDT-M 1m OHLCV** (public endpoints, no keys) for each position from `opened_at`
through `time_stop_at` and replays it bar-by-bar to resolve which barrier — the widened take-profit,
the frozen stop-loss, or the time-stop — is **actually touched first**, using the *same* touch
convention as the live/backtest engine (`@bot/shared` `simulateIntrabarStop`: LONG SL when
`low ≤ SL`, TP when `high ≥ TP`, **SL wins same-bar ties** — C6 conservatism).

Run: `node packages/analysis/research/xmom_tp_ratio_replay.mjs --ratios=1.5,1.8,2,2.5,3`
(optional `--position-ids=…`). Reconstruction algebra (`D=(TP_old−SL)/2.5`, `P0=SL+D`,
`TP_new=P0+a·D` for long) is identical to the prior script and cited in the header; the guard floor
stays fixed at 1.5, only the arm moves.

### Cross-ratio results (n=31, all `strategy_version_id=20`, all long)

| arm | force_close | filled | TP-hit | SL-hit | time-stop | no-data | filled gross PnL* |
|----:|------------:|-------:|-------:|-------:|----------:|--------:|------------------:|
| 1.5 | 19 | 12 | 5 | 7 | 0 | 0 | +33.25 |
| 1.8 | 14 | 17 | 5 | 12 | 0 | 0 | −17.80 |
| 2.0 | 10 | 21 | 7 | 14 | 0 | 0 | +4.55 |
| 2.5 | 5  | 26 | 8 | 18 | 0 | 0 | −11.84 |
| 3.0 | 5  | 26 | 8 | 18 | 0 | 0 | +39.63 |

*Gross = `qty·(exit−entry)`, pre-fee / pre-funding. Cross-**ratio** comparable; **not** comparable
to `positions.realized_pnl` (which embeds fees, funding, slippage).

### Validation (ratio 1.5 must reproduce recorded reality)

- **Guard side — exact.** All **19/19** recorded `force_close` rows reproduce identically (the guard
  is deterministic algebra; XPL id243 sits exactly on the 1.5 boundary and is rejected in both).
- **Barrier side — 11/12 faithful.** Of the 12 recorded traded positions, 11 replay to the same
  barrier. The one flip is **id247 MAGMA** (recorded `stop_loss`, replay `take_profit`): at 1m
  granularity a bar's high reached the 1.5-TP before any bar's low reached the frozen SL, whereas the
  engine's sub-minute (1s tick) path hit SL first. This is the expected 1m-vs-subminute ordering
  limitation, and it cuts both ways — it is why TP-hit counts here are approximate, not exact.

### Findings

1. **Widening admits more trades, but they skew to stop-outs.** The TP:SL ratio among filled
   positions *degrades* as the arm widens — 5:7 (0.71) at 1.5 → 8:18 (0.44) at 2.5/3.0. The marginal
   positions rescued from force_close are precisely the ones the guard rejected because fill slippage
   had already eaten their R:R; on real price they disproportionately hit the (frozen, unchanged) SL.
2. **No monotonic PnL improvement.** Filled gross PnL is noisy and non-monotonic
   (+33 / −18 / +4.5 / −12 / +40). There is no stable "wider is better" signal in this sample, and it
   is **gross** — the 3.0 arm takes 26 trades vs 12 at 1.5, roughly doubling round-trip taker fees
   (~8 bps × notional) plus funding, which drags the wide arms *down* relative to what the table
   shows. The +39.63 at 3.0 is driven by 2–3 LAB/HMSTR/TLM winners, not breadth.
3. **Zero time-stops, zero survivorship gaps.** Every position resolved to SL or TP inside the 48h
   window at every ratio, and real 1m OHLCV was available for all 12 sample symbols (RIF, MAGMA, XPL,
   TLM, HMSTR, LAB, VELVET, RE, FARTCOIN, WLD, M, ALLO) — no delisted/no-data exclusions.

### Methodology caveats (rigor over a flattering number)

- **1m granularity, 100% low-fidelity touches.** No sub-minute path exists, so every touch is
  resolved at the 1m bar extreme and same-bar SL+TP ties resolve SL-first (conservative). TP-hit
  counts are therefore a *floor* where a TP was genuinely reached intrabar; the id247 flip shows the
  error can also go the other way. A 1s replay (from captured `tick_aggregates`, if retained for these
  windows) would tighten this.
- **Entry-minute excluded.** Only bars with `open ≥ opened_at` are replayed, so a touch within the
  fill minute is not counted — deliberately avoids entry-bar look-ahead, at the cost of possibly
  missing an immediate same-minute hit.
- **Not decision-grade.** n=31 is far below the EXP-011/012 power target (n≈300+, see
  `docs/analysis/README.md`). This is **better evidence** than the truncated-MFE proxy — real price
  confirms the barrier order for the filled book — but it is not proof. It reinforces, and does not
  replace, the existing recommendation: settle 1.5-vs-wider via a **paper shadow soak**
  (`shadow_decisions` + `simulated_fill`) at n≈300+, reading force_close rate, retry-recovery rate,
  **and** traded-book expectancy together. On this sample, widening the arm shows no edge and a
  worsening TP:SL mix — the conservative default (1.5) is not contradicted by real price.
