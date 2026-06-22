# Stop Loss and Take Profit — Momentum Strategy (v2)

> Source: `apps/engine/src/strategy/strategies/momentumCore.ts`  
> Constants: `apps/engine/src/strategy/const/strategyConsts.ts`  
> Entry helpers: `apps/engine/src/strategy/utils/entryHelpers.ts`

---

## Glossary

| Abbreviation | Full name | What it represents |
|---|---|---|
| **VWAP** | Volume-Weighted Average Price | The average price of all trades in the current session (00:00 UTC → now), weighted by trade volume. It is the "session fair value" anchor. |
| **VWAP Session** (`vwapSession`) | Session VWAP at trigger time | The concrete VWAP value stamped on the trigger bar's market event. |
| **VWAP Deviation %** (`vwapDeviationPct`) | VWAP deviation percentage | How many percent the closing price of the trigger bar has moved away from `vwapSession`. The detector only fires when this exceeds a minimum threshold. |
| **ATR-14** (`atr14`) | Average True Range — 14 bars | The average of the True Range over the last 14 × 5-minute bars (= 70 minutes). True Range is `max(high−low, |high−prevClose|, |low−prevClose|)`. ATR-14 captures the typical price swing per bar at the moment of the signal. |
| **SL** | Stop Loss | The price at which the position is automatically closed at a loss to limit downside. |
| **TP** | Take Profit | The price target at which the position is closed at a profit. |
| **RR** | Reward-to-Risk ratio | `TP distance / SL distance`. An RR of 1.0 means the potential gain equals the potential loss. An RR of 0.5 means you risk 2 to make 1. |
| **Reference Price** | Signal-bar close (reconstructed) | The closing price of the 5-minute bar that triggered the signal, reconstructed as `vwapSession × (1 + vwapDeviationPct / 100)`. Used as the proposed entry price until the actual fill lands. |
| **Time Stop** | Maximum hold duration | A hard deadline: if neither TP nor SL is hit, the position is force-closed at this timestamp. |

---

## Formula 1 — Reference Price (proposed entry)

```
referencePrice = vwapSession × (1 + vwapDeviationPct / 100)
```

**Why:** The detector fires on the bar where price closed X% away from VWAP. This formula simply reconstructs that closing price from the two values already on the event, without storing the close price separately.

**Example:** VWAP = 10,000 USDT, deviation = +2.5% → referencePrice = 10,250 USDT (a long-bias event; price closed above session fair value by 2.5%).

---

## Formula 2 — Take Profit (TP)

```
atrTarget = atr14 × 2.0

For LONG  (price spiked above VWAP, we follow the move UP):
    TP = referencePrice + atrTarget

For SHORT (price dropped below VWAP, we follow the move DOWN):
    TP = referencePrice − atrTarget
```

**Constant:** `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0` (locked in `strategyConsts.ts`).

**Re-anchor after fill (ADR 0045 §D1):** The signal is computed before the fill price is known. Once the actual fill price arrives, the execution layer shifts TP by the same `atrTarget` value relative to the fill — not the reference. The `atrDistance` field carries this value verbatim; it is never recomputed downstream.

**Example:** Reference = 10,250 USDT, ATR-14 = 80 USDT → atrTarget = 160 USDT → TP = 10,410 USDT (long). Distance from entry ≈ 1.6%.

---

## Formula 3 — Stop Loss (SL)

```
SL = vwapSession
```

The SL is placed at the session VWAP — the same value used to measure the deviation that triggered the signal.

**Logic:** The momentum thesis is "the price has moved away from fair value and will continue." If price returns all the way back to VWAP, the thesis is invalidated and the position is closed with a loss.

**Type:** `StopTypeEnum.STRUCTURAL` — a price-level stop, not an ATR-distance stop.

**Locked:** The SL is computed once at signal time and never moved or rebased (ADR 0045 §D1).

**Example (long):** VWAP = 10,000 USDT, entry at 10,250 USDT → SL = 10,000 USDT. SL distance = 250 USDT ≈ 2.4%.

---

## Formula 4 — Time Stop

```
timeStopAtMs = signalBarCloseTimeMs + time_stop_minutes × 60,000
```

- `signalBarCloseTimeMs`: the opening time of the bar immediately after the trigger bar (deterministic clock, no wall-clock calls).
- `time_stop_minutes`: configured per strategy version in the `strategy_versions.params` JSON column.
- If neither TP nor SL is reached within this window, the position is force-closed at the market price.

---

## Reward-to-Risk (RR) at entry

```
SL distance = referencePrice − vwapSession   (for long)
            = vwapDeviationPct / 100 × vwapSession

TP distance = atr14 × 2.0

RR = TP distance / SL distance
   = (atr14 × 2.0) / (vwapDeviationPct / 100 × vwapSession)
```

### Measured values from 14-day soak (47 closed non-catalyst trades)

| Tier | Side | Avg SL distance | Avg TP distance | Structural RR |
|------|------|----------------|----------------|---------------|
| Tier 1 (BTC, ETH, BNB, SOL) | Long | 2.45% | 1.39% | **0.57** |
| Tier 1 | Short | 2.40% | 1.61% | **0.67** |
| Tier 2 (all other symbols) | Long | 2.92% | 1.38% | **0.47** |
| Tier 2 | Short | 4.77% | 1.61% | **0.34** |

**All cohorts are below RR 1.0.**

### Why this happens structurally

The VWAP deviation is the **trigger condition** and also the **SL width**. The detector only fires when `vwapDeviationPct` crosses a minimum threshold. Therefore:

- Every entry already has a structurally wide SL (at minimum = the trigger threshold).
- ATR-14 on 5-minute bars is a local measure, typically 0.7–0.8% of price during soak sessions.
- TP at 2 × ATR reaches only ~1.4–1.6%, while SL reaches 2.4–4.8%.

Widening the ATR multiplier does not fix this: a larger multiplier makes the TP target harder to reach in price terms, which reduces win rate rather than improving RR in expectancy terms.

### Required win rate at each RR level

```
breakeven win rate = 1 / (1 + RR)
```

| RR | Required win rate to break even |
|----|---------------------------------|
| 0.34 (tier2 short) | 75.0% |
| 0.47 (tier2 long)  | 68.1% |
| 0.57 (tier1 long)  | 63.7% |
| 0.67 (tier1 short) | 59.9% |
| 1.0  (breakeven geometry) | 50.0% |

**Observed post-route win rate (catalyst_risk excluded): 29.8%.** Required breakeven RR at 29.8% win rate: **2.36**.

---

## Round-trip cost floors

These are deducted from every trade regardless of outcome:

| Component | Rate | Source |
|-----------|------|--------|
| Taker fee (entry leg) | 0.04% | `RISK_TAKER_FEE_RATE` in `riskConsts.ts` |
| Taker fee (exit leg) | 0.04% | same |
| Slippage tier 1 (entry) | 0.15% | `MAX_SLIPPAGE_TIER_PCT` in `executionConsts.ts` |
| Slippage tier 1 (exit) | 0.15% | same |
| **Total round-trip tier 1** | **0.38%** | 2 × 0.04% + 2 × 0.15% |
| Slippage tier 2 (entry) | 0.40% | `MAX_SLIPPAGE_TIER_PCT` |
| Slippage tier 2 (exit) | 0.40% | same |
| **Total round-trip tier 2** | **0.88%** | 2 × 0.04% + 2 × 0.40% |

Against a TP of ~1.4–1.6%, tier-2 costs consume 55–63% of a winning trade's profit.

---

## Open questions (as of M43 investigation)

| # | Question | Status |
|---|----------|--------|
| D2.1 | Should a minimum-TP cost-floor guard be added (`TP < cost_floor + margin → skip`)? | Under review — M43 D2 |
| D2.2 | Should a pre-entry minimum-RR gate be added (`TP / SL < threshold → skip`)? | Under review — M43 D2 |
| ADR | Would an ATR-based SL instead of VWAP structural stop fix the geometry? | Requires new ADR; deferred beyond M43 |
