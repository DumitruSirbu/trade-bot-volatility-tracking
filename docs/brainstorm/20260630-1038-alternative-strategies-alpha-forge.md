# Alternative Trading Strategies — Alpha-Forge Brainstorm

**Persona:** Alpha-Forge (15y quant crypto, prop + market-making + systematic futures)
**Date:** 2026-06-30
**Trigger:** Current VWAP-deviation strategy (v1/v2/v3) exhaustively proven to lack
edge. Brief: propose alternative strategies, aggressive/higher-risk welcome,
grounded in proven methods used by successful systematic traders.

---

## 0. Why I'm not proposing another VWAP tweak — read this first

The hypothesis registry (`docs/analysis/README.md`) is unusually clean. It does
not say "the VWAP strategy is under-tuned." It says the **trigger has no edge**:

- **EXP-010:** the VWAP-deviation spike lacks edge in *both* directions —
  mean-reversion (10–11% WR) and momentum (24–27% WR) both lose. Direction is
  not the lever.
- **EXP-001/002:** time-stop horizon and TP:SL geometry are dead — win rate
  (22–31%) is the binding constraint, not the exit mechanics.
- **EXP-006/009:** tier-exclusion and signal_score flooring reduce loss but
  **never cross zero** (best ~36% WR vs ~53% breakeven).
- **EXP-007/008:** maker-entry / slippage recovery cannot make a price-negative
  book green.

**Diagnosis:** a generic 5-minute VWAP deviation fires on *noise*. ~80% of fills
expire at the time-stop near flat. The signal locates volatility but volatility
is symmetric — it does not predict direction or continuation. You cannot tune
your way out of a triggerless edge.

**The fix is not a better filter on the same trigger. It is a different trigger
that selects on a documented, persistent market inefficiency.** Everything below
does that. Critically — **the existing data infrastructure already captures the
inputs these strategies need** (OI, OI-change, funding, aggressor imbalance, book
depth, ATR, tape, 200–300 symbol cross-section). That is a large asset. We are
not starting from zero; we are re-pointing the detector.

---

## The six proposals (ranked summary)

| # | Strategy | Proven by | Feasibility | Edge plausibility | Priority |
|---|----------|-----------|-------------|-------------------|----------|
| 1 | Cross-sectional momentum (universe ranking) | AQR/Asness; crypto factor research | High | **High** | **P1** |
| 2 | Liquidation-cascade follow (OI+funding+liq-distance) | Crypto momentum desks; Hummingbot/quant funds | High | **High** | **P1** |
| 3 | Funding-rate carry + crowded-side squeeze fade | Delta-neutral basis desks; crypto arb funds | High | Medium-High | **P2** |
| 4 | OI-divergence directional (price×OI quadrant) | Futures order-flow tradition (Williams/CME) | High | Medium-High | **P2** |
| 5 | Donchian breakout trend-following (Turtle-style) | Dennis/Eckhardt Turtles; managed-futures CTAs | High | Medium | P2 |
| 6 | BTC/ETH (+ basket) stat-arb pairs | Stat-arb tradition (Morgan Stanley/Shaw); crypto pairs | Medium | Medium-High | P3 |

Detailed teardowns below. Each in the standard burst format.

---

## 1. Cross-Sectional Momentum — rank the universe, long winners / short losers

> *This is the single highest-conviction idea in this document. If we build one
> thing next, build this.*

**1. The hypothesis**
In a universe of 200–300 perps, the cross-section of trailing returns predicts
the next-period cross-section. Coins that have outperformed their peers over the
last N hours/days continue to outperform over the next horizon; laggards keep
lagging. Long the top decile, short the bottom decile, rebalance periodically.

**2. The mechanism**
This is the most robustly documented anomaly in *all* of asset pricing
(Jegadeesh-Titman 1993; Asness-Moskowitz-Pedersen "Value and Momentum
Everywhere" 2013 — momentum pays across every asset class tested). In crypto it
is *stronger* than in equities because the marginal participant is retail,
under-diversified, and slow to rotate; flows chase narratives (memecoins, L1
rotations, ETF cycles) with persistence. Whoever is on the other side is the
investor selling winners too early / holding losers (disposition effect) — a
behavioral bias that does not arbitrage away.
Why this works where VWAP-deviation failed: we are no longer betting on a single
coin's mean-reversion. We are betting on the *relative ordering* of a large
cross-section, which is statistically far more stable than any single-name
direction call. Diversification across 20–60 simultaneous legs converts a weak
per-name edge into a high-Sharpe portfolio.

**3. Signal inputs required**
- `candles` (5m/1m, all symbols) → trailing return over lookback windows
  (e.g., 6h, 24h, 72h). **Already captured.**
- `coin_tier`, volume, `spread_at_entry_pct`, `book_depth_10bps` → liquidity
  filter for the tradable subset. **Already captured.**
- Optional overlay: `funding_annualized` (avoid longing a coin you pay to hold),
  `oi_change_5m` (confirm flow). **Already captured.**
- *New capture needed:* a cross-sectional ranking job that snapshots all-symbol
  trailing returns on a schedule. This is new compute, but **zero new market
  data** — it reads `candles`.

**4. Natural fit with the existing system**
This is a new `strategy_version` with a *portfolio* selection step that the
current single-slot architecture does not have. It needs a ranking service
upstream of the per-symbol decision loop. The risk gate, sizing, execution, and
instrumentation all reuse the existing path **per leg**. The biggest
architectural delta: it wants *multiple concurrent positions* (a long basket and
a short basket), which collides with the live "1 position max / slot A"
constraint. Two integration modes:
  - **(a) Single-slot proxy:** trade only the #1 ranked long (or short the #1
    laggard) — keeps current risk constraints, lower Sharpe, validates the
    signal cheaply.
  - **(b) Full basket (target):** N-long / N-short, dollar-neutral, requires the
    slot-B/C relaxation. This is where the Sharpe lives.

**5. Highest-risk assumption**
That crypto cross-sectional momentum survives *transaction costs and funding* at
our size and rebalance frequency. Momentum decays; rebalance too often and fees
+ slippage eat it, too rarely and you hold reversals. The edge is real; capturing
it net of costs is the open question. **Crash risk:** momentum has fat left-tail
"momentum crashes" on sharp regime reversals (e.g., a violent BTC bounce after a
downtrend nukes a short-laggard book) — must be drawdown-managed.

**6. Validation path**
- **Backtest is strong here** (unlike VWAP — no tape-reconstruction problem;
  this reads daily/hourly candle returns). Build the ranking on `candles`,
  form deciles, compute forward returns net of a conservative cost model.
- Sample: 6+ months of universe candle history, ≥3 disjoint sub-windows.
- Key metric: long-short decile spread Sharpe, decile monotonicity (does return
  increase monotonically across deciles?), and turnover-adjusted net PnL.
- Kill criterion: if the top-minus-bottom decile spread isn't monotone and
  >1.0 gross Sharpe before costs, stop.

**Feasibility: High · Edge plausibility: High · Priority: P1**

---

## 2. Liquidation-Cascade Follow — ride the forced flow, don't fade it

> *This one directly weaponizes the exact data the current bot collects but
> doesn't act on correctly. Aggressive, high-payoff, asymmetric.*

**1. The hypothesis**
When leverage is crowded on one side and price ticks against it, exchanges
force-liquidate, which *mechanically* pushes price further the same way, which
triggers more liquidations — a self-reinforcing cascade. Detect the *onset*
(OI spike + funding extreme + aggressor imbalance + price breaking a liquidation
cluster) and **follow** the cascade for a short, violent move. Skip everything
else.

**2. The mechanism**
This is not a behavioral edge — it is a *structural/mechanical* one. Liquidation
engines are price-insensitive forced sellers/buyers; they MUST hit the book
regardless of value. For a few minutes the order flow is one-directional and
predictable. The other side is the over-levered retail trader being
margin-called, plus the liquidation engine itself. Successful crypto desks
(and the better Hummingbot/quant shops) explicitly trade this "liquidation
hunt" — it is one of the few genuinely crypto-native, non-arbitraged edges
because it depends on the perp leverage structure that doesn't exist in
traditional markets.
Why this beats VWAP-deviation: the VWAP `forced_exhaustion` path tried to *fade*
exhaustion (catch the falling knife) and got 10% WR. The mechanical truth is the
opposite — during the cascade you **follow**, and you only fade once the OI has
been *flushed* (liquidations exhausted, OI collapses, funding resets). We have
the OI-change data to distinguish "cascade building" from "cascade done."

**3. Signal inputs required**
- `open_interest` + `oi_change_5m` → detect OI building (cascade fuel) vs OI
  collapsing (cascade spent). **Already captured.**
- `funding_annualized` → identify which side is crowded (extreme + funding =
  crowded longs → downside cascade fuel). **Already captured.**
- aggressor imbalance + `book_depth_10bps` → confirm one-directional taker flow
  and thin book (cascades run on thin books). **Already captured.**
- `min_liquidation_distance_pct` → we already compute distance to liquidation
  clusters; use it as the *trigger zone* instead of just a stop-safety check.
  **Already captured.**
- *New capture (high value):* a real liquidations feed (Binance
  `!forceOrder@arr` websocket stream) — direct liquidation prints are the
  cleanest possible trigger and we don't yet ingest them.

**4. Natural fit with the existing system**
New `strategy_version` (`v4_cascade`) or a new `flow_type` in the v3 router.
Reuses the entire single-slot path — this is *naturally* a one-position,
high-conviction strategy, so it fits the live constraint perfectly. The detector
changes; risk/exec/instrumentation stay. Entry must be *taker/market* (you cannot
post-only into a cascade — speed is the edge), which the current execution path
already supports.

**5. Highest-risk assumption**
That we can detect the cascade *onset* fast enough to enter before the move is
over, yet late enough to confirm it's real — and exit before the violent
snap-back. Cascades are minutes long; our 5m candle cadence may be too slow.
This strategy likely *requires* the sub-minute `tick_aggregates` / live tape and
possibly the liquidation websocket. If we can only see it on 5m bars, we're
entering at the end. **This is the make-or-break.**

**6. Validation path**
- Backtest caveat: the registry flags BTC index-shock divergence and tape
  reconstruction limits — cascades are exactly the regime where backtest is
  weakest. So: **shadow-soak first**, don't trust the backtest alone.
- Build the detector, run it in shadow (`shadow_decisions`) logging entry/exit
  on tape, measure realized move capture vs slippage.
- Sample: needs enough cascade events — these are rare (maybe 1–5/day across the
  universe), so budget a 3–4 week shadow soak.
- Key metric: conditional payoff — when the detector fires, what's the
  distribution of the next 5/15/30-min return? Look for a fat right tail
  (asymmetric payoff is the whole point), not a high hit rate.

**Feasibility: High · Edge plausibility: High · Priority: P1**

---

## 3. Funding-Rate Carry + Crowded-Side Squeeze Fade

**1. The hypothesis**
Two linked edges off the funding rate:
  (a) **Carry:** when funding is persistently extreme, the side paying funding is
  crowded; harvest the funding by holding the opposite side (delta-managed).
  (b) **Squeeze:** extreme funding marks maximum crowding → highest squeeze risk;
  fade the crowded side for the violent mean-reversion when it unwinds.

**2. The mechanism**
Funding is a direct, *observable* crowding gauge unique to perps — there is no
equivalent in spot/equity. Persistently high positive funding = too many longs
paying to stay long = fragile, primed for a long squeeze. Crypto basis/arb desks
run the carry leg as a core market-neutral book; the squeeze leg is the
aggressive directional expression of the same signal. The counterparty is the
crowd of leveraged longs (or shorts) who entered late on a narrative and are now
bleeding funding — a recurring, structural population.

**3. Signal inputs required**
- `funding_rates` time-series + `funding_annualized_at_entry` → level and
  persistence. **Already captured.**
- `open_interest` → confirm crowding is large (high OI + extreme funding =
  maximum fragility). **Already captured.**
- `oi_change_5m` → detect the unwind onset for squeeze timing. **Already captured.**

**4. Natural fit with the existing system**
New `strategy_version`. The squeeze-fade leg fits the single-slot path directly.
The carry leg is naturally market-neutral and lower-return — likely a P3 overlay,
not the headline. Entry timing for the squeeze can reuse the existing trigger
machinery, just gated on funding extremity instead of VWAP deviation.

**5. Highest-risk assumption**
Timing. "Extreme funding" can stay extreme for days (a strong trend keeps longs
paying happily) before it snaps. Fade too early and you're run over by the very
trend that's funding you. The signal tells you *fragility*, not *timing* — needs
a confirmation trigger (OI rollover, price structure break) to avoid being the
guy shorting strength.

**6. Validation path**
- Backtest on `funding_rates` + `candles`: condition forward returns on funding
  percentile; does the top/bottom funding decile predict reversal?
- Sample: 6+ months, all symbols. Funding extremes are frequent enough for good n.
- Key metric: forward return conditional on funding percentile, and the
  conditional improvement when an OI-rollover confirmation is added.

**Feasibility: High · Edge plausibility: Medium-High · Priority: P2**

---

## 4. OI-Divergence Directional — the price×OI quadrant read

**1. The hypothesis**
Price direction combined with OI direction classifies the *quality* of a move:
  - Price ↑ + OI ↑ = new longs / fresh money → **continuation** (follow)
  - Price ↑ + OI ↓ = short covering → **exhaustion** (fade/skip)
  - Price ↓ + OI ↑ = new shorts → **continuation down** (follow)
  - Price ↓ + OI ↓ = long liquidation/capitulation → **bottoming** (fade)
Trade only the two "fresh money" continuation quadrants; skip the rest.

**2. The mechanism**
Classic futures order-flow analysis (Larry Williams; standard CME/commercial
desk read on OI). A move backed by *rising* OI is backed by new conviction and
tends to persist; a move on *falling* OI is just positions closing and tends to
stall. This filters the symmetric-volatility problem that killed VWAP-deviation:
instead of betting on every spike, you only bet on spikes that the OI confirms
are *new-money driven* in the trigger direction. The other side is traders
reading price alone without the OI context.

**3. Signal inputs required**
- `open_interest` + `oi_change_5m` (sign and magnitude). **Already captured —
  this is literally the `flow_type` raw material.**
- `candles` for the price-direction leg. **Already captured.**
- This strategy is almost entirely buildable from columns *already in
  `positions`* — `oi_change_5m_at_entry` + price. Lowest new-data cost of any
  proposal here.

**4. Natural fit with the existing system**
This is arguably *what v3's `flow_type` router was reaching for* but never
validated as a standalone edge. It can be implemented as a refined `flow_type`
classifier OR as its own `strategy_version` that drops the VWAP-deviation trigger
entirely and triggers on the OI-divergence quadrant + a momentum confirmation.
Recommend the latter — decouple it from the dead VWAP trigger.

**5. Highest-risk assumption**
That OI-change at our 5m cadence is clean enough to classify the quadrant
reliably (OI prints are noisy and exchange-reported with lag). EXP-010's root
cause was literally an OI-indexing bug — OI data handling has already bitten this
codebase once. Data hygiene on the OI leg is the critical dependency.

**6. Validation path**
- Backtest: re-run the *now-fixed* OI harness (post-2026-06-29 M25 fix),
  classify every event into quadrants, measure forward return per quadrant.
- Sample: the fixed harness, 2–3 sub-windows, ≥30 events/quadrant.
- Key metric: forward-return separation between "fresh money" and "closing"
  quadrants. If the continuation quadrants don't out-return the others, the
  OI read is too noisy at this cadence — kill it.

**Feasibility: High · Edge plausibility: Medium-High · Priority: P2**

---

## 5. Donchian Breakout Trend-Following (Turtle-style)

**1. The hypothesis**
Enter long on an N-period high breakout, short on an N-period low breakout, size
by ATR, ride the trend, exit on an opposite shorter-period channel or ATR trail.
Accept a low win rate (~35–40%) in exchange for large winners (R:R 3–5+).

**2. The mechanism**
The original Turtle system (Dennis/Eckhardt) and essentially the entire
managed-futures / CTA industry runs on this. Trends exist because information
diffuses slowly and participants under-react then over-react. Crypto trends
harder than any traditional asset (24/7, reflexive, narrative-driven). The edge
is *convexity*: you lose small often and win big rarely — the opposite payoff
shape to the current VWAP book (which wins small rarely and loses small often via
time-stop). **This directly addresses the EXP-001/002 finding** that the current
book's R:R can't be tuned positive *given its win rate* — breakout flips the
payoff profile rather than fighting it.

**3. Signal inputs required**
- `candles` → Donchian channel highs/lows. **Already captured.**
- `atr_at_entry` → volatility-based sizing and trailing stop. **Already
  captured** (we already snapshot ATR).
- Liquidity filter via `coin_tier` / `book_depth`. **Already captured.**
- *Architectural need (not data):* a **trailing/structural exit**, because the
  current 15-min time-stop is *lethal* to trend-following — it cuts winners
  before the trend pays. EXP-001 proved widening the time-stop doesn't help
  *mean-reversion*; trend-following needs to *remove* it and trail instead.

**4. Natural fit with the existing system**
New `strategy_version`. The big delta is the **exit mechanic** — must replace the
time-stop with an ATR/channel trailing stop. That's a known, contained engine
change. Entry/risk-gate/sizing reuse. Fits single-slot (one strong trend at a
time), though a basket version (top-N breakouts) scales better.

**5. Highest-risk assumption**
That crypto trends are long/clean enough at our timeframe to overcome the
whipsaw cost. Breakout systems die by a thousand false breakouts in choppy
regimes. The `transitioning` regime (flagged in EXP-005 as the worst, PF 0.183)
is exactly where breakouts get chopped up — so this *needs* a regime filter
(only trade breakouts in confirmed trending regimes, stand down in chop).

**6. Validation path**
- Backtest on `candles` + `atr`: standard Donchian sweep (entry 20/55-period,
  exit 10/20-period), ATR sizing, across sub-windows.
- Sample: 6+ months, full universe, separate bull/bear/chop sub-periods
  explicitly (trend systems must be tested *across* regimes).
- Key metric: profit factor, max drawdown, *and* the win-rate/avg-win-multiple
  tradeoff — confirm the convex payoff shape actually materializes.

**Feasibility: High · Edge plausibility: Medium · Priority: P2**

---

## 6. BTC/ETH (+ Basket) Statistical-Arbitrage Pairs

**1. The hypothesis**
Cointegrated pairs (BTC/ETH being the canonical one; also L1 baskets, or a coin
vs. a sector index) mean-revert their spread. Trade the spread, not the
direction: short the rich leg / long the cheap leg when the z-score of their
ratio deviates, close on reversion. Market-neutral, leverage-able aggressively.

**2. The mechanism**
Stat-arb is a 30-year-proven institutional edge (Morgan Stanley's original
program, D.E. Shaw, Renaissance-adjacent shops). Two economically linked assets
can't diverge indefinitely without an arbitrage force pulling them back. In
crypto, BTC/ETH share the same macro/risk-on driver, so their ratio is
mean-reverting around regime-dependent levels. The counterparty is anyone
trading one leg on idiosyncratic noise. Because it's market-neutral, you can run
high leverage on the *spread* for high return-on-capital while staying flat
directional crypto beta — that's the "aggressive but structurally hedged" profile
the brief asked for.

**3. Signal inputs required**
- `candles` for both legs → spread / ratio z-score. **Already captured.**
- Rolling cointegration / correlation estimation. **New compute, no new data.**
- `funding_rates` on both legs → net carry of holding the pair. **Already
  captured.**

**4. Natural fit with the existing system**
This is the *biggest* architectural departure — it requires **simultaneous
two-leg positions** with linked entry/exit, which the single-slot,
one-position-max architecture cannot express today. It also needs a
pair-selection / cointegration service. High effort. But the payoff (market-
neutral, leverage-tolerant, low correlation to everything else proposed here)
makes it a strong *portfolio diversifier* once the multi-position infrastructure
exists.

**5. Highest-risk assumption**
That the cointegration relationship is *stable* — pairs trading's classic failure
mode is a structural break where the spread diverges and never reverts (one coin
has a fundamental re-rating). Needs a hard stop on spread divergence and a
cointegration-validity monitor that exits when the relationship breaks down.

**6. Validation path**
- Backtest: estimate cointegration on BTC/ETH and 5–10 candidate pairs, trade
  z-score entries (±2σ), exit at 0σ, hard stop at ±3.5σ.
- Sample: 12+ months (cointegration needs long windows), rolling re-estimation.
- Key metric: spread Sharpe, half-life of mean-reversion, and the frequency of
  no-revert blowups (the tail that kills the strategy).

**Feasibility: Medium · Edge plausibility: Medium-High · Priority: P3
(gated on multi-position infrastructure)**

---

## Wild card — Sentiment/Narrative-Momentum overlay (violates a current assumption)

> *Per Alpha-Forge rules: one left-field idea that breaks a current constraint.*

**The assumption it violates:** "Strategies are pure and deterministic — no I/O,
no external data" (CLAUDE.md trading-safety invariant). This deliberately reaches
*outside* market data.

**The idea:** Crypto's strongest short-horizon driver is *attention*. A
narrative/sentiment momentum signal — derived from a feed of social/news velocity
(e.g., a per-symbol attention score: mention-rate acceleration, funding+OI surge
as an attention *proxy* if we want to stay market-internal) — used to **tilt**
one of the strategies above toward coins whose attention is *accelerating*.
Successful crypto discretionary traders are, fundamentally, narrative traders;
this systematizes the part of their edge that pure price-momentum misses (it
front-runs the price-momentum signal by catching attention *before* it fully
prints in returns).

**Why it's a wild card and not P1:** it breaks the deterministic-strategy
invariant (the social feed is non-reproducible I/O, which wrecks backtest
fidelity and the live/backtest contract). The *market-internal proxy* version
(attention ≈ OI-acceleration + funding surge + volume spike, all already
captured) keeps determinism and is the version worth a small shadow soak — it's
essentially a momentum *accelerant* filter layered on Proposal 1 or 2. The true
social-feed version would need an architectural carve-out (an attention service
feeding a snapshot column, deterministically replayable) before it could ever
touch the live loop.

**Smallest experiment:** compute the market-internal attention proxy on the
existing universe, bucket Proposal-1 momentum signals by attention-acceleration,
and check whether the high-attention bucket out-returns. Pure offline analysis on
existing data — near-zero cost to test.

---

## Alpha-Forge's recommendation (what I'd build next, in order)

1. **Cross-sectional momentum (P1)** — highest conviction, best-documented edge,
   backtests cleanly on existing candle data, and the 200–300 symbol universe is
   tailor-made for it. Start with the single-slot proxy (mode a) to validate the
   signal under the current risk constraints, then push for slot relaxation to
   capture the basket Sharpe.
2. **Liquidation-cascade follow (P1)** — the most crypto-native, asymmetric-payoff
   idea, and it finally uses the OI/funding/liquidation-distance data the bot
   already collects but never converted to edge. Shadow-soak it (don't trust the
   backtest in cascade regimes).
3. **OI-divergence directional (P2)** — cheapest to build (data already in
   `positions`), and it salvages the *intent* behind v3's flow router as a
   standalone, validated edge. Good fast follow on the now-fixed OI harness.

Proposals 3 (funding), 5 (breakout), 6 (pairs) are strong but each carries one
specific dependency — funding needs a timing confirmation, breakout needs the
time-stop replaced with a trail, pairs needs multi-leg infrastructure.

**Cross-cutting architectural truth:** the two ideas with the highest ceiling
(cross-sectional momentum basket, stat-arb pairs) both want **concurrent
multi-position** support, which the current single-slot live constraint forbids.
That constraint exists for good capital-safety reasons at the current stage — but
it is the binding limit on the *highest-Sharpe* strategies. Worth an explicit
decision: validate momentum/cascade single-slot first, and treat "relax to
N-position dollar-neutral basket" as the gated next phase once an edge is
confirmed live.

**What I would NOT do:** keep tuning the VWAP-deviation trigger. The registry has
already spent EXP-001 through EXP-010 proving that well is dry. New trigger, new
edge.

---

### Suggested next steps (smallest validating action per idea)
- **P1 momentum:** offline decile-spread backtest on `candles` — 1 analysis doc,
  no engine change. If the spread is monotone and >1.0 gross Sharpe, promote.
- **P1 cascade:** ingest the Binance `!forceOrder` liquidation stream into a
  shadow detector; 3–4 week soak measuring conditional forward-return tails.
- **P2 OI-divergence:** quadrant forward-return study on the fixed OI harness —
  reuses existing analysis tooling.

*All three first steps are analysis/shadow work — no live capital, no risk-gate
changes — consistent with the project's conservative-survival mandate.*
