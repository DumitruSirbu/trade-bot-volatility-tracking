# Volatility-Driven Crypto Trading Strategies — Research & Comparison

## Part 1: The Strategy Landscape

### 1.1 Mean-Reversion on Volatility Spikes

The core thesis: a sharp short-term move is a temporary dislocation; price will revert. Most academically backed approach for intraday crypto trading.

**Statistical foundation**
- **Ornstein-Uhlenbeck process** — models price as noise + a "pull" toward equilibrium. Reversion speed θ > 0.03, half-life in [5–200] bars, and p-values < 0.2 are used to confirm a regime is mean-reverting before deploying the strategy.
- **Z-score bands** — entry when price is ±2–3 standard deviations from a rolling mean (20–50 bar). Exit at ±1 or mean.
- **VWAP deviation** — similar but anchored to volume-weighted price; intraday noise cancellation is better than SMA because it weights thin-book candles less.
- **Bollinger Band reversion** — 20-period SMA ± 2σ. Standard retail and institutional trigger for intraday mean-reversion entries.

**Crypto-specific factors**
- Thin order books on mid/small-cap coins create *exaggerated* deviations — entry signals look great, but slippage at entry and exit eats the edge.
- Mean reversion degrades badly during strong one-direction macro regimes (BTC rally/crash). A regime filter (e.g., ADX < 20 = range-bound, deploy mean-reversion; ADX > 25 = trending, suppress it) is critical.
- Surviving alpha in 2025–2026: mean-reversion bots that add regime detection and adaptive thresholds significantly outperform static Bollinger band bots.

---

### 1.2 Momentum / Trend-Following on Volatility Spikes

Opposite thesis: the sharp move *is* the signal; ride the continuation.

**Key mechanisms**

| System | Trigger | Stop |
|--------|---------|------|
| Donchian Channel (20–50 bar) | Close above/below N-bar high/low | Opposite channel breach |
| Keltner Channel (EMA ± 2×ATR) | Price exits channel | Channel re-entry |
| ATR breakout | Price moves > N×ATR from recent pivot | ATR trailing stop |

**Volume confirmation**: professional momentum traders require 150–200% of recent average volume to confirm a breakout is real. This is the single biggest false-positive filter.

**Funding rate as sentiment signal**: persistently positive funding (>0.1%/8h) = crowded longs → increasing reversal risk. Extreme negative funding (<-0.1%/8h) = panic shorts → potential squeeze. A funding-aware momentum system adjusts sizing or suppresses entries when funding is extreme.

**TSMOM research result** (Huang et al., SSRN 4825389): volume-weighted time-series momentum on crypto showed 0.94% daily gains with Sharpe ~2.17 in backtests — but these numbers degrade significantly under realistic slippage and survivorship-bias correction.

---

### 1.3 Volatility-Calibrated Position Sizing

This is risk management, not a signal — but it determines whether either strategy above is profitable or ruinous.

**ATR-based sizing formula:**
```
positionSize = riskPerTrade / (ATR × stopMultiplier)
```
- Tight stop (1× ATR): triggered often, allows larger notional
- Standard stop (1.5–2× ATR): recommended for perpetuals
- Wide stop (2.5–3× ATR): rarely triggered, but requires very small notional

On Binance USDT-M perpetuals, BTC ATR in early 2026 was 3–7% daily. Mid-cap alts routinely show 8–15% daily ATR. This means "leverage" and "position size" must be understood together — a 3× leveraged position on a 10% ATR coin with a 1.5× ATR stop will be stopped out on nearly any intraday candle.

**GARCH overlay**: EGARCH/CGARCH models can forecast volatility regimes. During predicted high-volatility periods, cut position size. During predicted low-volatility windows, scale up. Practical limitation: models degrade during rapid regime changes — exactly when you most need them.

---

### 1.4 Multi-Coin Universe Scanning

The 200–300 coin approach is well-supported by infrastructure and practice.

**What works:**
- Scanning top-volume USDT-M perpetuals surfaces the most liquid universe, reducing slippage risk.
- **Idiosyncratic movers** (a coin up 2.5% while BTC is flat) are better mean-reversion candidates than coins moving in lockstep with the market, because the alpha is not explained by market beta.
- **Cointegrated pairs** (e.g., ETH/BTC spread) offer pairs-trading alpha orthogonal to single-coin strategies.

**Correlation trap**: During market stress, all altcoins correlate to 1.0 with BTC. Running 20 "independent" positions during a BTC crash means 20 simultaneous losses. Professional practitioners monitor correlation matrix and enforce a *cluster exposure cap* — if 10 positions are in the same high-correlation cluster, they collectively count as one large position for risk purposes.

**Survivorship bias**: Coinbase Institutional Research found survivorship bias alone inflates crypto backtested returns by **17–22% annually**. If you backtest only on currently-listed coins, you miss all the coins that were in the top-300 three years ago and subsequently delisted/died. The `universe_membership` table (with `entered_at`/`left_at`) directly addresses this — but the historical data must actually include dead coins.

---

### 1.5 Optimal Signal Windows

| Window | Pro | Con | Best for |
|--------|-----|-----|---------|
| 1-min rolling | Catches micro-spikes | Extreme noise, high fee drag | High-frequency scalping |
| 5-min rolling | Balance of signal clarity and speed | Misses fastest pumps | Short-term mean-reversion or breakout |
| 15-min rolling | Clean signal, low noise | Slow for intraday scalps | Swing-scalp, position management |

The 2–3% threshold in a short window is a statistically meaningful outlier trigger for crypto perpetuals. Research confirms this is above typical 1-min intraday noise (~0.3–0.8%) but below typical trending-day moves (>5%). This makes it a reasonable signal boundary — though the exact threshold should be empirically tuned per asset class (large-caps vs. mid-caps behave differently).

**Session effects**: The London/NY overlap (8–11 AM EST) generates the highest volatility and is the most fertile window for both momentum breakouts and mean-reversion entries. The Asian session (00:00–02:00 UTC) shows spikes but thinner books, increasing slippage risk.

---

### 1.6 Critical Pitfalls

| Pitfall | Mechanism | Severity |
|--------|-----------|---------|
| **Look-ahead bias** | Using close price to generate signal that triggers at that same candle | Fatal — inflates returns massively |
| **Survivorship bias** | Backtesting only currently-listed coins | 17–22% annual return inflation |
| **Slippage underestimate** | Assuming mid-price fills on 2% move entries | 0.5–2% slippage on liquid coins; 2–5% on mid-caps; multiplied by leverage |
| **Correlation clustering** | Treating 20 alt positions as independent | 20× correlated drawdown risk in a crash |
| **Funding drag** | Ignoring 8h funding on perpetuals | At 0.05%/8h = 0.15%/day = 54%/year on gross position. Destroys undiscounted returns |
| **Liquidation cascade** | Thin-margin positions during cascade events | $19.2B liquidated in 24h (Oct 2025). Positions not stopped out via SL get margin-called |
| **Pump-and-dump manipulation** | Low-liquidity coins show artificial 2–3% moves | Strategy trades against coordinated manipulation |

---

## Part 2: Comparison with Project Design

### What the design gets right

**Signal trigger (M1 + M3)**
The `!ticker@arr` single-socket approach scanning 200–300 USDT-M perpetuals with configurable rolling windows and 2–3% threshold is architecturally correct. The research confirms this is an appropriate signal frequency and threshold range. The in-memory rolling windows per symbol (without DB reads on the hot path) is the right performance choice for this event rate.

**Both directions hardcoded as experiments (M3)**
Defining v1 (mean-reversion: pump → short, dump → long) and v2 (momentum: follow the move) as separate versioned strategies, with backtest comparison determining which direction wins, is exactly the right empirical approach. Academic research does not give a definitive answer — mean-reversion dominates in ranging regimes, momentum dominates in trending regimes. The backtest engine (M7) + versioning comparison (M8) is the right method to find out.

**Pure, deterministic strategies (M3)**
No `Date.now()`, no I/O, no LLM in strategy code. This is non-negotiable for reproducible backtests and is correctly specified. The research on look-ahead bias confirms why: any wall-clock dependence in strategy code can introduce subtle forward-looking leakage.

**Risk gate as mandatory choke point (M4)**
Every signal routed through a central risk gate with in-flight exposure reservation is exactly what the research recommends. The liquidation cascade literature specifically warns about strategies that place multiple concurrent orders without shared exposure accounting — a single fast pump can trigger 10 entries before the first fill is confirmed.

**`universe_membership` table with `entered_at`/`left_at` (data model)**
This directly solves survivorship bias. The research finding that survivorship bias inflates crypto backtest returns by 17–22% annually makes this table not optional but essential. It just needs to be populated with historical membership data, not only current membership.

**Funding rows in `transactions` (data model)**
Recording periodic funding cashflows as `transactions` of type `funding` is correct. The research shows funding drag can be 54%+ annually on gross position at typical elevated funding rates. Without this, PnL comparison across strategy versions (M8) will be directionally misleading — a mean-reversion strategy that trades more frequently pays more funding; a momentum strategy that holds longer pays more total. Accurate per-position PnL accounting requires funding included.

**Tick aggregates table for sub-minute data**
The `tick_aggregates` table is specifically designed so backtests can replay intraday 2–3% triggers authentically, not just approximate them from 1-min candles. This is a significant edge over most open-source backtest frameworks which would miss the intracandle trigger timing.

---

### Gaps and risks worth addressing

**1. No regime filter in the current strategy spec**

The single biggest finding from the research: mean-reversion fails badly in trending regimes; momentum fails badly in ranging regimes. The v1/v2 strategies as currently described are regime-agnostic. A coin moving 2.5% in 5 minutes during a market-wide BTC rally is a very different signal than the same move in a flat BTC environment.

*Recommendation:* Add a regime tag to `market_snapshot` in the `decisions` row (e.g., `btc_5m_trend: bullish|ranging|bearish`, `adx: 18.5`). This makes it possible — via M8 comparison — to discover whether strategy performance varies by regime, and eventually to build a regime-gated strategy v3.

**2. No volume confirmation filter**

The current v1/v2 specs trigger purely on % price change over a rolling window. The research strongly suggests requiring 150–200% of recent average volume to confirm the move is real. A 2.5% move on 30% of average volume is far more likely to reverse immediately (thin-book manipulation or a single large order) than the same move on 200% volume.

*Recommendation:* Add volume confirmation as a configurable `params` field on strategy versions. At minimum, log the volume ratio in `market_snapshot` so you can analyze its correlation with trade outcomes after the fact.

**3. Correlation cluster exposure cap missing from M4**

The risk gate enforces per-coin exposure caps and total exposure caps, but there is no mention of correlation-aware cluster limits. If BTC drops 5% suddenly, 15 altcoin short positions opened via mean-reversion will all move against you simultaneously. The individual per-coin stops fire, but the aggregate portfolio drawdown in that moment can exceed any individual position limit.

*Recommendation:* Add a `max_correlated_cluster_exposure` param to `risk_state`. Group positions by correlation cluster (at minimum, a simple heuristic: all active positions during BTC-correlated market moves count toward a shared exposure bucket).

**4. Funding rate filter in M4 is present but underdeveloped**

M4 mentions "accounting for perpetual funding direction/cost" but doesn't specify the decision logic. The research is concrete: when funding > 0.1%/8h (crowded longs), mean-reversion shorts become the more crowded trade, reducing their edge; when funding is extreme negative, momentum shorts may face a violent unwind.

*Recommendation:* Make the funding rate filter explicit: if `funding_rate > threshold_long_crowding`, reduce position size for short entries or suppress mean-reversion entries entirely. Log the funding rate in `market_snapshot` for later analysis.

**5. Slippage modeling in backtest**

M7 mentions simulated fills but doesn't specify slippage model. The research finding that 0.5–2% realistic slippage (mid-cap alts) at entry/exit can turn a 20% backtest return into 8% actual return suggests this is the most dangerous gap. A 2% entry target, 2% stop, and 0.5% slippage each way means the stop fires breakeven at best.

*Recommendation:* Parameterize slippage in `BacktestModule` by coin tier: top-50 by volume gets tighter slippage (0.1–0.3%), coins 50–200 get 0.3–0.8%, coins 200–300 get 0.8–1.5%. This should be a tunable param so you can run backtest sensitivity analysis.

**6. Max hold time-stop should be mandatory for mean-reversion**

M4 mentions "optional max-hold time-stop" for mean-reversion. The research confirms this is important: a mean-reversion trade that doesn't revert within N minutes is probably not a mean-reversion trade — it's a trend. Holding it accrues funding and reduces the expected return of future trades on the same symbol (post-loss cooldown isn't triggered by an open position, only by a closed loss).

*Recommendation:* Make the time-stop mandatory (not optional) for mean-reversion v1. A reasonable default is 2–4× the rolling window. If you trigger on a 5-min window, close if not profitable within 15–20 minutes.

**7. No explicit idiosyncratic signal filter**

The research distinguishes between a coin moving 2.5% while BTC is flat (idiosyncratic — strong mean-reversion signal) vs. the same coin moving 2.5% in lockstep with a 2% BTC move (market-beta — mean-reversion signal is weak because the whole market is directional).

*Recommendation:* Compute `btc_move_pct` over the same rolling window and include it in `market_snapshot`. Add a strategy param `require_idiosyncratic: true` that suppresses entries when the coin's move is >50% explained by concurrent BTC move.

---

### Summary comparison table

| Dimension | Research consensus | Project design | Gap |
|-----------|-------------------|----------------|-----|
| Signal trigger | 2–3% rolling window | Specified | None |
| Direction | Empirical, not assumed | v1+v2, backtest decides | None |
| Determinism | Pure functions | Required | None |
| Volume confirmation | Required for credibility | Not in v1/v2 spec | Add to strategy params |
| Regime detection | Necessary for both strategies | Missing | Log in `market_snapshot`; gate in v3 |
| Position sizing | ATR-based inverse sizing | Partially specified | Explicit ATR formula missing |
| Correlation cluster cap | Critical | Missing from M4 | Add cluster exposure param |
| Funding rate filter | Explicit threshold needed | Partial mention | Make threshold explicit |
| Funding in PnL | Essential | `funding` tx type present | None |
| Survivorship bias | Universe membership history | `universe_membership` table present | Needs historical data population |
| Slippage model | Tier-based, 0.1–1.5% | Not specified | Add to `BacktestModule` params |
| Max hold time-stop | Mandatory for mean-reversion | Optional in M4 | Make mandatory for v1 |
| Idiosyncratic filter | Improves signal quality | Missing | Add BTC-relative move to snapshot |
| Look-ahead bias guard | Shift entry to next candle | Not explicitly specified | Add to backtest implementation note |

---

### Bottom line

The architecture is solid and better thought-out than most open-source volatility bots. The foundation — deterministic strategies, central risk gate, tick-level data, funding PnL, universe membership history — addresses the right hard problems. The gaps are at the strategy-signal quality level (volume confirmation, regime detection, idiosyncratic filter) and the backtest realism level (slippage tiers, look-ahead bias guard). None require architectural changes — they are all addable as params to existing entities and modules.

The single highest-leverage addition would be **volume confirmation in strategy params** — it is the difference between triggering on real moves and triggering on thin-book noise, which is likely the first problem observable when the bot runs live on the full 200–300 universe.

---

## Part 3: Refined Strategy Selection — Safe, Proven, Production-Ready

### 3.1 Why the 2–3% Fixed Threshold Is Not the Right Starting Point

The 2–3% price-change figure was a reasonable hypothesis, not a calibrated signal. The problems:

- It is **not normalized to current volatility**. A 2% move on a calm day is a 5-sigma event. The same 2% move during a volatile session is normal noise. A fixed threshold fires both equally.
- It treats **all coins the same**. BTC moving 2% in 5 minutes is a major event. A low-cap altcoin moving 2% in 5 minutes may be a single market order against a thin book — manipulation, not alpha.
- It has **no volume confirmation**. A 2.5% price move on 20% of average volume is a ghost candle. On 250% volume it is a real event.

**Replacement**: use a VWAP-anchored deviation expressed in standard deviations (σ), computed dynamically from recent realized volatility. This adapts automatically to market regime and coin tier.

---

### 3.2 Proven Strategy Comparison

Four candidate strategies evaluated against the requirements (safe, stable, predictable, max 3 positions, $30/day target):

| Strategy | Documented win rate | Avg R:R | Regime sensitivity | Fee drag risk | Verdict |
|----------|--------------------|---------|--------------------|--------------|---------|
| **VWAP deviation mean-reversion** | 55–63% | 1:1.2–1.5 | Must filter trending regimes | Low (fast exits) | **Selected** |
| Bollinger Band reversion | 52–60% | 1:1.1–1.3 | High (fails in trends) | Low | Runner-up |
| ATR breakout momentum | 42–52% | 1:2–3 | Works only in trends | Medium | Not for start |
| Donchian channel breakout | 40–48% | 1:2.5–4 | Strong trend dependent | High (holds longer) | Reject |

**VWAP deviation mean-reversion wins** because:
- It is the most widely validated intraday strategy across equities and crypto (BitMEX Research, academic papers 2019–2024)
- It has the highest win rate of the four — important psychologically and practically when starting small
- It exits quickly (reducing funding drag on perpetuals)
- The signal is self-normalizing: VWAP deviation in σ is comparable across different coins and volatility regimes
- With the idiosyncratic filter (BTC-relative move), the signal quality is substantially higher than raw price-change triggers

---

### 3.3 Selected Strategy: 5-Minute VWAP Deviation Mean-Reversion

#### Signal mechanics

1. **Anchor VWAP** computed from the current session (or rolling 20-period on 5-min candles — session VWAP preferred for intraday alignment)
2. **Standard deviation bands**: compute rolling σ of price deviations from VWAP over the last 20 bars
3. **Trigger**: price crosses beyond ±2.0σ from VWAP
4. **Volume confirmation**: current candle volume ≥ 1.5× the 20-period average volume (filters ghost moves)
5. **Direction**: short when price is above VWAP + 2σ; long when below VWAP − 2σ
6. **Take profit**: price returns to VWAP (or VWAP ± 0.5σ for conservative exit)
7. **Stop loss**: 1.5× ATR(14) beyond the entry point (never inside the trigger level)
8. **Time stop**: close at breakeven or loss if position is not profitable after 3× the signal window (15 minutes for 5-min candles)

#### Why 5-minute candles, not 1-minute

| Factor | 1-min | 5-min | 15-min |
|--------|-------|-------|--------|
| VWAP signal noise | Very high | Low | Minimal |
| Fee drag per trade | High (many signals) | Balanced | Low |
| False trigger rate | ~60–70% | ~35–45% | ~20–30% |
| Mean-reversion speed match | Too fast | Correct | Too slow |
| ATR stability | Unreliable | Reliable | Reliable |
| Academic validation | Sparse | Extensive | Extensive |

5-minute is the industry standard for intraday VWAP mean-reversion. 1-minute generates too many false signals on thin-book coins. 15-minute is better for momentum/trend strategies, not for mean-reversion exits.

#### Adaptive thresholds by coin tier

Rather than a fixed 2–3% trigger, use σ-bands scaled by coin tier:

| Tier | Volume rank | VWAP trigger | Min absolute move | Max absolute move |
|------|------------|-------------|------------------|------------------|
| 1 | Top 50 | ±2.0σ | 0.8% | 4% |
| 2 | 51–150 | ±2.0σ | 1.2% | 6% |
| 3 | 151–300 | ±2.5σ | 1.5% | 8% |

The absolute min/max bounds prevent firing on microscopic moves in very calm markets and prevent trading obvious news/manipulation events where slippage is catastrophic.

---

### 3.4 BTC Correlation Mode — One Position Maximum

When BTC makes a significant move (>1.5% on 5-min candle) and the majority of alts are moving in the same direction:

1. The move is **market-beta, not idiosyncratic** — mean-reversion signal is weak
2. Running multiple positions in this regime is the **correlation trap** (20 alts = 1 giant BTC position)
3. The correct response: **score all triggered coins and open at most 1 position** from the batch

**Scoring formula for best candidate in BTC-correlated mode:**

```
score = (vwap_deviation_sigma × volume_ratio) / (1 + abs(funding_rate_annualized × 0.01))
```

- Highest `vwap_deviation_sigma`: furthest from equilibrium → biggest reversion potential
- Highest `volume_ratio`: real move, not a ghost
- Lowest funding cost: minimize carry drag on the position

**Position slot allocation:**
```
max 3 positions total:
  - slot A: idiosyncratic coins only (coin move NOT explained by BTC)
  - slot B: idiosyncratic coins only
  - slot C: BTC-correlated mode (at most 1 position when BTC moves big, else available for idiosyncratic)
```

Idiosyncrasy is measured as: `idiosyncrasy_score = 1 - (btc_5m_move_pct / coin_5m_move_pct)`. Score > 0.5 = coin is moving more than BTC explains → idiosyncratic. Score < 0.3 = mostly following BTC → BTC-correlated mode.

---

### 3.5 Additional DB Fields for Analysis and Algorithm

These fields should be captured at decision time (in `decisions.market_snapshot` JSONB and/or dedicated position columns). None are wasted — even fields that seem redundant now enable regression analysis later.

#### In `decisions.market_snapshot` (JSONB — no migration needed)

| Field | Type | Purpose |
|-------|------|---------|
| `vwap_session` | decimal | Session-anchored VWAP at signal time |
| `vwap_20bar` | decimal | Rolling 20-bar VWAP (alternative anchor) |
| `vwap_deviation_pct` | decimal | % price deviation from VWAP |
| `vwap_deviation_sigma` | decimal | Deviation in standard deviations |
| `volume_ratio` | decimal | Current candle volume / 20-bar avg |
| `volume_20bar_avg` | decimal | Raw 20-bar average volume |
| `atr_14` | decimal | ATR(14) on 5-min candles |
| `adx_14` | decimal | ADX(14) — regime strength indicator |
| `adx_di_plus` | decimal | +DI component (directional) |
| `adx_di_minus` | decimal | −DI component (directional) |
| `btc_5m_move_pct` | decimal | BTC % change in same 5-min window |
| `idiosyncrasy_score` | decimal | 0–1, how independent this move is from BTC |
| `funding_rate` | decimal | Current 8h funding rate |
| `funding_rate_annualized` | decimal | Annualized funding rate (easier comparison) |
| `bid_ask_spread_pct` | decimal | Spread as % of mid price |
| `estimated_slippage_pct` | decimal | Projected slippage from coin tier model |
| `coin_tier` | integer | 1, 2, or 3 (volume rank bucket) |
| `coin_volume_rank` | integer | Exact rank in universe at signal time |
| `correlation_mode` | string | `idiosyncratic` \| `btc_correlated` \| `market_wide` |
| `signal_score` | decimal | Composite quality score (0–100) |
| `position_slot` | string | `A` \| `B` \| `C` — which slot this fills |
| `active_positions_count` | integer | How many positions open when this signal fired |
| `regime_label` | string | `ranging` \| `trending_up` \| `trending_down` |
| `bollinger_upper` | decimal | Upper Bollinger band (secondary signal reference) |
| `bollinger_lower` | decimal | Lower Bollinger band |
| `bollinger_pct_b` | decimal | %B indicator (0–1 position within bands) |
| `rsi_14` | decimal | RSI(14) at signal time |
| `entry_candle_open_time` | timestamp | Exact candle that triggered (look-ahead guard verification) |

#### New columns on `positions` table

| Column | Type | Purpose |
|--------|------|---------|
| `vwap_at_entry` | NUMERIC | VWAP snapshot at entry (target for TP) |
| `atr_at_entry` | NUMERIC | ATR used to set SL distance |
| `vwap_deviation_at_entry` | NUMERIC | How far from VWAP at entry (σ) |
| `idiosyncrasy_at_entry` | NUMERIC | Idiosyncrasy score at entry |
| `coin_tier` | SMALLINT | Tier 1/2/3 at entry time |
| `time_stop_at` | TIMESTAMPTZ | When time-stop fires if position not profitable |
| `slippage_model_pct` | NUMERIC | Expected slippage used in backtest comparison |
| `position_slot` | VARCHAR(1) | A/B/C slot assignment |
| `signal_score_at_entry` | NUMERIC | Quality score when position was opened |

#### New columns on `strategy_versions` (params JSONB already exists, add documented defaults)

The `params` JSONB should be documented to include these configurable fields:

```jsonb
{
  "vwap_window_bars": 20,
  "vwap_sigma_trigger": 2.0,
  "volume_ratio_min": 1.5,
  "atr_period": 14,
  "atr_stop_multiplier": 1.5,
  "time_stop_minutes": 15,
  "idiosyncrasy_min_score": 0.5,
  "btc_correlated_move_threshold_pct": 1.5,
  "max_open_positions": 3,
  "max_btc_correlated_positions": 1,
  "tier1_min_abs_move_pct": 0.8,
  "tier2_min_abs_move_pct": 1.2,
  "tier3_min_abs_move_pct": 1.5,
  "tier1_max_abs_move_pct": 4.0,
  "tier2_max_abs_move_pct": 6.0,
  "tier3_max_abs_move_pct": 8.0,
  "funding_rate_suppress_threshold": 0.001,
  "candle_interval": "5m",
  "slippage_tier1_pct": 0.15,
  "slippage_tier2_pct": 0.50,
  "slippage_tier3_pct": 1.00
}
```

---

### 3.6 Capital Required for $30/Day Target

#### Assumptions (conservative, based on published VWAP mean-reversion backtests)

| Parameter | Value | Source |
|-----------|-------|--------|
| Win rate | 58% | Lower bound from academic studies |
| Average win | 1.3× risk | Take profit at VWAP from ±2σ entry |
| Average loss | 1.0× risk | Hard stop at 1.5× ATR |
| Trades per day | 5–8 | 200-300 coin scan, 3 max concurrent, avg hold 15–30 min |
| Fees | 0.04% taker each way | Binance Futures taker |
| Slippage (net) | 0.3% round trip | Tier 1–2 coins, market orders |

#### Expected value per trade

```
EV = (winRate × avgWin) - (lossRate × avgLoss)
   = (0.58 × 1.3R) - (0.42 × 1.0R)
   = 0.754R - 0.42R
   = 0.334R  (33.4% of risk per trade)
```

Fees reduce this: 0.3% round-trip slippage on a position risking 1.5% = ~20% of risk consumed by costs.

Net EV ≈ 0.334R − 0.20R = **0.134R per trade** (conservative)
Optimistic EV ≈ 0.334R − 0.10R = **0.234R per trade**

#### Solving for account size

Target: $30/day with 6 trades/day average

```
dailyProfit = trades × EV × riskPerTrade
30 = 6 × 0.134 × riskPerTrade
riskPerTrade = 30 / (6 × 0.134) = $37.31  (conservative)
riskPerTrade = 30 / (6 × 0.234) = $21.37  (optimistic)
```

Round to **$25 risk per trade** as a reasonable mid-point.

At 1.5% stop distance (typical for VWAP ±2σ on 5-min candles):

```
positionNotional = riskPerTrade / stopPct = 25 / 0.015 = $1,667
```

At 3× leverage (conservative, non-negotiable for mean-reversion):

```
marginPerPosition = 1,667 / 3 = $556
maxMarginUsed (3 positions) = $1,667
```

**Recommended account size**: 2× max margin used for safety buffer = **$3,000–$3,500 USDT**

This gives:
- 3 concurrent positions at $556 margin each = $1,667 margin in use at peak
- Remaining $1,333–$1,833 as buffer for adverse moves and drawdown
- Never above 56% margin utilization

#### Summary

| Scenario | Account | Risk/trade | Expected daily |
|----------|---------|-----------|----------------|
| Conservative | $3,500 | $25 | $20–$30 |
| Target | $3,000 | $25 | $25–$35 |
| Aggressive (after proven performance) | $5,000 | $35 | $40–$55 |

**Start with $3,000.** After 30 days of live trading with positive expectancy confirmed, increase position size. Do not increase account or risk before the strategy is validated on live data — the backtest win rate (58%) will likely be lower in the first month (~50–53%) as the system calibrates to live conditions.

#### Daily P&L expectation (realistic first 90 days)

| Phase | Win rate | Trades/day | Expectation |
|-------|----------|-----------|-------------|
| Month 1 (calibration) | 50–54% | 4–6 | $10–$20/day |
| Month 2 (tuning) | 54–58% | 5–8 | $20–$30/day |
| Month 3+ (stable) | 58–62% | 6–10 | $30–$50/day |

The $30/day target is achievable in month 2–3 at $3,000 account size, not on day 1. The first month should be treated as live data collection for the M8 strategy comparison, not as a profit target.

---

### 3.7 Implementation Priority Changes

Given this refined strategy, the following adjustments are recommended to the milestone plan:

1. **M3 v1 strategy**: implement VWAP deviation mean-reversion (not raw 2–3% threshold). Use `params` JSONB for all tunable thresholds listed in 3.5.
2. **M3 v2 strategy**: implement the same signal with momentum direction (follow the spike instead of fade it) for head-to-head M8 comparison — same signal, opposite direction.
3. **M1 market data**: add 5-min candle computation and rolling VWAP/σ bands alongside the existing rolling window; add `volume_ratio` and `btc_5m_move_pct` to the `volatility.detected` event payload.
4. **M4 risk gate**: add `correlation_mode` detection, `idiosyncrasy_score` filtering, and the slot A/B/C position allocation logic. Add `max_btc_correlated_positions: 1` as a hard limit.
5. **M2 data model**: add the new `positions` columns and populate `market_snapshot` with all fields listed in 3.5 from day one — even before they are used in strategy logic.
6. **M7 backtest**: implement tier-based slippage model from `params`. This is the single biggest realism improvement to the backtest.
