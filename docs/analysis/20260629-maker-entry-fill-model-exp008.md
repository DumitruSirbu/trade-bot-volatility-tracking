> **EXP-008 — INCONCLUSIVE** | 2026-06-29 | [back to index](README.md)

# Entry-only maker with an empirical fast-mover fill model and slot-hold opportunity cost

## 1. Summary

EXP-007 left the entry-only-maker verdict (S3: net −$29.35) hostage to one unmeasured number: the rate at which a passive limit entry misses fast-moving TP-hit trades. EXP-008 set out to ground that miss rate empirically using entry-slippage magnitude as a fill-probability proxy, then to stress S3 with a breakeven sensitivity sweep and a slot-hold opportunity-cost charge.

The central method does not survive contact with the data. In the v16 backtest, `slippageCostUsdt` is a deterministic ~0.30% of notional (mean 0.00300, population stdev 1.9e-05) — it encodes **position size, not price velocity**. TP-hit and time-stop trades have statistically identical entry-slip distributions (median entry_slip_est $0.3725 vs $0.3741). So entry slippage carries no fast-mover signal, and the "21.4% fast-mover miss rate" it produces is an artifact of which trades were larger, not which moved faster.

Taking the numbers at face value anyway: S3 beats the taker baseline (−$74.42) at **every** miss rate from 0% to 100% (−$29.35 down to −$60.98), but is **net-negative at every miss rate** — best case −$29.35 at a physically unrealistic 0% miss. Slot-hold opportunity cost is immaterial (cohort inter-signal gap is 357 min; T=5/15 min cancel windows cost <$0.10 total, and since the average available trade is a loser, blocking a slot is marginally *beneficial*). Per the decision rule this is **INCONCLUSIVE**: S3 improves vs baseline but stays negative throughout, and is positive at no realistic miss rate.

## 2. Setup

- **Data:** v16 backtest JSON, `mcp-16-2026-05-30-2026-06-29`, 350 trades, 2026-05-30 → 2026-06-29, ~300 symbols, $1000 capital.
- **Target cohort:** `coinTier == tier1 AND regimeAtEntry IN {trending_down, trending_up}`, **n=112**. Verified baseline: net **−$74.42**, slippage **$79.54**, gross-ex-slippage **+$26.72**, **14** TP hits, 86 time-stops, 12 stop-losses. Matches EXP-007 exactly.
- **Reference cohort:** all tier1, **n=240** (21 TP, 188 time-stop, 31 stop/other).
- **Entry-slip proxy:** `entry_slip_est = slippageCostUsdt * 0.5` (entry leg ≈ half of total; EXP-005/006/007 convention).
- **S3 transform (entry-only maker), per trade:** `s3_net = net + entry_slip_est + notional * 0.0002`, i.e. add back the entry-leg slippage and apply the taker→maker entry-fee improvement of 0.04% − 0.02% = **0.02% of notional**. Calibration matches EXP-007: taker 0.04%/leg, retail maker +0.02%/leg (no VIP rebate). Total cohort addback: entry slippage **$39.77**, fee improvement **$5.30**.
- **Miss model:** a maker entry that misses removes the trade entirely (no fill = no position = $0 contribution), not just its profit.

**Validity caveats (carried from EXP-005 §2a and prior):**
- Backtest fills are modelled from `tick_aggregates`; absolute PnL inherits BTC index-shock and single-symbol-replay gaps. *Relative* rankings are trustworthy.
- **New, decisive caveat:** `slippageCostUsdt` is a fixed-percentage-of-notional model, not a measured price impact. It therefore cannot distinguish a fast mover from a slow one, which is the exact discrimination EXP-008's fill model requires (see Task 1).
- Single 30-day window; the entire S3 upside rides on 14 TP trades.

## 3. Results

### Task 1 — Entry-slippage distribution: TP-hit vs time-stop

`entry_slip_est` in USDT. Buckets: [0–0.10, 0.10–0.25, 0.25–0.50, 0.50+].

| Cohort | Group | n | median | p25 | p75 | p95 | buckets |
|---|---|---|---|---|---|---|---|
| Target (112) | TP hits | 14 | 0.3725 | 0.3698 | 0.3736 | 0.3770 | [1, 0, 13, 0] |
| Target (112) | Time-stops | 86 | 0.3741 | 0.3714 | 0.3750 | 0.3775 | [0, 6, 80, 0] |
| tier1 (240) | TP hits | 21 | 0.3722 | 0.3693 | 0.3732 | 0.3761 | [1, 1, 19, 0] |
| tier1 (240) | Time-stops | 188 | 0.3741 | 0.3709 | 0.3750 | 0.3770 | [0, 13, 175, 0] |

**Hypothesis (TP hits have higher entry slippage → harder to fill as maker): REJECTED.** TP-hit entry slippage is if anything marginally *lower* than time-stops (median 0.3725 vs 0.3741), and the distributions are near-coincident. The reason is structural: `slippageCostUsdt / notional` = mean 0.00300, stdev **1.9e-05**, range 0.00295–0.00309 across the whole cohort. Slippage is a deterministic ~0.30% of notional; it varies only with position size (notional median $249.53, min $66.82, max $250.38). It contains **no information about how fast price moved**, so it cannot serve as a fill-probability signal. EXP-007's 20–50% miss-rate guesses cannot be replaced by anything derived from this field.

### Task 2 — Fast-mover classification

Threshold: tier1 median `entry_slip_est` = **$0.3738**. A trade is a "fast mover" if its entry_slip_est exceeds it (mechanically: notional above the tier1 median).

| | count |
|---|---|
| Target-cohort TP hits | 14 |
| of which "fast" (likely maker miss) | 3 |
| of which "slow" (likely maker fill) | 11 |
| **fast_miss_rate = 3/14** | **21.4%** |

S3 net PnL under this classification (full cohort, S3 transform):

| Scenario | S3 net | vs baseline (−74.42) |
|---|---|---|
| 0% miss (keep all 14 TP) | **−29.35** | +45.07 |
| Empirical fast-mover miss (drop 3 fast TP entirely) | **−38.16** | +36.26 |
| EXP-007 P1 — 20% TP-miss (fractional) | −35.67 | +38.75 |
| EXP-007 P2 — 50% TP-miss (fractional) | −45.16 | +29.26 |
| 100% TP-miss (drop all 14) | −60.98 | +13.45 |

The empirical 21.4% miss lands between EXP-007's P1 and P2, as expected. But note the miss rate is a notional-size artifact (Task 1), not a velocity measurement — it is not the empirical grounding EXP-008 was commissioned to provide.

### Task 3 — Breakeven sensitivity table

S3 base (0% miss) = −$29.35; total S3 contribution of the 14 TP trades = $31.63; taker baseline = −$74.42. Fractional-miss net = `s3_0 − miss% × tp_contrib`.

| TP-miss rate | TP hits kept | S3 net | vs baseline | Net-positive? | Beats baseline? |
|---|---|---|---|---|---|
| 0%   | 14.0 | −29.35 | +45.07 | No | Yes |
| 10%  | 12.6 | −32.51 | +41.91 | No | Yes |
| 20%  | 11.2 | −35.67 | +38.75 | No | Yes |
| 30%  | 9.8  | −38.84 | +35.59 | No | Yes |
| 40%  | 8.4  | −42.00 | +32.42 | No | Yes |
| 50%  | 7.0  | −45.16 | +29.26 | No | Yes |
| 60%  | 5.6  | −48.33 | +26.10 | No | Yes |
| 70%  | 4.2  | −51.49 | +22.94 | No | Yes |
| 80%  | 2.8  | −54.65 | +19.77 | No | Yes |
| 90%  | 1.4  | −57.81 | +16.61 | No | Yes |
| 100% | 0.0  | −60.98 | +13.45 | No | Yes |

- **At what miss rate does S3 fall below the taker baseline?** Never. Even at 100% TP-miss, S3 (−$60.98) beats taker (−$74.42), because the entry-leg slippage and fee saving apply to all 112 trades, not just the TP hits. Dropping a TP hit removes a *winning* trade but the slippage recovery on the other 111 trades dominates.
- **Maximum miss rate where S3 is net-positive?** None. S3 is net-negative across the whole 0–100% sweep; the best case is −$29.35 at an unachievable 0% miss.

### Task 4 — Slot-hold opportunity cost

- Cohort timestamps give **avg inter-signal gap = 357.2 min** (the cohort is 112 signals across 30 days, ~3.7/day — sparse, multi-hour spacing).
- Average net per available taker trade = −74.42 / 112 = **−$0.6645**.
- `n_cancels` = empirical fast-mover misses = 3. `opportunity_cost = n_cancels × (T / avg_gap) × avg_net_taker`.

| T (cancel window) | n_cancels | opportunity cost | S3 (fast-miss) pre-OC | S3 adjusted |
|---|---|---|---|---|
| 5 min  | 3 | −$0.0279 | −38.16 | **−38.14** |
| 15 min | 3 | −$0.0837 | −38.16 | **−38.08** |

The opportunity cost is immaterial (<$0.10) for two reasons: (1) a 5–15 min block against a 357-min mean gap almost never collides with another signal, and (2) the average blocked trade is itself a *loser* (−$0.66), so the sign of the "cost" is actually a tiny *benefit*. **Adding slot opportunity cost does not change the verdict.**

### Task 5 — Per-regime maker-entry check

| Sub-cohort | n | baseline net | gross-ex-slip | TP hits | fast TP | S3 @ 0% miss | S3 @ fast-miss |
|---|---|---|---|---|---|---|---|
| trending_down × tier1 | 57 | −28.64 | +22.21 | 11 | 2 | **−6.25** | −14.07 |
| trending_up × tier1   | 55 | −45.79 | +4.51  | 3  | 1 | −23.10 | −24.09 |

`trending_down × tier1` is the price-positive sub-cohort (gross-ex-slippage +$22.21) and gets closest to flat: S3 best case −$6.25 at 0% miss, −$14.07 at the empirical fast-miss rate. **It does not cross zero at any realistic miss rate** — even perfect fills leave it −$6.25. `trending_up × tier1` is hopeless under S3 (gross-ex-slippage only +$4.51). No sub-cohort is net-positive under entry-only maker.

## 4. Verdict — apply the decision rule

- **SUPPORTED** requires: S3 at the empirical fast-mover miss rate > 0 AND beats baseline by ≥$10 AND survives T=5 opportunity cost. → S3 at fast-miss is **−$38.16** (negative). First clause fails.
- **REJECTED** requires: S3 at empirical miss rate ≤ baseline. → −$38.16 > −$74.42, so S3 *does* beat baseline (by $36.26). Not rejected.
- **INCONCLUSIVE** if: S3 improves vs baseline but stays negative, OR is positive only at 0% miss. → Both apply. S3 beats baseline at every miss rate yet is net-negative everywhere; even the 0% case (−$29.35) is negative.

**Verdict: INCONCLUSIVE.** Entry-only maker is a genuine loss-reducer (it recovers the entry-leg half of a deterministic slippage charge plus a small fee edge on all 112 trades) but cannot make the momentum book profitable. The result is robust to the miss rate (monotonic, never positive) and to slot opportunity cost (immaterial). The experiment additionally fails to deliver its headline deliverable — an *empirical* fill model — because the backtest slippage field carries no fast-mover information.

## 5. What this rules out

- **Do not use backtest `slippageCostUsdt` (or any function of it) as a fast-mover / fill-probability signal.** It is a deterministic ~0.30%-of-notional model (stdev 1.9e-05); it measures position size, not price velocity. Any future maker-fill model must source velocity from order-book / tick microstructure, not from this field.
- **Do not expect a "realistic" TP-miss rate to rescue entry-only maker.** S3 is net-negative across the entire 0–100% miss sweep; there is no miss rate at which it turns green. The 0% best case is still −$29.35.
- **Do not invoke slot-hold opportunity cost as an argument for or against maker entry in this cohort.** Signal spacing (357 min) dwarfs any sane cancel window, and the average trade is a loser, so the effect is sub-$0.10 either way.
- **Do not treat `trending_down × tier1` as a maker-entry profit candidate.** It is the best sub-cohort and still cannot reach zero even with perfect (0% miss) fills.
- Confirms EXP-007's core finding from a second angle: slippage, not fees, dominates, and recovering only the entry leg (≈50%) is structurally insufficient.

## 6. Implementation note — is maker entry worth building?

Not for profitability, and not yet. Entry-only maker buys roughly **+$36–$45** of loss reduction on this 112-trade cohort (−$74.42 → −$29.35 ideal, −$38.16 at the size-artifact miss rate) but leaves it firmly net-negative. Building it would require: (1) a real fill model fed by live order-book depth and queue position, not a backtest slippage field; (2) post-only entry order support behind the risk gate with a cancel-and-fallback timeout; (3) acceptance that exits remain taker (ADR 0005 row 7 forces reduce/close/SL to market), so both-leg maker — the only construct EXP-007 found net-positive — stays unreachable. That is a substantial build for a sub-cohort that is still red. **Recommendation: do not build maker entry as a profitability play.** Keep it on the shelf as a slippage-reduction lever to pair with a strategy that is already net-positive on price.

## 7. Recommended next experiment / action

Verdict is INCONCLUSIVE, so the next lever is **not** execution mechanics — slippage recovery has now been bounded twice (EXP-007 both-leg, EXP-008 entry-only) and neither reaches profitability. The binding constraint remains entry selectivity / win rate (EXP-001, EXP-002, EXP-003, EXP-006). Recommended next:

1. **Pursue the win-rate lever, not the execution lever.** Re-open the EXP-003 Tier-A/Tier-B selectivity core (cut `catalyst_risk`, raise idiosyncrasy gate ~0.75, `signal_score` floor) on the v16 JSON with per-sub-window validation, targeting the ~52.8% breakeven WR (EXP-006) rather than slippage.
2. **If and only if** a selectivity cohort first reaches net-positive on price (gross-ex-slippage and net both > 0), revisit entry-only maker as an *additive* slippage trim on that profitable cohort — at which point even the size-artifact miss model would only improve an already-green book.
3. Park maker-entry execution work; it is a dependent optimization, not a primary lever.
