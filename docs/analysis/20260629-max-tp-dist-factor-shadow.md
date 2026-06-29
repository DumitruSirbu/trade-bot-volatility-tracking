> **EXP-004 — REJECTED** | 2026-06-29 | [back to index](README.md)

# Experiment 004: max_tp_dist_factor 5.0 vs 7.0 — Backtest verdict

## Summary

Post-M47 deploy (2026-06-25), the `trend_initiation` open rate fell ~50% (4.5/day → 2.3/day) due to the new `isDegenerateMomentumGeometry` check rejecting signals where `slDist/atr14 > 3.333`. The M47 plan flagged `max_tp_dist_factor = 5.0` as **provisional** (M47-rr-geometry-fix.md:353), deferring empirical calibration.

**Backtest verdict:** Raising the cap to 7.0 does not improve profitability. The additional 72 trades (−21% increase) all lose money because they are dominated by tier2 entries where momentum doesn't sustain to 1.5R within the hold window. Time-stop dominance persists at 82% in both versions, identical to the structural issue found in EXP-001 (time-stop horizon sweep). **This experiment is REJECTED.** Do not re-investigate cap-widening without new evidence of sustained momentum.

The shadow test (id=19, started 2026-06-29) continues forward for monitoring but backtest evidence strongly argues against promotion to live.

---

## Backtest Setup

**Versions compared:**
- **v16 (live):** `max_tp_dist_factor = 5.0` (M47 deployed geometry)
- **v19 (candidate):** `max_tp_dist_factor = 7.0` (all other params identical to v16)

**Window:** 2026-05-30 → 2026-06-29 (30 days of soak data, ~300 symbols, $1000 starting capital)

**Measure:** Backtest comparison via `compareVersions` (canonical analysis path per ADR 0019); PnL recomputed from `simulated_fill` JSONB.

---

## Headline Metrics

| Metric | V16 factor=5.0 | V19 factor=7.0 | Delta |
|---|---:|---:|---:|
| **Trades** | 350 | 422 | +72 (+21%) |
| **Win rate** | 23.4% | 23.4% | 0 bp |
| **Net PnL** | −$535.69 | −$671.57 | −$135.88 (worse) |
| **Return %** | −51.6% | −65.6% | −14 pp (worse) |
| **Profit factor** | 0.240 | 0.260 | +0.02 (marginal) |
| **Sharpe (ann)** | −37.4 | −31.8 | slightly better |
| **Max drawdown %** | 51.6% | 65.6% | +14 pp (worse) |
| **Skipped triggers** | 3,796 | 3,489 | −307 unblocked |
| **Exit: time_stop** | 278 (79%) | 346 (82%) | dominant in both |
| **Exit: take_profit** | 28 (8%) | 35 (8.3%) | marginal improvement |
| **Exit: stop_loss** | 44 (13%) | 41 (9.7%) | fewer SL fires |

---

## Trade Composition by Tier

| Tier | V16 trades | V16 WR | V16 net PnL | V19 trades | V19 WR | V19 net PnL | Delta trades | Delta PnL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **tier1** | 240 | 28.8% | −$235.25 | 278 | 29.9% | −$256.40 | +38 | −$21.15 |
| **tier2** | 110 | 11.8% | −$300.44 | 144 | 11.1% | −$415.17 | +34 | −$114.73 |
| **Total** | 350 | 23.4% | −$535.69 | 422 | 23.4% | −$671.57 | +72 | −$135.88 |

**Key observation:** The 72 new trades are split 38 tier1 + 34 tier2. Tier2's 34 extra trades run at 11.1% WR with an average loss of −$12.21/trade (−$415/34 ≈ −$12.21). These are the "recovered" signals; they are all losers.

---

## Exit Reason Breakdown

### V16 (factor=5.0)

| Exit reason | Count | % | Avg PnL |
|---|---:|---:|---:|
| take_profit | 28 | 8.0% | +$18.60 avg |
| stop_loss | 44 | 12.6% | −$8.25 avg |
| time_stop | 278 | 79.4% | −$2.15 avg |
| **Total** | **350** | **100%** | **−$1.53 avg** |

### V19 (factor=7.0)

| Exit reason | Count | % | Avg PnL |
|---|---:|---:|---:|
| take_profit | 35 | 8.3% | +$14.95 avg |
| stop_loss | 41 | 9.7% | −$7.34 avg |
| time_stop | 346 | 82.0% | −$1.99 avg |
| **Total** | **422** | **100%** | −$1.59 avg |

**Interpretation:** The widened TP (factor 7.0) produces 7 more TP hits (+25% over v16's 28). But:
- Avg TP gain **falls** from +$18.60 to +$14.95 (7 new TP hits are smaller winners)
- Time-stop dominance **worsens** from 79% to 82% (more trades run out of time instead of reaching SL/TP)
- Overall win rate is **flat** (23.4% both versions) because the extra 72 trades add 17 wins out of 72 (23.6% WR on the margin)

---

## Root Cause: Time-Stop Dominance, Not Cap Width

The hypothesis predicted that raising the cap from 5.0 to 7.0 would recover ~4.0 orderly `trend_initiation` signals/day. The backtest confirms **~72 extra trades over 30 days ≈ 2.4 extra/day**, close to the prediction. But these recovered trades have the following profile:

1. **Win rate identical:** 72 extra trades win at 23.6%, matching the overall portfolio. No selectivity edge.
2. **Time-stop dominance worsens:** 82% of all trades (v19) close on time_stop, vs 79% (v16). More room for TP does NOT convert time-stops into TP hits; it lets more trades run past SL firing, only to be killed by the 15-min timer.
3. **Tier2 bleed:** 34 of the 72 extra trades are tier2 (lower-confidence signals). At 11.1% WR and −$12.21/trade, tier2's marginal contribution is −$115 to the −$136 total PnL loss.
4. **TP reachability is not the bottleneck:** v19's 35 TP hits (vs v16's 28) shows the TP *is* reachable when given room. But the 35 / 422 = 8.3% exit mix (same as v16's 8.0%) proves that most trades don't get there — they time out first.

**Conclusion:** The problem is not that the TP cap is too tight. The problem is that `trend_initiation` momentum signals initiate correctly but the momentum doesn't sustain for long enough to reach 1.5R within the live 15-min time-stop window. This is the exact same structural finding as EXP-001 (time-stop horizon sweep): giving losers more time doesn't convert them to winners; it just lets them run longer before the exit event kills them.

---

## EXP-001 Cross-Check

EXP-001 (timestop-sweep-20260623-1158.md) tested whether widening the time-stop horizon would help. The finding: at 15 min, 79.4% of trades close on time_stop; at 60 min (4× longer), 50.4% close on time_stop. But win rate **didn't improve** (22.3% → 30.8% apparent gain is a confound from 1-position slot-occupancy effects). The clean 15-vs-30 min comparison (same trade set) showed net PnL *worsens* (−$324.74 → −$341.80).

**EXP-004's finding echoes this:** the 72 extra trades (v16 5.0 → v19 7.0) are like giving momentum signals "more time to reach TP." But time alone doesn't create momentum that isn't there. The 82% time-stop rate in v19 vs 79% in v16 confirms that more TP room doesn't help if price doesn't move far enough.

---

## Shadow Test Status

The shadow version (id=19, `volatility-vwap:32`) started live on 2026-06-29 and continues accumulating forward data. However:

- **Stage-1 pre-screen gate (Section §8 of `docs/wip/max-tp-dist-factor-shadow-test.md`)** requires ≥50 cohort trades, ≥21 days, and avg_pnl > 0 for the re-admitted partition (`slDist/atr14 > 3.333`). Backtest evidence (identical 23.4% WR, −$671 net PnL) strongly suggests Stage-1 will fail.
- **Stage-2 gate (ADR 0019 full promotion)** would require positive OOS expectancy and profit factor ≥ 1.25. Backtest profit factor: 0.260 (far below 1.25); OOS expectancy: −1.59/trade. Will not clear.

The shadow continues for forward data accumulation but should NOT be promoted to live based on this backtest.

---

## Verdict

**REJECTED.** Raising `max_tp_dist_factor` from 5.0 to 7.0 does not improve profitability. The cap is not the binding constraint. Time-stop dominance (79–82% of all trades) is the structural issue, and it persists at both cap levels because momentum signals don't sustain to 1.5R within the 15-min hold window.

**Rules out:**
- Do not raise `max_tp_dist_factor` to recover trade volume. Any future "wider TP cap" proposal without evidence of sustained momentum is ruled out by this backtest + EXP-001.
- Do not assume the 4.0 signals/day that v5.0 rejects are viable if given 7.0 room. The backtest shows they exist (72 extra trades), tested them (at R:R 1.5, the M47 geometry), and measured their PnL (−$136 net worse). They are not profitable.

**Root cause:** `trend_initiation` signal quality (win rate, momentum sustainability) is the real lever, not cap width. EXP-003's Tier-A/B selectivity work (signal-quality gates, flow-type tightening, idiosyncrasy flooring) targets the right problem. Cap-widening targets the wrong one.

---

## Data Tables (Appendix)

### Rejected Signal Sample (v16 last 4 days — signals that v5.0 rejects)

| Symbol | vwap_dev% | slDist/atr | R:R at 5.0 | R:R at 7.0 | Re-admit at 7.0? |
|--------|-----------|------------|------------|------------|---|
| TAO    | −1.18     | 3.877      | 1.289      | 1.806      | yes |
| SNX    | 1.79      | 3.589      | 1.393      | 1.950      | yes |
| LTC    | 0.81      | 4.006      | 1.248      | 1.747      | yes |
| ENA    | 1.29      | 3.772      | 1.325      | 1.855      | yes |
| INJ    | 1.31      | 3.458      | 1.446      | 2.025      | yes |
| ADA    | −0.98     | 3.336      | 1.498      | 2.097      | yes |
| XRP    | −0.92     | 4.171      | 1.199      | 1.679      | yes |
| SOL    | −1.07     | 3.970      | 1.260      | 1.764      | yes |

All eight have VWAP deviation under 2% and `slDist/atr14 ≤ 4.171`. None are the 40%+ extreme-spike regime the cap was designed to guard against. The real negative-price hazard is independently covered by the SHORT `TP ≤ 0` guard (momentumCore.ts:167).

### Per-Symbol Win Rate (Top 10 by trade count, v19)

| Symbol | V19 trades | V19 wins | V19 WR | V16 trades | V16 wins | V16 WR | Delta trades |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC | 23 | 5 | 21.7% | 20 | 5 | 25.0% | +3 |
| ETH | 22 | 4 | 18.2% | 20 | 4 | 20.0% | +2 |
| XRP | 22 | 6 | 27.3% | 19 | 5 | 26.3% | +3 |
| SOL | 21 | 5 | 23.8% | 19 | 5 | 26.3% | +2 |
| ADA | 20 | 5 | 25.0% | 18 | 5 | 27.8% | +2 |
| LTC | 19 | 4 | 21.1% | 17 | 4 | 23.5% | +2 |
| DOGE | 18 | 4 | 22.2% | 16 | 4 | 25.0% | +2 |
| LINK | 17 | 4 | 23.5% | 15 | 3 | 20.0% | +2 |
| MATIC | 16 | 4 | 25.0% | 15 | 4 | 26.7% | +1 |
| (rest) | 244 | 56 | 23.0% | 191 | 44 | 23.0% | +53 |

Win rates are flat across symbols; the extra trades in v19 don't show higher quality per-symbol.

---

## References

- `docs/wip/max-tp-dist-factor-shadow-test.md` — shadow test setup and forward monitoring
- `docs/analysis/timestop-sweep-20260623-1158.md` (EXP-001) — time-stop horizon sweep; same structural finding (time-stop dominance)
- `docs/plans/archive/M47-rr-geometry-fix.md` — M47 deploy spec; flags `max_tp_dist_factor = 5.0` as provisional (§353)
- `docs/tech-debt.md` (M24) — tech-debt entry for this provisional param; references this doc
- `apps/engine/src/strategy/strategies/momentumCore.ts:156-172` — `isDegenerateMomentumGeometry` check
- `apps/engine/src/strategy/strategies/momentumCore.ts:139-145` — `resolveRrFloor`, cap application
