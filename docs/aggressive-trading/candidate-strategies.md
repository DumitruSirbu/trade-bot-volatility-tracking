# Aggressive Strategy Candidates — Trend-Surge Research Brief

**Author persona:** Trend-Surge (aggressive directional book)
**Date:** 2026-07-06
**Status:** Proposals for simulation. Nothing locked. Each candidate is guilty
until the soak/backtest proves it survives costs.

---

## Purpose & Status

The sibling bot in this repo is the *conservative* VWAP-reversion system. This
brief proposes the *opposite temperament*: an aggressive, directional book that
**follows BTC/ETH regime**, presses winners, and cuts losers instantly. The
specific edge is not yet decided — the five candidates below are a spread of
detector families to simulate on our existing data, then rank on **profit
factor, win/loss ratio, and max drawdown** (never win rate).

**Status update (2026-07-08):** All FIVE candidates are now screened. Verdicts are **CLOSED**:
- **Candidate A (Donchian breakout):** NON-VIABLE. Higher timeframes solve the cost wall but reveal no underlying edge.
- **Candidate B (EMA regime flip, two-sided):** PROMISING but NOT YET VALIDATED. The FIRST and ONLY cost-surviving aggressive edge; passes 5/10 out-of-sample folds; quarter-sensitive, not robust yet; requires further validation stage.
- **Candidate C (Cross-sectional momentum + regime tilt):** NON-VIABLE. Does not survive out-of-sample walk-forward (0/10 folds). Single-window positive was path-fitting.
- **Candidate D (TSMOM + vol-targeting):** NON-VIABLE. No cost-surviving edge on any timeframe; strictly dominated by B; more turnover, same directional trend factor, worse implementation.
- **Candidate E:** DEFERRED — OI-limited (no long history available).

**Prior favourite gone:** The repo's own research found cross-sectional momentum was the only positive edge on the conservative side (EXP-011–016), and Candidate C was the aggressive expression of that bet. C's failure in walk-forward testing (0/10 folds) closes that hypothesis. The emerging through-line: on liquid USDT-M perps, transaction cost is the binding constraint, and its solutions (slower TF, lower rebalance) reveal the underlying signals are too weak or regime-specific to bank.

See `docs/analysis/README.md` (hypothesis registry) before touching any param —
some of these were partially explored on the conservative side and rejected
*for that risk profile*, which is not the same as rejected for this one.

---

## Shared framework (applies to every candidate)

- **Universe:** BTC, ETH, and the top ~200–300 USDT-M perps by volume already in
  `candles`. BTC/ETH double as the market-beta regime signal.
- **Direction:** decided by the detector, not assumed. Longs *and* shorts.
- **Regime gate (shared):** every satellite trade is conditioned on the BTC/ETH
  state — structure + anchor-EMA side + realized-vol regime. Whether alignment
  means *follow* or the regime is better *stood-aside* is an empirical question
  each sim answers.
- **Sizing (shared aggression lever):** ATR-normalised risk per trade so a 1-ATR
  adverse move is a fixed % of equity (Turtle-style). Leverage runs *hot*
  relative to the conservative sibling but is capped by a **portfolio-beta
  budget**, not a hard 1-slot limit.
- **Stops (mandatory):** every entry carries a hard stop. Aggressive ≠ no stop.
- **Exits:** trailing / regime-break for the trend families; fixed-R or signal
  for the mean-aware families.
- **Circuit breaker:** daily max-loss halt + consecutive-loss veto, same as the
  conservative engine's risk gate. **No order path bypasses the risk gate.**

All five are simulatable on the current schema (`candles` 1m/5m/15m,
`open_interest`, `funding_rates`, `book_snapshots`, `tick_aggregates`) via the
existing backtest runner. Where a candidate needs data we don't log yet, it's
flagged explicitly.

---

## Candidate A — Donchian / Turtle Breakout Continuation (ATR-sized, pyramided)

**One line:** classic breakout of the N-period high/low, sized by ATR, pyramided
into strength, exited on the opposite shorter-channel break.

**Hypothesis:** crypto trends are persistent and 24/7 (no gap risk), so a clean
channel breakout in the direction of the BTC/ETH regime captures the fat right
tail that pays for the many small stop-outs.

**Rules (starting point — all to be swept):**
- **Entry:** price breaks the highest-high / lowest-low of the last **N=20**
  periods (System 1) *in the direction of the BTC/ETH regime*. Optional
  higher-conviction **N=55** (System 2) variant.
- **Sizing:** `Units = (Equity × Risk%) / (ATR × contract_value)`; 1 ATR ≈ fixed
  % of equity. Start Risk% aggressive but bounded (e.g. 1–2% per unit).
- **Pyramiding:** add one unit every **+0.5 ATR** of favourable move, up to
  **4 units**. Never add to a loser.
- **Stop:** **2 ATR** from average entry; trails up with adds.
- **Exit:** opposite **N=10** channel break, or stop, or regime flip.

**Direction logic:** long only when BTC/ETH regime is up; short only when down;
stand aside in chop (no breakout trades against the major).

**Aggression:** high — leverage + pyramiding + hot Risk%.

**Data needed:** `candles` (5m/15m/1h) for BTC/ETH + satellites, `atr_at_entry`.
Fully simulatable today. Pyramided adds map to `adds_count` / multiple `add`
rows in `transactions`.

**Expected failure mode:** whipsaw in ranging BTC/ETH regimes — many 1–2 unit
stop-outs before a trend. Backtest will *understate* this (intrabar chop is
smoothed), so weight the live/soak stop-out rate heavily.

**What rejects it:** profit factor < ~1.3 after fees+funding across ≥2 full
BTC/ETH regime cycles, or capture ratio so low the pyramiding never engages.

**Grounding:** Turtle/Donchian rules and ATR sizing per the Altrady/Alchemy
turtle guides; 20/55 channel + 200-day/55-mid regime filter improves results.

**Simulation results:** 
- **37-day screen (5m):** [Candidate A — Offline Feasibility Simulation](candidate-a-simulation.md) — Verdict: non-viable at 5m. Turnover (798–1,546 trades/37 days) × notional-scaled slippage = 66–155% cost drag annihilates edge; BASE config has negative gross (−3.48%, PF 0.95).
- **30-month re-test (1h/4h/1d):** Higher-timeframe re-scope to 1h/4h/1d on 30 months — Verdict: **NON-VIABLE**. Turnover-cost wall is solved (1d drag → 2.35%), but no tradable edge remains. Net −2.19%/−2.90% under all cost tiers; entire positive signal is DOWN-regime-only (same short-on-down artifact as Candidate C). Long breakout side never pays. **CLOSED — do not carry forward.**

---

## Candidate B — EMA Regime Flip (Bitwise "Trendwise"-style, two-sided)

**One line:** go long/short (not long/flat) on the fast-vs-slow EMA cross of the
majors, aggressively leveraged, with satellites following the same regime.

**Hypothesis:** a simple, robust regime signal (10-EMA vs 20-EMA) captures the
bulk of the directional move with minimal overfitting; the aggression comes from
leverage and from being *two-sided* where Bitwise's ETF is long-flat only.

**Rules:**
- **Signal:** on BTC and ETH, **EMA(10) > EMA(20) ⇒ long regime**, `<` ⇒ short
  regime. (Sweep 8/21, 20/50, add a 200-EMA master filter.)
- **Entry:** enter the major(s) on the flip; enter high-beta satellites that
  confirm the same-direction cross on their own EMAs.
- **Sizing:** vol-targeted leverage — smaller size in high realized-vol regimes,
  larger in calm trends, so risk contribution is roughly constant.
- **Exit:** opposite EMA cross (the signal is symmetric — flip flat/reverse).
- **Stop:** ATR stop as a disaster brake below the EMA-cross logic.

**Direction logic:** the EMA state *is* the direction. Satellites must agree with
the BTC/ETH EMA regime or they're dropped.

**Aggression:** medium-high — fewer, larger, longer-held positions; leverage is
the lever, not trade frequency.

**Data needed:** `candles` for BTC/ETH + satellites; realized-vol regime for the
vol-target. ✅ Now simulatable on 30-month 1h/4h/1d data (see [data-requirements.md](data-requirements.md)).

**Expected failure mode:** death by whipsaw around a flat EMA cross in chop, and
funding drag on long-held crowded-side positions. Check cumulative funding vs
`mfe_pct` on winners.

**What rejects it:** the two-sided version's short leg bleeds (crypto shorts pay
funding *and* fight drift) badly enough that a long-flat version dominates —
in which case we downgrade to long-flat and lose the "aggressive" thesis.

**Grounding:** Bitwise Trendwise 10/20-EMA long-flat rotation (Bitwise/Business
Wire); QuantPedia multi-timeframe trend design for the master-filter idea.

**Simulation results:**
- **30-month sweep (1h/4h/1d):** Candidate B — EMA Regime Flip Results (`sims/candidate-b/candidate-b-results.md`, local-only — `sims/` is gitignored) — 18/36 configs robust net-positive (net > 0 under BOTH base and harsh tiers); ALL 12/12 daily configs robust (net +2%–+29%, gPF 1.28–1.77, maxDD 13.55%–20.71%). Only the daily timeframe clears costs; 1h decimated by turnover (cost drag 135.86%–230.41%), 6/12 on 4h. Gross-positive in 36/36 configs — a genuine pre-cost trend edge, unlike A/C/D. Two-sided (short leg) wins 6/6 vs long-flat on daily; the short leg ADDS value on slow grids. All-regime edge on 1d (UP/DOWN/CHOP all positive); not a down-leg-only artifact.
- **10-fold out-of-sample walk-forward:** Candidate B — Walk-Forward Results (`sims/candidate-b/candidate-b-walkforward-results.md`, local-only — `sims/` is gitignored) — Best configs survive 5/10 folds under both tiers (7/10 at optimistic 8/8); aggregate PnL positive in all regime buckets across folds. REAL but QUARTER-SENSITIVE — no config robust in ≥7/10 majority; roughly half the quarters net-negative after harsh costs. Short leg additive out-of-sample (two-sided configs survive MORE folds than long-flat +200). **Verdict: PROMISING — the only aggressive candidate with a repeatable, cost-surviving, all-regime daily trend edge — but NOT validated.** Requires further validation stage: fresh/expanded universe (including delisted names to address survivorship), new macro epoch (current 2024–26 is one mostly-up span), live-testnet paper at minimal size, formal parameter-stability testing. MTM drawdowns ~15–25% must be sized accordingly under survival-first mandate. Do NOT deploy on this evidence alone.

---

## Candidate C — Cross-Sectional Momentum on Satellites, Regime-Gated ★ (prior favourite)

**One line:** rank the universe by trailing return, go long the strongest and
short the weakest, but only in alignment with the BTC/ETH regime — leveraged and
rebalanced faster than the conservative version.

**Hypothesis:** this is the repo's *already-confirmed* cost-surviving edge
(EXP-011/012). An aggressive expression — more names, higher leverage,
shorter rebalance, regime-gated to press when BTC/ETH trends — should raise the
capture without destroying the edge.

**Rules:**
- **Signal:** every rebalance, rank all universe symbols by trailing return over
  lookback **L** (sweep 12h / 24h / 3d). Long the top decile, short the bottom
  decile (market-neutral *or* regime-tilted — see direction logic).
- **Rebalance:** faster than the conservative 24h — sweep 4h / 8h / 12h. Faster =
  more aggressive, more cost.
- **Sizing:** equal-risk (ATR-normalised) per leg; portfolio-beta budget caps
  gross.
- **Direction logic (the aggressive twist):** instead of pure market-neutral,
  **tilt net-long in an up regime and net-short in a down regime** — press the
  major trend rather than hedging it out.
- **Exit:** at rebalance (names that fall out of the top/bottom decile are
  closed), plus per-name ATR disaster stop.

**Aggression:** high — leverage + directional tilt + faster rebalance. The
directional tilt is what separates it from the conservative market-neutral book.

**Data needed:** `candles` for the *whole* universe (cross-section) —
already available. `beta_to_btc_at_entry`, `signal_score_at_entry` (the rank),
`realized_vol_regime_at_entry`. Simulatable today; this is the best-supported
candidate.

**Expected failure mode:** the directional tilt reintroduces the beta the
market-neutral version removed — in a sharp BTC reversal the net-long tilt eats
a large drawdown. Watch max drawdown and recovery factor, not just profit factor.

**What rejects it:** the regime-tilt version has a *worse* risk-adjusted profile
(lower recovery factor, deeper drawdown) than the plain market-neutral book on
the same events — i.e. the aggression adds beta risk without adding edge.

**Grounding:** repo research memory (cross-sectional momentum = only positive
cost-surviving edge); academic cross-sectional/TSMOM literature (arXiv
2602.11708 adaptive trend-following, 2302.10175 spatio-temporal momentum).

**Simulation results:**
- **37-day screen (8h rebalance):** [Candidate C — Offline Feasibility Simulation](candidate-c-simulation.md) — Verdict: regime-tilt added no net value (−0.61% vs neutral config), C2 (longer lookback) is fragile DOWN-regime artifact (swings +52%→+13%→−6% on slippage), costs dominate (57–71% of equity). Improvement sweep found two technically robust configs at base slippage tier but both draw profit entirely from thin DOWN-bucket windows.
- **30-month walk-forward (10 folds):** Multi-window out-of-sample test on 10 independent quarterly windows, carrying the sweep's best config (LS tilt L72 R24 2×) as hypothesis-to-falsify — Verdict: **DOES NOT SURVIVE OUT-OF-SAMPLE**. 0/10 folds net-positive at realistic costs (base 15/40 bps, harsh 20/60 bps); even at optimistic 8/8 only 2/10 (both bearish backdrops). Aggregate DOWN-bucket net across all folds is the LARGEST loser (−2564 USDT), contradicting hypothesis. Original 37-day positive was path-fitting. **CLOSED — do not carry forward.**

---

## Candidate D — Time-Series Momentum Thrust with Volatility Targeting (TSMOM)

**One line:** trade the *sign of each asset's own* recent return, scaled so every
position targets the same volatility — the canonical managed-futures approach,
ported to crypto perps and leveraged up.

**Hypothesis:** vol-scaling is what makes TSMOM work; a per-asset lagged-return
sign, vol-targeted, gives a robust aggressive book that isn't dependent on a
single BTC/ETH call.

**Rules:**
- **Signal:** for each asset, `sign(return over lookback K)` sets long/short.
  Sweep K = 24h / 3d / 7d. Optionally blend multiple K's (fast+slow).
- **Vol targeting:** position size ∝ `target_vol / realized_vol(asset)` so each
  name contributes equal risk; aggregate scaled to a hot portfolio vol target.
- **Regime overlay:** gate or amplify by BTC/ETH state — full size when the
  asset's sign agrees with the major regime, half size when it fights it.
- **Exit:** sign flip, or vol-target rescale, or ATR disaster stop.

**Aggression:** medium-high — the hot portfolio vol target is the lever.

**Data needed:** `candles` per asset + realized-vol estimate. ✅ Now simulatable on 30-month 1h/4h/1d data (see [data-requirements.md](data-requirements.md)).

**Expected failure mode:** in a mean-reverting/whipsaw regime the sign flips
churn costs; vol-targeting into a vol spike can *delever* right before the trend
resumes. Check turnover and cost drag explicitly.

**What rejects it:** net-of-cost Sharpe/profit factor no better than Candidate C
while carrying more turnover — TSMOM is only worth it if it diversifies C's beta.

**Grounding:** TSMOM + volatility scaling literature; arXiv 2106.08420 (dynamic
momentum learning), 2105.13727 (slow momentum / fast reversion).

**Simulation results:**
- **30-month sweep (1h/4h/1d):** Candidate D — TSMOM Results (`sims/candidate-d/candidate-d-results.md`, local-only — `sims/` is gitignored) — 0/48 configs robust net-positive (net > 0 under BOTH base and harsh tiers); 0/16 on each of 1h/4h/1d. Best config (1d K=7d vol-tgt +overlay) is net −13.73% base / −20.02% harsh. Gross-positive in 35/48 configs (best gPF 1.22) but costs destroy it: 21.40%–139.07% cost drag on slow/daily grids (more than B's 2.35%–71.25%). Per-bar TSMOM sign-flips + vol-rescale churn = much higher turnover than B (D: 3117–8928 trades on 1d; B: ~200–800 for same 30 months). Vol-targeting helps (16/24 pairings) but cannot rescue zero net.
- **D vs Candidate C (directional benchmark):** C's flagship LS-L72-R24 config failed 0/10 out-of-sample folds. D also fails all 48 configs to clear zero net on this data, so it does NOT beat C — it simply carries more turnover for no diversification benefit. **Verdict: NON-VIABLE and REJECTED.** D captures the same slow-timeframe trend factor as B but via noisier, higher-turnover sign-flipping, so it is strictly dominated by B. Recommendation: do NOT carry forward.

---

## Candidate E — Breakout + OI/Funding Confirmation (new-money squeeze-follow)

**One line:** only take a breakout when Open Interest is *rising* and funding is
flipping in the breakout's direction — i.e. confirmed new money, not a hollow
wick — then press it hard.

**Hypothesis:** the repo found standalone breakout *and* standalone funding both
fail, but the aggressive edge may live in their **conjunction**: a breakout
backed by rising OI + funding flip is new leveraged money entering, which is
exactly the kind of move worth pressing aggressively.

**Rules:**
- **Trigger:** Candidate-A style channel breakout **AND** `oi_change_5m` > θ
  (rising OI) **AND** funding rate moving in the breakout direction.
- **Entry:** market/aggressive-limit on confirmation, in the BTC/ETH regime
  direction.
- **Sizing:** ATR-normalised, with a size *boost* when all three confirm
  strongly (the highest-conviction aggressive expression).
- **Exit:** trailing stop; hard exit if OI rolls over (new money leaving) or
  funding flips back — the confirmation leaving is the exit signal.

**Aggression:** high on the confirmed subset, but the confirmation filter means
*fewer* trades — aggression via size/leverage, not frequency.

**Data needed:** `candles` + `open_interest` + `funding_rates` +
`oi_change_5m_at_entry` + `funding_annualized_at_entry` (already snapshotted in
the conservative schema). Simulatable today, though OI/funding cadence in the
backtest must match live — verify the tape reconstruction.

**Expected failure mode:** the triple-confirmation is so selective that the
sample is too thin to judge (<30 trades), or the OI/funding signals lag the
price so the edge is already gone. This is the candidate most at risk of
*sample starvation*.

**What rejects it:** on same-event pairs vs plain Candidate A, the OI/funding
filter doesn't improve profit factor — i.e. the confirmation is noise, matching
the repo's standalone-rejection of both signals.

**Grounding:** repo research (OI short-cover fade is a *filter* not a standalone
edge, EXP-013–016); funding-rate structure literature (arXiv 2506.08573).

**Status:** DEFERRED — OI-limited. Binance public dumps do not retain historical open-interest (REST retains ~30 days only). Long OI history requires a paid vendor or forward-running collector. Cannot test without this data.

---

## Simulation plan (how we test these on existing data)

1. **Baseline first.** Run each candidate against **v0 (no-trade)** on the same
   `event_id` set so expectancy is measured vs doing nothing, not vs zero.
2. **Same harness as live.** Use the existing backtest runner that reconstructs
   indicator state from `candles` + `tick_aggregates` so sims match live fills.
   Money stays `decimal`. No look-ahead: signals use only data ≤ decision ts.
3. **Cost model honest.** Fees + funding + spread (`spread_at_entry_pct`,
   `book_snapshots`) applied to every fill. An aggressive book lives or dies on
   net-of-cost numbers.
4. **Rank on the right metrics.** Profit factor, win/loss ratio, max drawdown,
   recovery factor, `getMoveCaptureReport`, `getScaleInEfficiencyReport`.
   **Ignore win rate.** Segment every pyramided result by `adds_count`.
5. **Regime-stratify.** Split every result by BTC/ETH regime (up / down / chop).
   A candidate that only prints in one regime is a regime bet, not an edge —
   size it accordingly or gate it.
6. **Sample-size gate.** <30 closed trades in a regime, or a window with no real
   directional BTC/ETH regime → verdict is "extend the soak", not a ranking.
7. **Held-out check.** Any candidate that ranks well gets a held-out sub-period
   confirmation before it earns a `v1` slot.

**Suggested first pass (highest prior → lowest, cheapest to sim → most fragile):**
C (regime-tilted cross-sectional) → A (Donchian) → B (EMA flip) → D (TSMOM) →
E (OI/funding-confirmed breakout).

---

## What I would NOT do yet

- Don't lock any detector. All five are hypotheses; rejection is a valid,
  expected outcome — including "none survive costs, don't build the bot."
- Don't judge a candidate in a chop-only window. Half these edges *require* a
  directional BTC/ETH regime to exist at all.
- Don't let pyramiding or the directional tilt flatter a version — segment and
  prove the aggression is *accretive* to risk-adjusted return, not just to gross
  exposure.

---

## Sources

- [Bitwise "Trendwise" momentum crypto futures ETFs (10/20-EMA long-flat)](https://bitwiseinvestments.com/newsroom/bitwise-debuts-momentum-based-trendwise-strategies-in-three-crypto-futures-etfs) · [Business Wire](https://www.businesswire.com/news/home/20241203542448/en/Bitwise-Debuts-Momentum-Based-%E2%80%9CTrendwise%E2%80%9D-Strategies-in-Three-Crypto-Futures-ETFs)
- [Turtle Trading Strategy rules — Altrady](https://www.altrady.com/blog/crypto-trading-strategies/turtle-trading-strategy-rules) · [Donchian Channel breakout strategy — Altrady](https://www.altrady.com/blog/crypto-trading-strategies/donchian-channel-strategy) · [Turtle trading complete guide — Alchemy Markets](https://alchemymarkets.com/education/strategies/turtle-trading-guide/)
- [Gate Research: Turtle rules reproduced, up to 62.71% annualized — Odaily](https://www.odaily.news/en/post/5205696)
- [How to design a simple multi-timeframe trend strategy on Bitcoin — QuantPedia](https://quantpedia.com/how-to-design-a-simple-multi-timeframe-trend-strategy-on-bitcoin/)
- [Momentum and trend-following trading strategies for currencies and bitcoin (PDF)](https://assets.super.so/e46b77e7-ee08-445e-b43f-4ffd88ae0a0e/files/9c27aa78-9b14-4419-a53d-bc56fa9d43b2.pdf)
- [Systematic Trend-Following with Adaptive Portfolio Construction in Crypto — arXiv 2602.11708](https://arxiv.org/pdf/2602.11708)
- [Spatio-Temporal Momentum: Time-Series + Cross-Sectional — arXiv 2302.10175](https://arxiv.org/pdf/2302.10175)
- [Trend-Following via Dynamic Momentum Learning — arXiv 2106.08420](https://arxiv.org/pdf/2106.08420)
- [Slow Momentum with Fast Reversion (deep learning + changepoint) — arXiv 2105.13727](https://arxiv.org/pdf/2105.13727)
- [Designing funding rates for perpetual futures — arXiv 2506.08573](https://arxiv.org/pdf/2506.08573)
- Repo internal: `docs/analysis/README.md` (hypothesis registry — EXP-011–016), strategy bake-off → cross-sectional momentum.
