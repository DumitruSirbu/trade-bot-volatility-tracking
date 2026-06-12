# Strict Trader Evaluation: VWAP Deviation Mean-Reversion Decision

## Executive Verdict

The current plan is well engineered, but the trading conclusion is still too confident.

**VWAP deviation mean-reversion is a reasonable first research hypothesis, not yet a proven "stable and low-risk" production strategy.** The plan correctly improved the original raw 2-3% spike idea by adding 5-minute VWAP deviation, volume confirmation, idiosyncrasy scoring, regime labels, funding filters, slippage, and a central risk gate. Those are the right components.

The weak part is the business/trading claim: that this model is the best path to stable, low-risk profit. In crypto perpetuals, fading a fast move is structurally a **short-volatility, negatively skewed trade**. It can show a high win rate for long periods and then give back weeks of gains in a small number of continuation events, liquidations, exchange announcements, unlocks, ETF/macro moves, or coordinated altcoin pumps.

My strict assessment:

| Area | Grade | Assessment |
|------|-------|------------|
| Engineering architecture | A- | Strong separation of strategy, risk, execution, persistence, and backtest. |
| Data model for later analysis | A- | Good snapshots, funding, universe membership, and decision logging. |
| VWAP deviation as a signal location | B+ | Sensible intraday anchor; better than raw percentage moves. |
| Mean-reversion as default direction | C+ | Plausible in specific regimes, dangerous as default. |
| "Stable low-risk" claim | D | Not proven; risk profile is fat-tailed and adverse-selection-prone. |
| Backtest realism plan | B | Good start, but still missing depth, latency, OI, liquidation, and news/catalyst filters. |
| Starting capital / $30-day target | D | A 1% daily target on $3,000 is not low risk; it incentivizes overtrading. |

**Bottom line:** Do not lock "VWAP mean-reversion" as the chosen trading model. Lock only the **VWAP deviation event detector**. Then run at least three competing strategy policies on the same events:

1. VWAP mean-reversion.
2. VWAP momentum.
3. Hybrid router: reversion only on exhaustion/liquidation-style dislocations; momentum or skip on informed-flow/catalyst-style moves.

If the project needs an initial live version, it should be a **very restricted v0**: top-50 or top-75 symbols only, one position maximum, tiny risk per trade, no tier-3 coins, no market-wide stress, and mandatory paper/shadow comparison against momentum before scaling.

## What The Current Plan Gets Right

### 1. VWAP Is A Better Anchor Than Raw Percent Change

The original "2-3% move" idea was not normalized. A 2% BTC move and a 2% illiquid alt move are not equivalent. A 2% move during quiet conditions and a 2% move during liquidation chaos are also not equivalent.

The current plan's shift to:

- 5-minute candles,
- VWAP deviation,
- sigma bands,
- volume confirmation,
- coin tiers,
- ATR stops,
- idiosyncrasy scoring,
- BTC-correlated slot limits,

is a major improvement.

VWAP is useful because it represents where volume actually traded, not just where candle closes happened. In intraday trading, a deviation from VWAP can mark a temporary inventory imbalance, especially if liquidity providers absorbed a forced move and price later migrates back toward the volume-weighted center.

### 2. The Architecture Avoids Many Common Bot Failures

The milestone plan has several non-negotiable strengths:

- Strategies are pure and deterministic.
- Risk is outside the strategy and cannot be bypassed.
- Backtest and live share the same strategy code.
- Decisions persist full market snapshots.
- Funding is treated as real PnL, not ignored.
- Universe membership is point-in-time, which helps with survivorship bias.
- Backtest fills use next-bar open plus adverse slippage.
- Mean-reversion has a mandatory time stop.
- BTC-correlated signals are capped to one slot.

This is much better than most retail crypto bots. The risk is not that the system is naive. The risk is that the **market assumption** is still not strict enough.

### 3. Comparing Mean-Reversion And Momentum Is Correct

The plan says signal direction is empirical: v1 fades the deviation, v2 follows it. This is exactly right.

But the overview also says the signal trigger is "VWAP deviation +/-2 sigma + volume confirmation" and frames 5-minute VWAP mean-reversion as the validated standard. That phrasing is too strong. A VWAP deviation event can resolve in either direction:

- It reverts if the move was forced, temporary, liquidity-driven, or exhaustion-based.
- It continues if the move was informed, catalyst-driven, trend-initiation, or part of a broader market repricing.

So the detector is good. The default direction is not settled.

## The Core Trading Problem

### Mean-Reversion Is Not Low Risk By Nature

Mean-reversion feels safe because it often has:

- higher win rate,
- shorter holding time,
- obvious exit target,
- smaller average winner/loss,
- many small profitable trades.

But the actual risk profile is usually:

- negative skew,
- high sensitivity to rare trends,
- stop clustering,
- bad fills during stress,
- adverse selection when the trader is fading informed flow.

In simple language: the strategy sells panic or euphoria and assumes the move overshot. That works until the move is not an overshoot but the beginning of repricing.

For crypto perps, this matters more than in equities because:

- markets run 24/7 with no closing auction reset,
- leverage and liquidations create cascade dynamics,
- funding can crowd positioning,
- altcoin order books thin out suddenly,
- news and exchange listings can reprice coins violently,
- "idiosyncratic" moves are often exactly the informed moves you should not fade.

### High Win Rate Can Be A Trap

The prior analysis assumes examples like 55-63% win rate and 1:1.2-1.5 reward-to-risk. Those may be possible in favorable samples, but they should not be treated as input assumptions.

For this specific bot, the real question is:

```
After taker fees, slippage, missed fills, stop gaps, funding, partial fills,
latency, and bad regimes, does the trade still have positive expectancy?
```

Until that is proven out-of-sample and in paper/live shadow mode, the strategy should be classified as **unvalidated**.

## Is VWAP Deviation Mean-Reversion The Best Strategy?

### My Answer: Not As A Single Default Strategy

It is probably the best **event detector** among the options considered. It is not clearly the best **trade direction policy**.

The better framing:

| Component | Strict judgment |
|-----------|-----------------|
| VWAP deviation event detector | Keep. Good choice. |
| 5-minute bars | Keep as primary, but use 1s/aggTrade data for execution simulation. |
| Volume confirmation | Keep, but invert its interpretation in some cases. High volume can mean informed continuation, not reversion. |
| Mean-reversion default | Do not lock. It is regime-dependent. |
| Momentum default | Also do not lock. It is regime-dependent. |
| Hybrid router | Should become the real target strategy. |

### When VWAP Mean-Reversion Is A Good Trade

It is most attractive when:

- BTC and ETH are not trending hard.
- ADX/market breadth confirm a range regime.
- The coin is liquid enough that spread and depth remain stable.
- Price deviation is large but not a news-level discontinuity.
- Volume spike shows exhaustion, not fresh participation.
- Open interest is flat or falling during the spike.
- Funding is extreme and crowding is being unwound.
- The move looks like forced liquidation or stop-run flow.
- Price begins to reclaim toward VWAP before entry.

That is a very specific setup. It should not be generalized to all +/-2 sigma deviations.

### When VWAP Mean-Reversion Is A Bad Trade

It is dangerous when:

- Open interest rises sharply with the move.
- Price and volume expand together.
- The symbol is newly trending on social/news.
- The move is idiosyncratic and very high volume.
- BTC or ETH is in a high-volatility directional move.
- Funding is not yet extreme, meaning the trend may still have room.
- Spread widens and depth disappears.
- Price closes outside the band with no pullback.
- Multiple alts trigger in the same direction.
- The coin recently entered the top-300 due to a pump.

Many of these are exactly the cases a naive VWAP mean-reversion bot will select because they look like "strong signals."

## The Biggest Blind Spots

### 1. Idiosyncratic Altcoin Moves Are Not Automatically Better For Reversion

The plan treats idiosyncratic signals as high-quality candidates for slots A and B. This is only sometimes true.

If a coin moves independently of BTC with high volume, that can mean:

- temporary liquidity dislocation,
- whale stop run,
- short squeeze,
- exchange listing,
- token unlock information,
- partnership/news leak,
- governance exploit,
- delisting rumor,
- market-maker inventory repricing,
- insider/informed flow.

The plan assumes idiosyncratic means "alpha not explained by BTC." Correct. But it does not distinguish **reversion alpha** from **informed-flow continuation alpha**.

Strict rule: an idiosyncratic move with rising OI and rising volume should be treated as suspicious for mean-reversion. It should likely be momentum or skip, not fade.

### 2. Volume Confirmation Is Ambiguous

The plan requires `volume_ratio >= 1.5`. That filters ghost candles, but it also selects the most toxic continuation moves.

High volume has two meanings:

| Pattern | Interpretation | Better action |
|---------|----------------|---------------|
| Price spike, volume spike, OI rising | New money entering | Momentum or skip |
| Price spike, volume spike, OI falling | Short covering / liquidation | Reversion may work after exhaustion |
| Price spike, volume spike, then volume collapses | Exhaustion | Reversion after confirmation |
| Price spike, volume rising across multiple bars | Trend initiation | Do not fade |

So the volume filter should not be a simple pass/fail. It should be part of a flow classifier.

### 3. ADX Regime Filter Will Be Late

The plan uses ADX(14):

- ADX < 20 = ranging,
- ADX > 25 = trending,
- 20-25 = transitioning.

That is reasonable as a historical label, but weak as a first-line risk defense. ADX is lagging by design. It often identifies a trend after the first profitable or dangerous part has already happened.

For a mean-reversion bot, the first 1-3 candles of a new trend are the most dangerous. The strategy may still see "ranging" because the trend has not existed long enough for ADX to update.

Required improvement: add fast market stress gates independent of ADX:

- BTC 1m and 5m return shock.
- ETH 1m and 5m return shock.
- Market breadth: percent of universe moving same direction.
- Number of simultaneous triggers.
- Spread widening.
- Order book depth collapse.
- OI shock.
- Funding extreme.
- Liquidation spike if available.

If these say stress/trend initiation, skip mean-reversion even if ADX says range.

### 4. The Sigma Model Assumes Too Much Normality

Using +/-2 sigma around VWAP is intuitive, but crypto returns are fat-tailed. A 2 sigma event is not rare enough, and a 4 sigma event is not as rare as a normal model implies.

The strategy should not interpret sigma as a probability statement. It is a normalized distance measure, not a guarantee of reversion.

Better:

- Track empirical percentiles of VWAP deviation by symbol and tier.
- Consider robust deviation measures such as median absolute deviation or winsorized sigma.
- Store per-symbol distribution stats.
- Calibrate trigger bands by realized false-positive rate, not by Gaussian intuition.

### 5. Session VWAP Reset Can Create False Signals

Daily/session VWAP is useful, but crypto has no natural close. A UTC reset can destroy context right after a major move. The plan mentions session and 20-bar VWAP, but should be more explicit about which anchor drives the decision.

Recommended anchors to compare:

- rolling 20-bar VWAP,
- rolling 24-hour VWAP,
- session VWAP,
- event-anchored VWAP after a high-volume regime shift.

The backtest should not assume one anchor is universally best. It should compare them.

### 6. Slippage Model Is Still Too Optimistic

Tier-based fixed slippage is better than zero slippage, but it is not enough for this strategy.

Mean-reversion enters exactly when:

- spreads widen,
- depth thins,
- volatility rises,
- taker flow is one-sided,
- adverse selection is highest.

A fixed 0.15% / 0.50% / 1.00% tier model may still understate the bad fills that matter most. The fill model should become:

```
slippage = base_tier_slippage
         + spread_component
         + volatility_component
         + depth_component
         + market_stress_component
         + adverse_selection_component
```

At minimum, store and replay:

- bid/ask spread,
- top-of-book depth,
- 0.1% and 0.5% book depth if available,
- aggTrade buy/sell imbalance,
- latency assumptions,
- whether entry would cross the spread or rest as maker.

### 7. The $30 Per Day Target Conflicts With Low Risk

The prior analysis suggests $3,000 capital targeting roughly $30/day. That is about 1% per day.

That is not a low-risk target. Even if achievable in a backtest, it implies very high annualized return expectations and creates pressure to:

- overtrade,
- lower filters,
- trade weak signals,
- increase size after losses,
- keep the bot active in bad regimes.

For a strict trading process, daily profit targets should not drive entries. Better targets:

- maximum drawdown,
- risk of ruin,
- daily loss limit,
- expected value per unit risk,
- Sharpe/Sortino after costs,
- profit factor,
- tail loss,
- worst 1-day and 1-week outcomes,
- live/backtest slippage delta.

If the user wants low risk, the first goal should be: **survive and measure edge**, not earn $30/day.

## External Evidence Check

I consulted current web results and public documentation to sanity-check the plan.

Relevant findings:

- Research summaries on crypto intraday predictability report both momentum and reversal; the pattern changes around jumps, liquidity, macro announcements, and regimes. This supports the plan's v1/v2 comparison, but does not support choosing reversion by default. Source: [Intraday return predictability in cryptocurrency markets](https://ideas.repec.org/a/eee/ecofin/v62y2022ics1062940822000833.html).
- Size and liquidity matter. Evidence summarized in SSRN work suggests small/illiquid coins show stronger reversal, while large/liquid coins can show momentum. That complicates the plan's universe-wide model. Source: [Impact of Size and Volume on Cryptocurrency Momentum and Reversal](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4378429).
- Perpetual funding is a trailing/crowding indicator, not a standalone predictor. Coinbase notes elevated funding is associated with later volatility but is not a clean price-leading signal. Source: [Coinbase primer on perpetual futures](https://www.coinbase.com/institutional/research-insights/research/market-intelligence/a-primer-on-perpetual-futures).
- Binance current open interest for USD-M futures is available through REST `GET /fapi/v1/openInterest`, not a simple all-symbol real-time stream. Funding history is available through `GET /fapi/v1/fundingRate`, and mark price/funding can be streamed. Sources: [Binance Open Interest](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest), [Binance Funding Rate History](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History).
- Binance regular-user USD-M futures examples show maker/taker fees around 0.02%/0.05%, with exact rates depending on VIP/BNB discounts. Source: [Binance Futures Fee Structure](https://www.binance.info/en/support/faq/detail/360033544231).

These sources support the overall direction of the architecture, but they argue against declaring a single mean-reversion strategy "best" before OI/funding/depth-aware validation.

## Strategy Alternatives

### Option A: Pure VWAP Mean-Reversion

**Pros**

- Clear hypothesis.
- Short hold time.
- Easy TP/SL logic.
- Higher likely win rate in range regimes.
- Pairs well with strict risk gate.

**Cons**

- Negative skew.
- Fragile during trend starts.
- Bad under catalyst repricing.
- High adverse selection.
- Sensitive to fills and slippage.
- Can lose repeatedly in one-way markets.

**Strict verdict:** acceptable research candidate; not acceptable as "the safe strategy" until proven.

### Option B: Pure VWAP Momentum

**Pros**

- Better during informed flow and trend initiation.
- Positive skew potential.
- Avoids shorting strong pumps blindly.
- More aligned with high-volume OI expansion.

**Cons**

- Lower win rate.
- Whipsaw-heavy in ranges.
- Holds longer, increasing funding and exposure.
- Requires wider stops.

**Strict verdict:** should be tested equally, not treated as secondary.

### Option C: Hybrid VWAP Event Router

This should be the real target.

Use the same VWAP deviation trigger, but classify the event:

| Event features | Likely flow type | Action |
|----------------|------------------|--------|
| OI rising, volume rising, spread stable, market breadth aligned | Trend/informed flow | Momentum or skip |
| OI falling, liquidation spike, wick reversal, volume exhaustion | Forced-flow exhaustion | Mean-reversion |
| BTC/ETH shock, many alts moving together | Market regime event | Skip or max 1 position |
| Idiosyncratic pump with news/social/listing risk | Catalyst repricing | Skip |
| Range regime, no OI expansion, price reclaims band | Local dislocation | Mean-reversion |

**Strict verdict:** best design for low-risk intent, because it does not force one trade direction onto different market mechanisms.

### Option D: Statistical Pairs / Cointegration

This may be lower directional risk than single-coin VWAP fading, especially for stable operation, but it adds complexity:

- pair selection,
- hedge ratios,
- borrow/perp funding differences,
- two-leg execution,
- correlation breakdown,
- more difficult live reconciliation.

**Strict verdict:** likely a better "low directional risk" strategy eventually, but not the right first implementation unless scope expands.

### Option E: Funding/Basis Arbitrage

Potentially lower directional risk but requires:

- more capital,
- spot + perp or cross-exchange infrastructure,
- borrow/transfer risk,
- operational complexity,
- exchange/custody exposure.

**Strict verdict:** safer in theory, heavier operationally. Not aligned with current MVP.

## Specific Plan Critique

### M1 Market Data

Current M1 is strong, but it should add derivatives-flow and execution-liquidity state.

Add:

- Open interest current value and short-window change.
- Open interest history for backtests.
- Funding from all-market mark price stream where practical.
- Aggressor buy/sell imbalance from aggTrade stream for triggered symbols.
- Order book depth snapshots for triggered symbols.
- Spread and depth at trigger time, entry time, and exit time.
- Market breadth: percent of universe up/down over 1m, 5m, 15m.
- Trigger batch size: number of symbols firing in the same 5-minute bar.
- Symbol age in universe: fresh top-300 entrants are pump-risk candidates.

Do not stream deep order books for all 300 symbols if that is too heavy. A practical compromise:

1. Use broad ticker/mark streams for all symbols.
2. When a symbol approaches trigger threshold, subscribe or poll depth/OI more frequently.
3. Persist depth only around decisions and open positions.

### M2 Persistence

The snapshot schema is good, but it should include:

- `open_interest`
- `open_interest_change_5m_pct`
- `open_interest_change_15m_pct`
- `agg_trade_buy_volume_ratio`
- `market_breadth_5m_up_pct`
- `same_bar_trigger_count`
- `book_depth_10bps_usdt`
- `book_depth_50bps_usdt`
- `spread_at_entry_pct`
- `latency_ms`
- `vwap_anchor_type`
- `symbol_universe_age_hours`
- `news_risk_flag` or `manual_blacklist_flag`

These do not all need to drive v1, but they must be captured early. You cannot analyze what you did not record.

### M3 Strategy Engine

Current v1 and v2 are too symmetrical. The better set:

- v1: VWAP mean-reversion, only after exhaustion confirmation.
- v2: VWAP momentum, only in trend/OI expansion conditions.
- v3: Hybrid router that chooses mean-reversion, momentum, or skip.
- v0: No-trade baseline that logs every trigger for calibration.

Add an entry confirmation for mean-reversion:

```
Do not enter immediately on first close outside +/-2 sigma.
Enter only after price shows failure to continue:
- close back inside the band, or
- break of prior candle low for short after pump,
- break of prior candle high for long after dump,
- volume deceleration after spike,
- OI stops rising or begins falling.
```

This will reduce trade count but likely improve tail risk.

### M4 Risk Management

The central gate is good, but it should be stricter.

Add:

- Global market stress halt.
- Max consecutive losses per day.
- Max same-direction portfolio exposure.
- Max same-sector/narrative exposure if metadata exists.
- Max trades per symbol per day.
- Max trades per 5-minute bar across whole universe.
- No tier-3 live trading until validated.
- Isolated margin by default for live, unless there is a strong reason for cross.
- Kill switch if live slippage exceeds modeled slippage by a threshold.
- Kill switch if realized win/loss distribution deviates materially from paper expectations.

The daily and weekly loss limits are necessary, but they are not sufficient. A bot can stay within daily loss limits and still bleed persistently through overtrading.

### M5 Execution

Execution design should be more explicit about order type.

For mean-reversion, entering with a market order at the exact point of maximum spread can destroy edge. Consider:

- marketable limit with max slippage,
- post-only maker entry after confirmation,
- cancel if not filled quickly,
- no chasing after missed entry,
- separate order policy by tier and regime.

The backtest should mirror the live order policy. If live uses marketable limits and misses some trades, the backtest must include missed fills.

### M6 Position Management

Position management is good, but add:

- MAE/MFE tracking per position.
- Time-to-reversion tracking.
- Stop-gap tracking.
- Whether TP/SL was exchange-side or local fallback.
- Mark-price vs last-price distance during position.
- Liquidation-distance minimum observed during trade.

These are crucial for diagnosing whether the strategy is actually low risk.

### M7 Backtesting

The current backtest spec is better than most, but still not enough to approve capital.

Required additions:

- Depth-aware slippage around trigger windows.
- Missed-fill model if limit orders are used.
- Latency model.
- Intrabar stop/TP path simulation from 1s or aggTrade data.
- Open interest history replay.
- Funding replay from historical funding.
- Mark price vs last price for liquidation and stop logic.
- Stress-period test set: FTX, LUNA, major BTC ETF days, exchange outages, high-liquidation days, strong bull/bear trend windows.
- Symbol delisting/death handling.

The accepted fidelity limit should explicitly say: if historical L2 depth is unavailable, the backtest cannot prove live fill quality. It can only reject obviously bad strategies.

### M8 Strategy Comparison

M8 is directionally good, but the statistical gate is too lenient.

Current requirement: `>=30 trades per regime`. That is too low for a noisy, fat-tailed intraday crypto strategy.

Recommended minimums:

- At least 200 trades total per candidate before any statistical claim.
- At least 100 trades in the target regime for a regime-specific winner.
- At least 30 trading days in paper/live shadow before real scaling.
- Bootstrap CI on expectancy per unit risk, not only raw return.
- Report skew, kurtosis, max loss, expected shortfall, and longest losing streak.
- Compare strategies by trigger ID/event, not only by trade timestamps.

The "paired identical trade timestamps" requirement may be hard because v1 and v2 can enter/exit differently. Better:

```
Each VWAP trigger receives a stable event_id.
For each event_id, simulate v1, v2, v3, and no-trade under the same market path.
Compare outcome distributions by event_id and regime.
```

## Revised Promotion Criteria

Do not promote mean-reversion just because it has the highest win rate.

A strategy version should be promotable only if it passes all of these:

### Backtest Criteria

- Net positive expectancy after fees, slippage, funding, and missed fills.
- Profit factor >= 1.25 out-of-sample.
- Max drawdown within pre-defined tolerance.
- No single trade loses more than planned risk by a large margin under path simulation.
- Worst 1-day loss is survivable.
- Edge survives doubling slippage assumptions.
- Edge survives removing the best 5% of trades.
- Edge survives stress windows.
- Performance is not concentrated in one symbol or one week.

### Paper / Testnet Criteria

- At least 30 calendar days.
- Both v1 and v2 shadow-tracked on every trigger.
- Real spread/slippage logged.
- Live signal frequency within expected range.
- No unexplained execution/reconciliation drift.
- Live slippage no worse than modeled by more than a fixed threshold.
- No large difference between expected and actual fill rate.

### Live Minimal-Capital Criteria

- Start with one position maximum.
- Risk 0.10-0.25% of account per trade, not 1%.
- Top-50 or top-75 only.
- No tier-3 coins.
- No trading during market stress.
- No trading fresh universe entrants.
- No trading if OI data is unavailable for the symbol.
- Daily loss limit small enough that 3 stopped trades halt the bot.

Only after that should the system move toward 3 concurrent positions.

## Recommended Strategy Redesign

### Keep The VWAP Event Detector

Use the current M1 trigger as a detector:

```
abs(vwap_deviation_sigma) >= threshold
volume_ratio >= minimum
absolute move within tier bounds
closed 5-minute bar only
```

But do not let that detector imply direction.

### Add A Flow Classifier

Classify each event:

```
flow_type =
  forced_exhaustion
  trend_initiation
  market_beta
  catalyst_risk
  low_quality_noise
```

Inputs:

- VWAP deviation.
- Volume ratio.
- Volume acceleration/deceleration.
- OI change.
- Funding level.
- BTC/ETH move.
- Market breadth.
- Spread/depth.
- Wick structure.
- Previous candle continuation/failure.
- Symbol universe age.
- Same-bar trigger count.

Then choose:

| Flow type | Strategy action |
|-----------|-----------------|
| forced_exhaustion | mean-reversion |
| trend_initiation | momentum or skip |
| market_beta | skip or one slot only |
| catalyst_risk | skip |
| low_quality_noise | skip |

### Make "Skip" A First-Class Output

For a low-risk bot, skip quality matters more than entry frequency.

Most triggers should probably be skipped. The system should be judged not by how many trades it finds, but by whether it avoids bad trades.

## Practical Live Starting Policy

If I were responsible for protecting capital, I would start with this:

```json
{
  "live_mode": "restricted",
  "max_open_positions": 1,
  "max_coin_tier": 1,
  "risk_per_trade_pct": 0.25,
  "allow_mean_reversion": true,
  "allow_momentum": false,
  "require_exhaustion_confirmation": true,
  "require_oi_available": true,
  "skip_fresh_universe_entrants": true,
  "skip_market_stress": true,
  "max_trades_per_day": 3,
  "halt_after_consecutive_losses": 2
}
```

This will not produce $30/day on $3,000. That is the point. First prove survival and measurement quality.

After 30-60 days, scale only if:

- realized slippage matches model,
- live expectancy is positive,
- stop behavior matches backtest,
- no hidden operational failures,
- v1 beats v2 and v3 on net risk-adjusted metrics,
- drawdown is acceptable.

## Direct Answers To The User's Question

### Was VWAP Deviation Mean-Reversion The Best Choice?

**Partially.**

VWAP deviation was probably the best choice for the **signal framework**. Mean-reversion was not proven as the best **trading direction**. The best choice is to treat VWAP deviation as an event and let flow/regime decide whether to fade, follow, or skip.

### What Are You Missing?

The main missing pieces are:

1. Open interest change.
2. Liquidation/forced-flow context.
3. Order book depth, not only spread.
4. Volume interpretation beyond a simple ratio.
5. News/catalyst and fresh-pump avoidance.
6. Fast market stress gates beyond ADX.
7. Robust empirical bands instead of Gaussian sigma assumptions.
8. Live fill/missed-fill modeling.
9. A realistic rejection of the $30/day low-risk premise.
10. A hybrid router as the likely end-state strategy.

### Is It Stable And Low Risk?

Not yet.

It can become controlled-risk if:

- position size is tiny,
- filters are strict,
- bad regimes are skipped,
- live validation is mandatory,
- risk limits override profit targets,
- the system does not force trades.

But pure mean-reversion on crypto volatility spikes is not intrinsically low risk.

### What Should Be Changed In The Plan?

1. Change the locked decision from "VWAP deviation mean-reversion" to "VWAP deviation event model with mean-reversion, momentum, and hybrid policies."
2. Add OI, depth, market breadth, and trigger-batch metrics to M1/M2.
3. Add v3 hybrid router to M3.
4. Add exhaustion confirmation before v1 entries.
5. Add stricter market stress and consecutive-loss gates to M4.
6. Add order-policy realism and missed-fill handling to M5/M7.
7. Increase M8 statistical promotion requirements.
8. Remove the $30/day target from strategy selection criteria.

## Final Strict Recommendation

Do not abandon VWAP. Do not blindly trust VWAP mean-reversion either.

The safest path is:

1. Build the VWAP deviation detector.
2. Record rich market context from day one.
3. Shadow-test mean-reversion and momentum on every trigger.
4. Add a hybrid router that classifies event type.
5. Promote only after out-of-sample and live-shadow evidence.
6. Start live with one top-tier position and tiny risk.
7. Scale only after the live distribution resembles the tested distribution.

If the project proceeds with mean-reversion as the default live strategy before this evidence exists, the most likely failure mode is not a slow technical failure. It is a trading failure: many small wins, rising confidence, then a cluster of continuation losses during a regime shift that the bot labels too late.

That is preventable, but only if "skip" and "hybrid routing" become as important as the entry signal.


