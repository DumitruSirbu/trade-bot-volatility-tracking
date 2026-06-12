# Shadow Fill Diagnosis: M26 Timing Flaw

**Date:** 2026-06-09  
**Status:** DONE — fixed in **M26** (`docs/plans/archive/M26-shadow-counterfactual-fill-wiring.md`). Archived under `docs/wip/done/`.  
**Related:** ADR 0029, M26, `ShadowStrategyOrchestratorService`, `missedFillDetector`

---

## What the data shows

As of 2026-06-09, the `shadow_decisions` table contains 4,890 rows. Breakdown:

| Category | Count | Expected? |
|---|---|---|
| `action=skip` (strategy said no trade) | 3,699 | Yes — correct, no fill simulated |
| `action=open`, gate blocked | 59 | Yes — correct, no fill simulated |
| `action=open`, gate allowed, no tick data (v3 only) | 112 | Yes — M26 A4 conservative decline |
| `action=open`, `missed=true`, `missedReason=null` | 1,018 | **No — see below** |
| `action=open`, `missed=false` | 2 | Extremely low (0.2%) |

Of 1,020 rows where a fill was simulated, **1,018 are missed and none have `missedReason` set**.

---

## Root cause 1: Pre-M26 engine ran for 10 days

All 1,018 missed fills (and the 2 successful ones from today) were written by the **May 31 engine image**, which predates M24–M28 entirely.

The pre-M26 `simulateShadowFill` hardcoded `ticks: []` in the `IFillRequest`. The shared `isMissedFill` function has an explicit short-circuit:

```typescript
if (ticks.length === 0) {
    return true; // no ticks → cannot confirm fill → missed
}
```

Result: every open shadow decision for 10 days (May 30 – June 9 morning) was unconditionally missed. These rows are historical artifacts; they cannot be corrected retroactively.

**M26 fix was never deployed independently.** The intermediate M26 image ran only briefly on June 9 (between an unknown restart and the M28 deploy at 17:48 UTC). It produced 53 simulated fills (51 missed, 2 filled). M27 was never deployed as a standalone image — it shipped only inside M28. That is why `missedReason` is null on all rows, including those from the M26 window.

---

## Root cause 2: M26 uses the wrong bar for fill timing

Even with real ticks flowing, the M26 design has a structural mismatch that causes ~96% misses.

### What M26 does

```
limitPrice      = lastSignalBarTick.close      ← proxy for "next-bar open"
signalBarOpenMs = event.entryCandleOpenTime    ← signal bar's open time
ticks           = tick_aggregates [barOpen, barOpen+5m)   ← signal bar's ticks
orderTimeoutMs  = 2,000 ms  (MARKETABLE_LIMIT_IOC)
```

### What the miss detector checks

```typescript
const timeoutEndMs = barOpenMs + orderTimeoutMs; // barOpenMs + 2s
const ticksWithinWindow = ticks.filter(t => t.ts.getTime() >= barOpenMs
                                         && t.ts.getTime() <= timeoutEndMs);
```

Tick aggregates are **5-second intervals**. Only the very first tick of the signal bar (`ts = barOpenMs`) falls inside the 2-second window. All subsequent ticks are at `barOpenMs + 5s`, `barOpenMs + 10s`, etc. — all outside.

### Why this almost always misses

The miss detector reduces to a single question about the signal bar's first and last ticks:

- **LONG**: does `firstTick.low ≤ lastTick.close`?  
  This is true only when the bar trended **up** (close above open region of first tick).
- **SHORT**: does `firstTick.high ≥ lastTick.close`?  
  This is true only when the bar trended **down**.

The shadow strategy fires most often on *against-trend exhaustion* or *momentum* bars — the entry direction is usually aligned with the signal bar's direction, meaning the fill check looks at the bar from the wrong end. The 2 successful fills were bars where the first tick's range happened to cover the last tick's close.

### The conceptual error

The fill is designed to simulate an order placed at the **next-bar open**, but the miss detector is checking whether that price was touched during the **signal bar's first 2 seconds**. These two time windows are 5 minutes apart.

---

## The 2 "filled" rows are correct by accident, not by design

Both `missed=false` rows are for **SAHARA/USDT:USDT LONG**, signal bar **09:45:00–09:50:00 UTC**.

Signal bar tick data:
```
first tick (09:45:00): high=0.01762, low=0.01757  ← the only tick in the 2s window
last tick  (09:49:55): close=0.01818               ← used as limitPrice
```

The fill succeeded because `firstTick.low (0.01757) ≤ limitPrice (0.01818)` — this bar trended strongly **up** (~3.5%), so the signal bar's open was well below the close. A LONG at the close price always touched the opening range.

Stored `entryPrice = 0.01820727` = `0.01818 × (1 + 0.0015)` (Tier 2 slippage applied). This number happens to look correct because the next bar opened almost exactly where the signal bar closed:

```
next bar first tick (09:50:00): high=0.01820, low=0.01815, close=0.01818
```

The limitPrice (0.01818) sits inside the next bar's first tick range. If the correct logic (next-bar ticks) had been used, the fill would also have succeeded and produced the same entryPrice. So the stored value is **accidentally correct** for this particular event.

The data is wrong in the sense that:
- The fill passed the miss detector for the wrong reason (signal-bar direction check, not next-bar entry check)
- For any event where the signal bar closes far away from where the next bar opens (gap, spike, reversal), the same logic would either produce a spurious fill or a spurious miss

These 2 rows should not be treated as evidence that M26 works.

---

## What a correct fix looks like

To simulate a fill at next-bar open, the evidence passed to `HistoricalFillAdapter.simulateFill` should reference the **next bar**, not the signal bar:

```
signalBarOpenMs = event.entryCandleOpenTime + CANDLE_5M_INTERVAL_MS   ← next bar open
ticks           = tick_aggregates [nextBarOpen, nextBarOpen+5m)         ← next bar ticks
limitPrice      = lastSignalBarTick.close                               ← unchanged (proxy)
```

With this change:
- The 2-second timeout window starts at next-bar open
- The first tick of the next bar (`ts = nextBarOpenMs`) is within the window
- For LONG: `nextBarFirstTick.low ≤ limitPrice` (≈ next-bar open) — almost always true for small latency
- Missed fills would represent genuine gaps (e.g., limit never crossed because market gapped through)

This would bring the shadow fill rate close to what a real backtest would produce for IOC entries.

---

## Additional anomaly: v3 has 112 open+gate_allowed rows with no fill

All 112 `action=open, gate_allowed=true, simulated_fill=null` rows belong to **v3 only**. These are M26 A4 declines: no `tick_aggregates` existed for the signal bar, so `nextBarOpenPrice = null` and the open was dropped as a conservative miss (no `simulated_fill` stored at all, unlike a fill with `missed=true`).

This is a separate concern — either v3 fires on symbols/bars that have tick coverage gaps, or there is a write-read timing race between the tick ingestion pipeline and the shadow evaluation.

---

## Decision needed

1. **Fix M26 timing flaw** (load next-bar ticks + use next-bar open time as `signalBarOpenMs`). This is likely a small change but touches `ShadowStrategyOrchestratorService.loadSignalBarEvidence` and the `IFillRequest` construction in `simulateShadowFill`. The fix changes what future rows look like; historical rows remain as-is.

2. **Accept current state as a known limitation** and defer until M29+ scope is clearer. The shadow fills are used for counterfactual comparison, not live gating. A 0% fill rate makes the comparison useless, but the fix is isolated to the shadow path.

3. **Investigate v3 tick coverage gaps** separately (the 112 null-fill rows). May be the same timing issue or a different symbol-specific gap.
