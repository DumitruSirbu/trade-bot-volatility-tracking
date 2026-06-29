> **EXP-007 — INCONCLUSIVE** | 2026-06-29 | [back to index](README.md)

# Maker-Entry Slippage Variant on the Tier1 Momentum Book

## 1. Summary

Tested whether switching momentum **entry** orders from taker (IOC) to maker (post-only)
recovers enough modelled slippage to make the only price-positive v16 cohort
(`tier1 ∩ {trending_down, trending_up}`, n=112) net-positive. The cohort is baseline
net **−$74.42** with **+$26.72** gross-ex-slippage and **$79.54** of modelled slippage —
breakeven needs **93.6%** of that slippage recovered. Recovering it requires maker on
**both** legs (S4: net +$15.72 no-penalty, +$2.32 at a 20% TP-miss rate). But maker entry
recovers only the entry leg (~50% of slippage); per ADR 0005 row 7, all reduce/close/flatten
exits are forced `REDUCE_MARKET` and stop-losses are stop-market — so **98 of 112 exits are
structurally taker** and the both-leg scenario is not achievable. The achievable lever,
entry-only maker (**S3: net −$29.35** even with zero missed fills, worse with any penalty),
does **not** make the cohort net-positive. Verdict: **INCONCLUSIVE** — the improvement is real
and the breakeven is mechanically within 100% of slippage, but net-positive depends on
both-leg maker exits that the locked execution policy forbids, plus near-zero missed fills on
fast TP movers.

## 2. Setup

**Method.** Analytical re-computation over the existing 350-trade v16 backtest JSON
(`scratchpad/backtest-v16.json`). No new backtest. Per-trade adjustments applied to
`grossPnlUsdt`, `feesUsdt`, `slippageCostUsdt`; net recomputed as
`net = newGross − newFees + fundingUsdt` (funding sign verified per trade: target cohort
funding = −$0.39, a net debit).

**Cohort definition.**
- Target: `coinTier == 'tier1' AND regimeAtEntry IN ('trending_down','trending_up')` — the only
  price-positive construct from EXP-006 (gross-ex-slippage +$22.21 and +$4.51 respectively).
- Secondary reference: full tier1 (n=240).

**Fee/slippage calibration (corrected against live params and engine consts).** The brief
assumed taker 0.05% / maker −0.02% / tier1-slip 0.15%. Verified actuals:

| Parameter | Brief assumption | Verified actual | Source |
|---|---|---|---|
| Taker fee/leg | 0.05% | **0.04%** (0.0004) | `RISK_TAKER_FEE_RATE`, `MOMENTUM_TAKER_FEE_RATE`, `SHADOW_TAKER_FEE_PCT` |
| Maker fee/leg | −0.02% (rebate) | **+0.02%** retail (no maker const in code) | Binance USDT-M retail default; rebate is VIP-only |
| Tier1 slippage | 0.15% | **0.15%** | `strategy_versions` id 16 `slippage_tier1_pct` |

Fee verification on trade 0 (1000PEPE): entry notional $250.39 + exit notional $251.16 =
$501.55 × 0.0004 = $0.2006 = reported `feesUsdt` 0.20060744. Confirms 0.04% taker, both legs.

Because actual taker is 0.04% (not 0.05%) and retail maker is +0.02% (not a rebate), the
per-leg fee improvement is **0.02%** (retail) rather than the brief's 0.07%. The brief's
optimistic rebate case (improvement 0.06%/leg) is reported as a sensitivity (`_rebate` rows).
Slippage add-back, not the fee delta, is the dominant lever in every scenario.

**Validity caveat (EXP-005 §2a, inherited).** Absolute WR / net are retroactive-code figures
(M47 live only from 2026-06-25); modelled fills via `tick_aggregates`; single 30-day window
(2026-05-30 → 2026-06-29). Relative rankings are trustworthy; absolute dollar magnitudes are
indicative. The target cohort straddles zero by ~$15-30 — within the noise band of a single
window, not a robust signal.

## 3. Analysis results

### 3.1 Baseline cohorts (verifies EXP-006)

| Cohort | n | WR | net PnL | gross-ex-slip | slippage | fees | funding | exit mix (TP/TS/SL) |
|---|---|---|---|---|---|---|---|---|
| Full tier1 | 240 | 28.75% | −$235.20 | −$20.94 | $170.85 | $45.56 | +$2.16 | 21 / 188 / 31 |
| Target (tier1 ∩ trending) | 112 | 31.25% | −$74.42 | +$26.72 | $79.54 | $21.21 | −$0.39 | 14 / 86 / 12 |

Full-tier1 figures reconcile exactly with EXP-006 (n=240, WR 28.8%, net −$235.20). Target
gross-ex-slippage +$26.72 = $22.21 (trending_down) + $4.51 (trending_up), matching EXP-006.

### 3.2 Slippage-reduction scenarios

S0 baseline; S1 50% slip add-back; S2 100% slip add-back; S3 entry-only maker
(50% slip add-back + entry-leg fee credit); S4 both-leg maker (100% slip add-back + both-leg
fee credit). `_retail` = maker +0.02% (improvement 0.02%/leg); `_rebate` = brief's maker
−0.02% (improvement 0.06%/leg).

Target cohort (n=112):

| Scenario | net PnL | WR | PF | avg net/trade | net-positive? |
|---|---|---|---|---|---|
| S0 baseline | −$74.42 | 31.25% | 0.53 | −$0.66 | no |
| S1 (50% slip) | −$34.65 | 35.71% | 0.73 | −$0.31 | no |
| S2 (100% slip) | +$5.12 | 41.96% | 1.05 | +$0.05 | yes (barely) |
| S3 retail (entry maker) | −$29.35 | 36.61% | 0.77 | −$0.26 | no |
| S4 retail (both maker) | +$15.72 | 42.86% | 1.16 | +$0.14 | yes |
| S3 rebate (entry maker, VIP) | −$18.74 | 38.39% | 0.84 | −$0.17 | no |
| S4 rebate (both maker, VIP) | +$36.93 | 50.89% | 1.42 | +$0.33 | yes |

Full tier1 (n=240) reference:

| Scenario | net PnL | WR | PF | net-positive? |
|---|---|---|---|---|
| S0 | −$235.20 | 28.75% | 0.36 | no |
| S2 (100% slip) | −$64.35 | 40.42% | 0.75 | no |
| S3 retail | −$138.37 | 34.17% | 0.54 | no |
| S4 retail | −$41.57 | 40.83% | 0.83 | no |
| S4 rebate | +$3.99 | 47.50% | 1.02 | yes (only under VIP rebate) |

Read: on the target cohort, net-positive requires **S2 or S4** (full slippage removal). S3
(entry-only maker, the achievable change) is negative under both fee assumptions. Full tier1
never reaches positive except under the optimistic both-leg + VIP-rebate combination.

### 3.3 Missed-fill penalty

Maker entry can miss when price runs in the signal direction before the resting order fills.
TP hits are fast (median 8.2 min, EXP-005 §3.1) — the most likely to miss. Penalty removes the
N highest-net TP trades (worst case for the thesis: the misses are the winners). Round down.

Target cohort, P1 = 20% TP-miss (2 of 14 removed), P2 = 50% (7 of 14 removed):

| Scenario | P1 (20% miss) net | P1 pos? | P2 (50% miss) net | P2 pos? |
|---|---|---|---|---|
| S3 retail | −$41.90 (n=110) | no | −$54.32 (n=105) | no |
| S4 retail | +$2.32 (n=110) | yes | −$12.13 (n=105) | no |
| S3 rebate | −$31.49 (n=110) | no | −$44.39 (n=105) | no |
| S4 rebate | +$23.14 (n=110) | yes | +$7.72 (n=105) | yes |

Full tier1: every S3/S4 retail combination stays negative under both penalties; only
S4 rebate dips just under zero (−$18.68 at P1). Read: the only achievable scenario (S3) gets
**worse** with any missed-fill penalty because removing winning TP trades subtracts the
cohort's only positive contributors. Even S4 retail flips negative at a 50% miss rate.

### 3.4 Breakeven slippage reduction (target cohort)

Solve `net(X) = grossPnl + X·slip − fees + funding = 0` with `net(0) = −$74.42`, slip = $79.54:

- `X = 74.42 / 79.54 = 93.57%` of total slippage must be recovered.
- Absolute: **$74.42** of the $79.54 modelled slippage.
- Achievable via maker entry alone? **No.** Entry maker recovers only the entry leg
  (~50% of slippage ≈ $39.77). 93.57% recovery needs the exit leg too, which is structurally
  taker for 98/112 exits (see §3.6). At 100% removal the cohort is only +$5.12 — a razor-thin
  margin that any missed fill or calibration drift erases.

### 3.5 Per-regime detail (target cohort)

| Sub-cohort | n | GXS | slip | S0 net | S3 retail net | S3 rebate net | S4 retail net | exit mix (TP/TS/SL) |
|---|---|---|---|---|---|---|---|---|
| trending_down × tier1 | 57 | +$22.21 | $39.51 | −$28.64 (WR 36.84%) | −$6.25 (WR 42.11%) | −$0.99 | +$16.14 | 11 / 42 / 4 |
| trending_up × tier1 | 55 | +$4.51 | $40.03 | −$45.79 (WR 25.45%) | −$23.10 (WR 30.91%) | −$17.75 | −$0.42 | 3 / 44 / 8 |

Read: maker entry (S3) makes **neither** sub-cohort net-positive. All of the target cohort's
upside lives in `trending_down`, and only under both-leg maker (S4, +$16.14). `trending_up`
is negative even at S4 retail (−$0.42) and has just **3 TP trades** in 55 — its weak
gross-ex-slippage (+$4.51) cannot survive realistic costs. The "positive" target result is
effectively one regime (trending_down) under an unachievable exit assumption.

### 3.6 Why both-leg maker (S4) is not achievable

The target cohort's exit mix is 14 TP / 86 time-stop / 12 stop-loss. Per the locked
order-policy matrix (`apps/engine/src/execution/const/orderPolicyMatrix.ts`, ADR 0005):

- Row 7: reduce/close/flatten **always `REDUCE_MARKET`** — "a de-risking that fails to fill is
  worse than any slippage." All 86 time-stops and any force-close exit are taker by design.
- Stop-losses are stop-market — taker on trigger. All 12.
- Only the 14 TP exits rest as limit orders that could earn maker treatment.

So **98 of 112 exits (87.5%) cannot be maker.** S4 (both-leg maker, recovering 100% of
slippage) overstates achievable recovery by assuming maker exits on de-risking legs the policy
forbids. The realistically achievable scenario is **S3 (entry-only) plus maker on the 14 TP
exits** — strictly between S3 (−$29.35) and S4 (+$15.72), but far closer to S3 because TP
exits are 14/112 of the book. It does not cross zero.

## 4. Verdict — INCONCLUSIVE

The slippage thesis is directionally confirmed (slippage is 81% of the loss, EXP-005; full
removal flips the target cohort to +$5.12), and the breakeven (93.6% of slippage) is
mechanically within 100%. But **net-positive is not reachable by the achievable change**:

- Entry-only maker (S3), the only change the execution policy permits without rewriting the
  exit side, leaves the target cohort at **−$29.35** with zero missed fills and worse with any
  penalty.
- The net-positive scenarios (S2, S4) require recovering exit-leg slippage, which means maker
  exits on time-stops and stop-losses — forbidden by ADR 0005 row 7.
- Even granting both-leg maker, the result is fragile: +$15.72 (retail, no penalty) → +$2.32
  at a 20% TP-miss → −$12.13 at 50%. It rests on ~14 TP trades in a single 30-day window and
  is dominated by one regime (trending_down).

Not REJECTED (S4 no-penalty is positive, so zero-slippage does not leave the book negative).
Not SUPPORTED (the achievable lever S3 is negative, and the positive scenarios depend on
both-leg maker exits that the locked policy forbids plus near-zero missed fills on fast TP
signals). **INCONCLUSIVE.**

## 5. What this rules out

- **Do not expect entry-only maker to make the momentum book profitable.** S3 is net-negative
  on the best cohort (−$29.35) and on full tier1 (−$138.37), before any missed-fill penalty.
- **Do not model "maker entry" as recovering 100% of slippage.** Entry maker recovers ~the
  entry leg only (~50%); 87.5% of target-cohort exits are policy-forced takers. Any future
  proposal quoting the S2/S4 numbers as the maker-entry outcome is miscalibrated.
- **Do not rely on the brief's maker −0.02% rebate.** That is a VIP perk; retail Binance
  USDT-M maker is +0.02%. At restricted live size (tier-1, $500-1000) the rebate does not
  apply, and the fee delta is second-order to slippage regardless.
- **`trending_up × tier1` is not salvageable by execution changes.** Negative even at S4 retail
  with only 3 TP trades in 55; its gross-ex-slippage edge (+$4.51) is noise-thin.

## 6. Implementation note

- **Where entry orders are placed.** `ExecutionService` builds the order plan; `OrderPolicyRouter`
  selects a policy from the pure matrix in `orderPolicyMatrix.ts`; `ExchangeOrderSubmitter`
  submits. Momentum OPEN/ADD rows resolve to `MARKETABLE_LIMIT_IOC` (taker) via
  `buildMomentumIocRows()`. The matrix comment is explicit: "Momentum always takes liquidity by
  definition."
- **Param vs code.** This is a **code change to a locked decision (ADR 0005 §1)**, not a param.
  There is no `entry_order_type` param and no maker-fee const. Switching momentum entries to
  `POST_ONLY_MAKER` edits the locked matrix, which live and backtest both import (contract C5) —
  it must go through `bot-shared-maintainer` / architect, not config. The `POST_ONLY_MAKER` enum
  already exists (used by mean-reversion), so the plumbing is present.
- **Slot-blocking risk (flag).** A resting post-only entry that never fills opens no position,
  but the risk-gate reservation / slot may be held while the order rests, blocking other tier-1
  candidates (live starts at 1 position). On a fast momentum signal the maker can sit unfilled
  through the entire signal window, consuming the only slot and producing zero trades. The
  backtest already exposes `missedLimitFillCount` and `lowFidelityTradeCount`, so a fill model
  exists for mean-reversion makers — but its fidelity on **fast momentum movers** (median TP
  8.2 min) is unvalidated and is precisely the §3.3 unknown.
- **Exits are already limit/stop, and must stay taker on de-risking.** TP rests as limit (maker
  on the 14 TP exits), SL is stop-market, and reduce/close/flatten is `REDUCE_MARKET` (ADR 0005
  row 7). The change is entry-only by construction; the exit side cannot be moved to maker
  without violating the de-risking-fills-first invariant.

## 7. Recommended next experiment

**EXP-008 — entry-only maker with an explicit fast-mover fill model and slot-hold accounting.**
Before any code change, run a backtest variant that (a) sets momentum tier-1 entries to
`POST_ONLY_MAKER`, (b) models fill probability as a function of post-entry price path
(unfilled when price runs ≥ entry-leg slippage in the signal direction within the bar), and
(c) charges the slot-hold opportunity cost (trades skipped because a resting maker held the
only slot). The §3.3 sensitivity shows the verdict turns entirely on the TP-miss rate; an
empirical fill model on `tick_aggregates` would replace the 20%/50% guesses. Pair with the
EXP-006 tier1 gate, since entry-only maker is at best a marginal add-on to an already
net-negative book — not a standalone fix.
