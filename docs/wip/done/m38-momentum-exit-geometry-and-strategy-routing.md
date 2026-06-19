# M38 candidate — Momentum exit geometry repair + V3 hybrid promotion

**Written:** 2026-06-15  
**Source:** Live 24-hour trade analysis (positions closed 2026-06-14 23:50 → 2026-06-15 16:25 UTC)  
**Status:** Implemented — recommendations landed in **M38** (DONE). Archived for forensics/traceability.

---

## Summary

31 closed positions in 24 hours. Net PnL: **−$57.93**. Win rate: **5/31 (16.1%)**.  
Three compounding problems are responsible. M37 fixes one of them (the mislabeled exit label).
The other two are unscoped and form the core of M38.

---

## Problem 1 — TP geometry is stale at fill time (root cause, not yet fixed by M37)

### What M37 fixes

The `tpEligible` guard (D3.1) prevents a position from being labeled `take_profit` when the entry
fill landed at or past the TP level. It stops the **symptom**: 14 of 31 positions today exited
in under 2 seconds labeled `take_profit` with negative PnL (just fees).

### What M37 does NOT fix

The underlying geometry remains broken. The momentum strategy computes:

```
takeProfitPrice = reconstructReferencePrice(event) + ATR × 2.0   (for LONG)
stopLossPrice   = vwapSession
```

`reconstructReferencePrice` = `VWAP × (1 + vwapDeviationPct / 100)` — the candle close **at
signal time**. By the time the paper fill executes, the mark price may have moved significantly
beyond that reference.

**Concrete example from today (AAVE, position 45):**

| | Value |
|--|--|
| Signal-time reference price | `72.885 × 1.016404 = 74.081` |
| Actual fill price (mark at fill) | `77.416` (4.5% above reference) |
| TP computed from reference | `74.081 + 2 × 0.520 = 75.121` |
| TP relative to actual fill | **−2.97% — below entry for a LONG** |

With `tpEligible` deployed: the position will NOT fake-exit, but the TP at 75.121 is
**structurally unreachable** for a LONG (price would need to drop to 75.12, which hits the SL
path, not the TP path). The position is locked into running to SL (VWAP = 72.885, −5.9% from fill)
or the 15-minute time-stop. Both outcomes produce a loss. The tpEligible fix improves the
**label**; it does not improve the **trade geometry**.

### The same problem inverted for shorts

Position 25 (ALLO SHORT, −$0.26): signal fired at −2.82% deviation. By fill time price had
dropped further. TP = `referencePrice − 2×ATR = 0.33310`, but fill = `0.32278`. For a SHORT,
TP fires when `markPrice ≤ TP`. Since `0.32278 ≤ 0.33310` from the start, the TP fires
immediately. Same root cause, opposite direction.

### Affected positions today

| Symptom | Count | Mechanism |
|---------|-------|-----------|
| Instant fake take_profit (< 2 s) | 14 | fill past TP, old code fires immediately |
| Time-stop with unreachable TP | ~6 | fill past TP, new tpEligible code suppresses; position bleeds to time-stop |
| Total with bad TP geometry | ~20 of 31 | |

### Required fix (M38 scope)

**Rebase TP on the actual fill price**, not the signal-time reference price.

For momentum LONG:
```
takeProfitPrice = fillPrice + ATR × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER
```

For momentum SHORT:
```
takeProfitPrice = fillPrice − ATR × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER
```

The SL (`vwapSession`) remains anchored to VWAP (a structural level, not a fill-relative one —
this is intentional and correct).

This requires the execution layer to communicate the actual fill price back into the position's
arm geometry. Today the TP/SL are computed in `buildMomentumExit` (strategy layer, pre-fill) and
stored on the position at open time. The arm call in `ExecutionService` reads them directly from
`event.clampedExit`. The fix must either:

- Recompute exit geometry post-fill inside `ExecutionService` before arming the monitor, OR
- Pass the fill price into `clampedExit` as a rebasing input

The stop-loss (`vwapSession`) should NOT be rebased — VWAP is a structural price level.
Only TP moves. This preserves the existing risk budget (SL distance is still VWAP, same R).

---

## Problem 2 — No entry rejection when fill drifts too far from signal price

### Evidence

8 of 10 time-stop losses had `mfe_pct = 0.00` — price **never ticked in favour** after entry.
This means the entry happened after the signal move was already exhausted. The bot enters at the
tail of the spike, not the body.

Today's gap between signal reference price and actual fill price:

| Symbol | Reference price | Fill price | Drift |
|--------|----------------|------------|-------|
| AAVE   | 74.081         | 77.416     | +4.5% |
| ALLO (short) | 0.33970 | 0.32278 | −4.97% |
| XLM    | estimated ~0.217 | 0.22620 | +4.4% |
| TAO (short) | ~253.3 | 264.892 | +4.6% |

These entries are chasing a move that happened 1–3+ candles earlier. Price has already mean-
reverted or the momentum impulse is spent by the time the fill executes.

### Required fix (M38 scope)

Add a **max signal-to-fill drift check** in the execution path. If the mark price at fill time
deviates more than a configurable threshold from `reconstructReferencePrice(event)`, reject the
open intent and log it as `SIGNAL_STALE`.

Suggested initial threshold: **2.0% drift** (tunable param, same pattern as existing risk params).
This would have rejected at least 4 of today's positions with the worst geometry. Combined with
Problem 1's fix, it closes the "late entry with bad TP" scenario from both sides.

This check belongs in the execution gate or the position-open path, not the strategy layer, to
keep strategies pure. Equivalent to a max-slippage guard applied at fill-acceptance time.

---

## Problem 3 — V2 momentum routes catalyst_risk signals to the wrong side

### Evidence

Of today's 31 positions, **24 were `catalyst_risk` flow type**. Their collective PnL:

| | |
|--|--|
| catalyst_risk positions | 24 |
| catalyst_risk winners | 4 (FARTCOIN, ADA, FET, XPL) |
| catalyst_risk net PnL | ≈ −$41 of the total −$58 |
| Largest single loss | TAO SHORT −$23.73 (price rallied 4.7% back after liquidation dump) |

The `catalyst_risk` flow type is classified as informed-flow / liquidation-cascade events. V2
momentum **follows** these (long when price is above VWAP, short when below), but the empirical
pattern is strong mean-reversion: the cascade exhausts, price snaps back. The bot is following
the cascade into the reversal.

The most damaging position illustrates this: TAO was 4.27% below VWAP (deep liquidation dump),
V2 shorted expecting continuation, price rallied 4.7% back — a textbook reversion trade taken
from the wrong side.

### V3 hybrid (already built) handles this correctly

V3 routes as follows:

```
forced_exhaustion → mean-reversion (fade)
trend_initiation  → momentum (follow)
catalyst_risk     → SKIP
market_beta       → SKIP
low_quality_noise → SKIP
```

V3's decision to **skip `catalyst_risk`** rather than trade it is the conservative answer. It
does not bet on fading — it simply abstains. Under V3 today:

| Scenario | Net PnL |
|---------|---------|
| V2 actual (trades all flow types as momentum) | −$57.93 |
| V3 counterfactual (skips catalyst_risk + market_beta) | ≈ −$16.92 (only 7 trend_initiation positions) |

Switching to V3 would have cut today's losses by ~70% by doing nothing on catalyst_risk. The
remaining −$17 on trend_initiation signals is a smaller, separate problem (and with n=6 is
below the noise floor for a verdict).

### A future V4 could go further (out of scope for M38)

The next evolution after V3 would be a V4 that routes `catalyst_risk` to mean-reversion (fade)
rather than skip. That requires evidence from the repaired M37 shadow simulator before it can be
designed. M38 should not implement V4 — V3 promotion is the right first step.

---

## What the data shows about winners vs losers

The 5 winning positions shared clear characteristics:

| Symbol | vwap_dev | signal_score | flow_type | hold | PnL |
|--------|----------|-------------|-----------|------|-----|
| FARTCOIN | 2.69% | 75.0 | catalyst_risk | 8.7s | +$7.43 |
| ADA | 3.18% | 80.3 | catalyst_risk | 11.1 min | +$3.46 |
| FET | 2.02% | 66.2 | catalyst_risk | 5.9 min | +$1.53 |
| NEAR | 1.75% | 62.8 | catalyst_risk | 15 min (time-stop) | +$1.78 |
| XPL | 1.39% | 64.4 | catalyst_risk | 2.3 min | +$2.22 |

Loser average: signal_score ≈ 52, vwap_dev ≈ 1.2%  
Winner average: signal_score ≈ 70, vwap_dev ≈ 2.2%

This suggests that if V2 is retained for catalyst_risk, a signal-score filter (e.g. ≥ 65) and
a minimum deviation threshold (e.g. ≥ 1.75%) could sharply reduce the losing trades. However,
this is micro-optimisation on a broken measurement instrument — it must wait for M37 data.

---

## Proposed M38 scope

Listed in priority order. All three are prerequisites for any informed strategy switch.

### D1 — Rebase momentum TP on actual fill price

**Files:** `apps/engine/src/execution/service/ExecutionService.ts` (post-fill arm path) +
`apps/engine/src/strategy/strategies/momentumCore.ts` (or a new fill-time recompute util)

**Behaviour change:** `takeProfitPrice` stored on the position and passed to `LocalProtectiveMonitor.arm`
reflects `fillPrice ± ATR × multiplier`, not the pre-fill reference price. SL stays at VWAP.

**Verification:** No position should have `take_profit_price < entry_price` for a LONG or
`take_profit_price > entry_price` for a SHORT after the fix.

### D2 — Signal staleness / max-drift-from-reference gate

**Files:** execution gate or `ExecutionService` open path

**Behaviour change:** If `|markPriceAtFill - reconstructReferencePrice(event)| / referencePrice > max_signal_drift_pct`
(suggested default: 2.0%), reject the open intent with reason `SIGNAL_STALE`. Log and count.

**Param:** `max_signal_drift_pct` — new risk param, same config structure as existing params.

**Verification:** `mfe_pct > 0` should improve for the surviving set; `SIGNAL_STALE` rejections
should absorb the worst-drift entries.

### D3 — Promote V3 hybrid as the active strategy

**Prerequisite:** M37 must be complete (shadow fill simulator producing real PnL, comparison
layer reading `shadow_decisions`) so the V3 vs V2 comparison is data-backed.

**Promotion path:** ADR 0019 promotion gate. V3 (`strategy_versions.id = 4`) changes status from
`shadow` to `active`; V2 (`id = 3`) changes to `shadow`. No new code — V3 is already implemented
and has been shadow-running alongside V2 since 2026-05-30.

**Expected effect:** catalyst_risk and market_beta signals → SKIP. Trade frequency drops
significantly. Only `trend_initiation` and `forced_exhaustion` signals trade.

**Open question for the milestone brief:** are the `trend_initiation` losses today (6/6 negative,
net −$16.92) a momentum-strategy problem or a signal-quality problem at those entry geometries?
This is the key question M37's repaired instruments must answer before M38 closes.

---

## What is explicitly NOT in M38 scope

- A V4 strategy that fades `catalyst_risk` — requires M37 shadow data; separate milestone
- Changing `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER` (2.0) or `time_stop_minutes` (15) — noise floor
  too low; wait for M37 measurement
- Anything touching the mean-reversion exit geometry (`meanReversionCore.ts`) — that path has the
  `isDegenerateReversionGeometry` guard already and was not a source of losses today
- Signal-score or deviation-threshold filters on catalyst_risk (micro-optimisation; evaluate after
  M37 data with proper sample size)

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| M37 complete (shadow fills, comparison layer, backtest gate) | In progress |
| tpEligible guard deployed (M37 D3.1) | Code ready, container not rebuilt |
| V3 shadow data since 2026-05-30 | Exists, ~2,442 rows, but hollow fills (M37 repairs this) |
| ADR 0019 promotion gate criteria | Needs to be re-read before D3 can be scoped |
