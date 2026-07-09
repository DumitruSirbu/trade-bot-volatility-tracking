# DEC-001 — xmom rebalance cadence: keep 24h, reject sub-cadence (4h + manual triggers)

**Date:** 2026-07-06  
**Decision reason:** User floated moving rebalance cron from 24h → 4h (+ 10–20 min jitter) to speed up soak data volume and go/no-go decision velocity. Quant analysis (EXP-011/012/020) and logic review reveal this defeats the stated goal and introduces unintended costs and statistical hazards.

**Verdict: Keep the 24h cadence. Reject 4h and sub-24h re-ranks. Use the offline candle sweep (EXP-011/012/020 scripts) as the data engine instead. Do not raise top_n as a config-only workaround.**

---

## Why 24h is not negotiable

The xmom strategy's ranking window is **lookback_ms = 86400e3 (24h trailing return)**. The ranking is deterministic and independent of the rebalance tick frequency. The 24h cron exists to:

1. **Separate signal time from execution time**, ensuring strategies are deterministic (no `Date.now()` / `Math.random()` entanglement; backtests reproduce live exactly — ADR 0048 §4).
2. **Define the non-overlapping forward test window** for EXP-011/012/020 (step = hold = 24h, so periods [t, t+24h) and [t+24h, t+48h) are disjoint), removing autocorrelation t-inflation from rolling-window statistical tests (ADR 0048 §5).

It is a **schedule contract**, not a feature. Changing it touches the statistical foundations and the strategy purity boundary.

---

## The proposal (what was asked)

**Question:** "Can we move the rebalance cron from 24h → 4h (+ 10–20 min jitter) to get more trades / faster soak / quicker go-no-go signal?"

**Actual goal (clarified):** Data volume and decision velocity — not a belief that faster is economically better.

**Proposed lever:** Run the 4h ranks more often to emit more orders (top_n unchanged at 3 initially; later floated raising top_n 3→5 for even more fills).

---

## Why 4h (or any sub-24h) rebalance fails the stated goal

### 1. Faster cadence ≠ more trades (defeats stated goal)

The 4h tick runs the ranking logic more often. But the **ranking depends on a 24h trailing-return window**, not the cron tick. Consecutive 4h rebalances see ~83% overlapping input data (6h rolls out of a 24h window per 4h tick). The rankings are ~83% correlated.

**The xmom orchestrator logic (ADR 0048 §6: "hold vs reenter")** says: if a symbol is **still ranked** at the next rebalance, it is in the HOLD state, not a new entry order. Only symbols that **enter the top-3 for the first time, or re-enter after leaving** get orders.

With 83% overlap, most 4h ticks emit **zero new orders** on the unchanged names. To get meaningfully more trades, you would have to shorten `lookback_ms` — an **edge change**, not an operations tweak.

**Cost:** user asked for data volume without changing the signal. A 4h cadence does not deliver that.

---

### 2. Cost math is against 4h and binds tightest at the boundary

**Round-trip friction baseline (EXP-012, EXP-020):** ~73–79 bps/leg (tier-1 taker entry + adverse tier floor + taker exit). This is the binding constraint on whether any trade survives to profitability (EXP-001/002/003 finding: "entry selectivity is the gate, not position geometry").

**6× cadence multiplies boundary cost ~6×:**
- 1 trade/day at 76 bps ≈ acceptable overhead on a +6% signal.
- 6 trades/day at 76 bps = 6× friction; the signal must sustain across all 6 or churn washes out.

**Ranking churn lands on the weakest names:** EXP-011 shows the bottom half of D10 (ranks 7–10) are weak vs D10 median (+4.11% forward). Overlapping windows hit the same D9/D10 boundary and _cycle_ weak names in and out repeatedly.

**Outcome:** 6× the rerank frequency = 6× the boundary-name churn, with near-zero incremental signal. Cost is multiplied, signal is not.

---

### 3. Overlapping-window t-inflation (statistical trap)

EXP-011/012/020 were run on **non-overlapping rebalance windows** (step = hold). This ensures the forward periods [t, t+24h), [t+24h, t+48h), etc. are disjoint, so the t-stat is not inflated by autocorrelation.

**A 4h rebalance with a 24h hold creates 6 overlapping forward windows per single 24h calendar day:**
- Period 1 [t+0h, t+24h)
- Period 2 [t+4h, t+28h)
- Period 3 [t+8h, t+32h)
- ... (6 total)

These windows share 20h of data (83%). The t-stat gains ~√6 ≈ 2.4× spurious boosting from autocorrelation — standard error shrinks even if the signal does not.

**This is a well-documented statistical trap (Barras et al., "The Myth of Positive Alpha").** Faster-cadence backtests with fixed hold windows manufacture false significance.

**Cost:** Any 4h-rebalance backtest would appear "more significant" than the 24h equivalent purely from inflated t-stats, not real edge. You would build confidence in a statistical mirage, then go live and underperform.

---

### 4. The binding constraint is calendar time + regime diversity, not fill count

EXP-020's headline finding (newest data): the xmom signal has **decayed across three chronological sub-windows** (5 weeks → 36.5 days total):

- **w1** (05-31 → 06-10, 11 periods): L-S net +10.69%/pd
- **w2** (06-11 → 06-23, 10 periods): L-S net −1.23%/pd
- **w3** (06-24 → 07-04, 11 periods): L-S net −4.24%/pd (both legs negative)

The net t-stat fell from 2.45 (EXP-011) → 1.83 (EXP-012) → 0.74 (EXP-020). **The signal did not survive a down regime** (the down regime arrived in w3, both legs lost).

You cannot manufacture a down-regime observation by running the same strategy 6× faster inside a single up-ish 5-week window. Live fills accrue at 1 day/day — the same rate the offline candle history grows. If the signal needs regime diversity to validate robustness, that requires **calendar time**, not fill count.

**Offline sweep (EXP-011/012/020 scripts) generates the same regime diversity deterministically and deterministically over accumulated history.** It is the better data engine for answering "does the signal hold across regimes?" and is re-run monthly.

---

### 5. top_n 3→5 is a silent no-op AND a safety regression

**The proposal's unstated second leg:** raise `top_n` from 3→5 to get 5 fills per rebalance instead of 3.

**Why this fails:**
- xmom opens are idiosyncratic (one coin, one side, one slot). The shared contract defines `PositionSlotEnum` = {A, B, C} — exactly 3 slots.
- `SlotManager.assignIdiosyncratic` returns `MAX_POSITIONS_REACHED` for legs 4 and 5 and skips them. The orchestrator cascades through top_n, counting only _approved_ fills. So top_n=5 yields: 3 approved fills (one per slot) + 2 silent rejects, not 5 opens.
- **Making this real requires:**
  1. Expanding the slot namespace (schema migration + `PositionSlotEnum` additions; involves `bot-shared-maintainer` review).
  2. Relaxing `MAX_SAME_DIRECTION_EXPOSURE_USDT` (currently H8 go-live blocker — bounds concentrated one-directional exposure; see `docs/tech-debt.md` M44 B2).

**Trade-off:** You gain "potential for 5 fills" but lose the conservative live-start exposure guard (H8) — a **safety regression** to chase data volume on a signal that is decaying (EXP-020 w3).

**Decision:** Do not adopt top_n as a config-only change. If fill volume is ever needed for a separate, justified reason (M52 force-close/retry calibration, or M44 B5 fill-fidelity study), that is a _different_ business case and earns the architecture work. Not this one.

---

### 6. Jitter is architecturally safe but is deferred, not adopted now

**Jitter + asynchronous scheduling** (adding randomness to the rebalance tick to prevent front-running and liquidity-clustering) is correctly specified in ADR 0048 §4 ("CLOCK_PORT injection into strategies, emitted `nowMs` stays authoritative"). It belongs in the scheduler, outside the strategy purity boundary.

Adding it is a **pure safety win** with no edge cost; backtests are unaffected (the harness drives the event directly).

**Decision:** This is sound architecture and should exist eventually. But it is **not adopted now** because its purpose is anti-front-running, not data volume — which is not the stated need. It is decoupled work and belongs to a separate ADR follow-up or M53c polish.

---

## The chosen path (the decision)

1. **Cadence stays fixed 24h** (`MOMENTUM_REBALANCE_CRON_EXPRESSION`, `01:07 UTC`). No code change.

2. **The data engine for faster xmom go/no-go is the offline candle sweep** — EXP-011/012/020 scripts, reusable and parameterized, re-run monthly:
   - Aggregates 5m candles into the ranking window.
   - Sweeps all rebalance points over 24h+ of accumulated soak.
   - Prices both entry and exit through the real `@bot/shared applyFill` core (tier-floor adverse slippage + 4bps taker).
   - Computes per-period net returns and t-stats, free of autocorrelation.
   - Trivially includes regime diversity (sub-windows) and decay detection.
   - Run for $0 (post-analysis only; no code change, deterministic replay).

   **Timeline:** Rerun monthly (2026-08-06, etc.) to track signal durability. If it stabilizes and regains post-cost significance, use the next month's data to re-evaluate any operational changes (e.g., a live shadow lane for faster feedback).

3. **Do NOT raise top_n without relaxing the H8 guard.** The 3-slot limit and MAX_SAME_DIRECTION_EXPOSURE_USDT are linked conservative gates; loosening one requires architect review of the other.

4. **Jitter (sub-decision):** Architecturally sound; deferred to M53c. It has no cost and should be added eventually, but is orthogonal to this decision.

---

## What this does NOT change

- Strategy signal: `lookback_ms` stays 86400e3 (24h trailing return).
- Backtest reproducibility: strategies remain deterministic, no `Date.now()` / jitter entanglement.
- Statistical discipline: non-overlapping rebalance windows stay the standard; overlapping-cadence backtests are off-limits (they inflate t-stats).
- Live risk surface: no new exposure, no slot-namespace expansion, H8 guard stays active.

---

## Rules out / do not re-propose

The following are **permanently rejected unless new evidence of a separate, justified need emerges:**

- **4h (or any sub-24h) rebalance cadence** — defeats the stated goal (no extra trades due to ranking overlap), multiplies boundary-name churn cost 6×, and introduces t-inflation traps.
- **Manual triggers to force extra rebalances** — same statistical/cost hazards as 4h, plus operational brittleness (human-triggered cadence is noise in backtests).
- **top_n config increase (3→5) without H8 guard relaxation** — silent no-op (slots 4–5 rejected anyway), and decouples the safety gate from its purpose.
- **Overlapping-window backtests as a decision tool** — any test that keeps `lookback_ms = 24h` but changes the rebalance tick to < 24h is corrupted by autocorrelation t-inflation.
- **6h / intraday rebalance of any kind** — EXP-020 (short leg, same methodology) confirms 6h is dead (−0.21%/pd, t=−0.46); no intraday edge exists on xmom.

---

## ADR pointers (context, not modifications)

- **ADR 0048 §4 (CLOCK_PORT, purity boundary):** The scheduler tick and strategy-emitted `nowMs` are separate; jitter belongs in the scheduler.
- **ADR 0048 §5 (non-overlapping test windows):** The 24h hold and 24h lookback enforce step=hold; this ensures disjoint forward periods and avoids autocorrelation t-inflation.
- **ADR 0048 §6 (hold vs reenter):** The xmom orchestrator logic checks if a symbol is still ranked; if so, it is HOLD, not a new order. This is why 4h does not yield 6× the trades.
- **ADR 0050 (fixed-cadence, read-only snapshots):** The fixed 01:07 UTC rebalance tick ensures a stable, analyzable signal source independent of market microstructure.

---

## Monthly review checklist

Every four weeks (or as milestone cycles dictate), re-run EXP-011/012/020 with accumulated `candles` and ask:

- Is the long-leg net t-stat recovering (stable or improving)?
- Do sub-windows show stabilization (variance narrowing, fewer down regimes)?
- Are there new regime windows (e.g., a genuine recovery) worth separate analysis?

**If long-leg t ≥ ~2 across ≥3 disjoint windows including a genuine down cycle**, then:
- Re-evaluate top_n and H8 guard together (architect review).
- Consider a live shadow lane (M53 Route-2 / Route-1 equivalent).
- Propose a cadence change with statistical backing.

**Until then:** cadence stays 24h, data engine is the monthly offline sweep.
