# Slot Model Analysis & Correlated Leg Gaps

**Date:** 2026-06-05  
**Status:** WIP — open questions, no implementation decision yet

---

## Context

Observed during soak analysis (2026-06-04): the bot sat flat for the entire post-halt session despite 13 concurrent signals firing at 15:10. All were rejected — 9 at strategy level, 4 at the risk gate. This prompted a deeper look at what the slot model actually does and what it can't do.

---

## What the slot model is

Three concurrent position slots, each with a defined purpose:

```
Slot A ──► idiosyncratic coins only (fill first)
Slot B ──► idiosyncratic coins only (fill second)
Slot C ──► BTC-correlated direction OR 3rd idiosyncratic overflow
```

**Idiosyncrasy score** drives A/B eligibility:

```
score = 1 − |BTC 5m move %| / |coin 5m move %|   clamped to [0, 1]
```

- `> 0.5` → coin is moving on its own, qualifies for A or B  
- `< 0.3` → coin is tracking BTC, rejected with `no_eligible_slot`  
- Between 0.3–0.5 → borderline (DOGE at 0.295, ADA at 0.352 on 2026-06-04)

**BTC itself always scores 0** (self-referential formula). BTC can never get an idiosyncratic slot. ETH can score above 0.5 on ETH-specific events but is usually correlated.

---

## Current live state

| Config | Value |
|---|---|
| `MAX_OPEN_POSITIONS` | 1 |
| `MAX_EXPOSURE_PER_COIN_USDT` | $100 |

With `MAX_OPEN_POSITIONS = 1`, only slot A is reachable. B and C are architecturally present but operationally unreachable. The correlated leg for slot C **is not yet implemented** at the strategy level — nothing emits `correlation_mode = correlated`, so slot C never receives a correlated assignment.

---

## The structural gap

The universe is ranked by 24h volume. Top-volume coins (tier-1: top 50) are heavily BTC-correlated because large-cap algo bots auto-copy BTC moves. During a BTC trending session:

- Most tier-1 coins fail the idiosyncrasy score → `no_eligible_slot`
- Tier-2/3 coins may pass but have thinner books and higher slippage
- **Slot C is empty** because the correlated strategy leg doesn't exist

Result: on BTC trend days the bot sits completely flat. This is a real opportunity cost — the strongest, cleanest directional moves in crypto go untraded.

---

## Why slot C was deferred

BTC directional trading is a fundamentally different problem:
- No clear snap-back thesis (mean-reversion doesn't apply to trend-driven moves)
- Stop placement is harder — no reversion level to anchor to
- Consecutive losses cluster in choppy macro conditions
- Needs different signal source, different exit logic, different sizing model

The risk of building it incorrectly is muddying the idiosyncratic edge and making P&L impossible to attribute.

---

## What building the correlated leg would actually need

1. **BTC regime classifier** — not a per-bar signal but a regime state: `trending_up`, `trending_down`, `ranging`. Must be stable enough to avoid chasing every 1% move.
2. **New flow_type values** — existing types (`trend_initiation`, `catalyst_risk`, `forced_exhaustion`) are coin-specific. Correlated signals need a market-wide directional classification.
3. **Separate entry/exit logic for slot C** — trend-following exits (trailing stop, momentum fade) rather than mean-reversion exits (time stop, reversion target).
4. **Adjusted risk sizing** — correlated positions carry higher tail risk on sudden reversals; the sizer needs to treat them differently.
5. **Independent backtesting** — cannot share the same replay framework as the idiosyncratic leg without contaminating results.

---

## Alternative: separate BTC-only bot

**Pros:**
- Completely isolated risk, P&L, and edge attribution
- Can use a different framework optimized for trending instruments
- No contamination of idiosyncratic soak data

**Cons:**
- Operational complexity (second engine, second DB, second monitoring)
- BTC is the most traded, most watched asset in crypto — edge is hardest to find and fastest to decay
- A 5m VWAP strategy on BTC specifically fights the entire market at maximum liquidity

**Conclusion:** Extending slot C in the current bot is the more natural path if the correlated strategy can be designed cleanly. A separate bot makes sense only if the strategy is fundamentally incompatible with the existing risk framework.

---

## Open questions before any work starts

1. Is the idiosyncratic leg producing edge? Zero trades have closed in the current soak — cannot validate the existing model yet. This is the prerequisite.
2. What is the regime classifier? "BTC is trending" needs a precise, testable definition before writing any code.
3. Does the $100 per-coin cap + 1-position limit need to be relaxed first? With the current constraints, even a working correlated leg could never open.

---

## Related

- `docs/architecture/adr/ADR-0004.md` — slot model design (§4), correlated position rules
- `docs/tech-debt.md` — no existing entry for this gap; consider adding as MEDIUM
- `apps/engine/src/risk/service/SlotManager.ts` — slot assignment logic
- `apps/engine/src/market-data/indicator/computeIdiosyncrasyScore.ts` — score formula
