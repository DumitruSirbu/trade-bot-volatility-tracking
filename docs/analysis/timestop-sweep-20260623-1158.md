# Time-stop horizon sweep — 20260623-1158

Backtest sweep of `time_stop_minutes` over the same soak window, holding every other
parameter fixed. Goal: see how the time-based exit interacts with SL/TP — whether a longer
leash converts time-stops into take-profits, or just lets losers run to the stop.

| Field | Value |
|-------|-------|
| Run ID | 20260623-1158 |
| Window (UTC, `to` exclusive) | 2026-06-09 → 2026-06-24 |
| Strategy version id | 3 (volatility-vwap:2) |
| Horizons swept (min) | 15, 30, 45, 60 |
| Reproduce | `scripts/analysis/timestop-sweep.sh 2026-06-09 2026-06-24 3` |

## Headline metrics

| time_stop (min) | trades | win% | net PnL | expectancy/trade | return% | profit factor | avg hold (min) | max DD% | Sharpe | Sortino | fees | funding |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 15 | 233 | 22.31 | -324.74 | -1.394 | -30.50 | 0.30 | 14.6 | 30.50 | -26.62 | -15.53 | 46.04 | -0.16 |
| 30 | 233 | 25.32 | -341.80 | -1.467 | -31.98 | 0.36 | 26.9 | 31.98 | -28.61 | -15.94 | 46.04 | 0.38 |
| 45 | 241 | 32.78 | -291.79 | -1.211 | -26.43 | 0.46 | 36.9 | 26.43 | -20.42 | -14.45 | 47.65 | 0.45 |
| 60 | 240 | 30.83 | -275.64 | -1.149 | -25.01 | 0.51 | 45.4 | 25.01 | -18.95 | -13.82 | 47.46 | 0.50 |

## Exit-reason mix (count, % of trades)

| time_stop (min) | take_profit | stop_loss | time_stop | other |
|---:|---:|---:|---:|---:|
| 15 | 19 (8.2%) | 29 (12.4%) | 185 (79.4%) | 0 (0.0%) |
| 30 | 32 (13.7%) | 47 (20.2%) | 154 (66.1%) | 0 (0.0%) |
| 45 | 41 (17.0%) | 57 (23.7%) | 143 (59.3%) | 0 (0.0%) |
| 60 | 53 (22.1%) | 66 (27.5%) | 121 (50.4%) | 0 (0.0%) |

## Funnel

> **Not strictly ceteris-paribus on entries.** Triggers are identical across horizons, but
> with the 1-position slot cap a longer time-stop holds the slot longer, so *which later
> triggers become fills* can differ. If `trades` moves across horizons in the headline table,
> the expectancy delta conflates "different exit" with "different trade population" — do not
> attribute it to the time-stop alone.

| time_stop (min) | skipped triggers | rejected by gate | missed limit fill | low-fidelity trades |
|---:|---:|---:|---:|---:|
| 15 | 1673 | 298 | 11 | 226 |
| 30 | 1673 | 298 | 11 | 226 |
| 45 | 1674 | 290 | 11 | 234 |
| 60 | 1675 | 291 | 11 | 232 |

## Caveats (calibration gaps — read before concluding)

- **BTC index-shock understated:** backtest uses candle-body returns; live uses a rolling
  tape window, so the backtest halts the BTC leg less often. Halt-frequency divergence here
  is structural, not signal.
- **ETH leg structurally dead in backtest:** single-symbol replay cannot reconstruct the ETH
  cross-tape. ETH behaviour is not represented.
- Intrabar SL/TP simulation reads `tick_aggregates` where present, else falls back to bar
  extremes — fills are modelled, not real.
- The time-stop and SL/TP are deterministic per bar, so the *relative* ranking across horizons
  is the trustworthy signal; absolute PnL inherits the gaps above.
- **Hypothesis-generating, not decision-grade.** A single ~2-week window at the tier-1 / 1-position
  live caps yields a small per-horizon trade count; an expectancy delta here is a hypothesis, not
  proof. Want ≥30–50 closed trades per horizon and the same ranking across 2–3 disjoint sub-windows
  before re-tuning `time_stop_minutes`.

## Findings (analyst read — this run)

**Question this was meant to settle:** is the 15-min time stop closing trades before SL/TP can
act, i.e. is it masking a working/broken SL/TP? And would a longer leash (or no time stop) help?

1. **The only clean apples-to-apples comparison says widening *hurts*.** 15 → 30 min holds the
   trade population fixed at 233 (identical funnel), so it isolates the exit change. Net PnL gets
   **worse**: −324.74 → −341.80; expectancy/trade −1.394 → −1.467. Of the 31 trades that stopped
   timing out, ~18 became stop-losses and only ~13 take-profits. Giving the median timed-out trade
   more room feeds more losers to the stop than winners to the target — consistent with the live
   MAE≫MFE signature (timed-out trades run ~1.1% against vs ~0.4% in favour).

2. **The 45/60 "improvement" is confounded — do not act on it.** Net looks better at 45/60
   (−291.79, −275.64) and every risk metric improves (PF 0.30→0.51, win 22%→31%, maxDD 30.5%→25.0%),
   **but trade count moves to 241/240** (gate rejects drop 298→290). That is the 1-position
   slot-occupancy effect: longer holds change *which* later triggers get a free slot, so 45/60 are
   scored on a different trade set. The improvement conflates "different exit" with "different
   population" and is not attributable to the time stop alone.

3. **SL/TP are reachable and correctly calibrated — they are not masked.** As the leash lengthens,
   time-stops convert into real SL/TP exits monotonically (TP 8%→22%, SL 12%→28%, time_stop
   79%→50%). The levels fire when given room. But **stop-losses outnumber take-profits at every
   horizon** (29>19, 47>32, 57>41, 66>53): the trades the 15-min stop cuts are predominantly
   losers-in-waiting. This is a *signal-quality* result, not an exit-calibration one.

4. **The louder finding dwarfs the time-stop question:** v3 is deeply net-negative across *every*
   horizon (PF 0.30–0.51, Sharpe −19 to −29) over this window. No time-stop setting rescues it.
   (Subject to the backtest caveats above — but the direction is unambiguous.)

**Verdict:** Do **not** widen or disable the live 15-min time stop on this evidence. The clean
15-vs-30 slice shows widening degrades expectancy; the apparent 45/60 gain is a trade-population
artifact. The time stop is doing its job — euthanising no-follow-through trades — and the real lever
is entry selectivity (fewer losers-in-waiting), not the exit clock. If 45/60 is to be pursued,
re-run across 2–3 disjoint sub-windows and confirm the ranking holds **with a stable trade count**.
