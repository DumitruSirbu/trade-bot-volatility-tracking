# ADR 0001 — Exchange integration & market-data boundary (M1)

Status: Accepted
Date: 2026-05-22
Milestone: M1 — Exchange integration & market data

## Context

M1 must deliver a live, single-socket market-data pipeline over the top 200–300
USDT-M perpetuals, aggregate 5-minute candles, compute a per-symbol indicator
snapshot on closed bars only, and emit two events: `price.update` (every tick) and
`volatility.detected` (when the shared trigger fires on a closed bar). No DB writes
and no orders yet (those are M2 / M5).

Several constraints are non-negotiable and shape every decision below:

- Only one module may talk to Binance (so the exchange stays swappable and the order
  path can be audited in one place).
- The trigger that fires `volatility.detected` must be **the exact same code** that
  the M7 backtest runs, or live and replay diverge — a trading-safety invariant.
- Indicators must read **closed bars only**: any peek into the forming candle is
  look-ahead bias that inflates backtest results and cannot be reproduced live.
- Money/price fields are `decimal`, never float; across the workspace boundary they
  serialize as `string`.
- `~300 symbols × deep order books` is not affordable on one socket, so depth/OI must
  be tiered, not streamed for everyone.

## Decision

### 1. ExchangeModule vs MarketDataModule boundary

**ExchangeModule** is a thin `ccxt` wrapper and the *only* code that talks to Binance.
It owns transport, auth, reconnection, rate-limit handling, and exchange-specific
symbol/precision metadata. It exposes an **exchange-agnostic interface** (`IExchangeClient`)
in raw exchange units — it does **no** indicator math and holds **no** rolling state.

It wraps the stable `ccxt` / `ccxt.pro` unified methods only (never Binance REST paths
inline): `loadMarkets()`, `fetchBalance()`, `fetchOpenInterest(symbol)`,
`fetchFundingRate(symbol)`, and the streaming `watchTickers()` (the `!ticker@arr`
all-symbol stream), `watchOrderBook(symbol)`, `watchTrades(symbol)`. All `ccxt` errors
are caught at this boundary and rethrown as domain exceptions (per code-conventions
"Integration calls" rule); `ccxt` types never leak past `ExchangeModule`.

**MarketDataModule** is the only consumer of `IExchangeClient`. It owns:

- the universe (top 200–300 by 24h volume + liquidity floor), tier assignment, and
  symbol-universe age; emits enter/leave membership transitions;
- 5-minute (and 1-minute, for M2) candle aggregation from the tick stream;
- per-symbol indicator state (VWAP anchors, σ-band, ATR/ADX/RSI/Bollinger, volume
  ratio, BTC reference move, idiosyncrasy score, regime label, market breadth, fast
  market-stress inputs, empirical band stats);
- the **tiered** depth/OI/aggressor subscriptions (below);
- evaluating the shared trigger on each closed bar and emitting `price.update` /
  `volatility.detected`.

Rule of thumb: if it speaks the wire protocol → ExchangeModule; if it holds rolling
state or derives a number → MarketDataModule.

### 2. Single-socket `!ticker@arr` + tiered "practical compromise"

One `watchTickers()` subscription (`!ticker@arr`) feeds the whole universe: it drives
breadth, the broad price/volume tape, and candle aggregation for every symbol. We do
**not** open per-symbol depth books for ~300 symbols.

The tiered subscription policy:

- **Always-on, all symbols:** the single `!ticker@arr` ticker stream + per-symbol mark
  price/funding where practical.
- **Polled, all symbols, slow cadence:** Open Interest via `fetchOpenInterest`
  (REST — no all-symbol OI socket exists), at a baseline interval.
- **Escalated, "approaching trigger" symbols only:** when a symbol nears the trigger
  thresholds, MarketDataModule raises its tier — faster OI polling, an order-book
  depth subscription (`watchOrderBook`), and aggressor-imbalance capture
  (`watchTrades`). On a confirmed `volatility.detected`, the depth snapshot is the
  value carried in the payload (and persisted in M2 only around decisions/positions).

"Approaching trigger" is defined locally by MarketDataModule from already-streamed
ticker data (e.g. partial-σ / partial-volume proximity); it does not require deep
data, which is exactly what it is gating access to.

### 3. The shared live/backtest trigger function

There is **one** trigger function, owned by the engine workspace, imported by both the
live MarketDataModule and the M7 BacktestModule (both live in `apps/engine`, so the
*implementation* may stay internal to the engine). It is a **pure, deterministic,
direction-agnostic event detector**:

- Input: a closed-bar indicator snapshot (`IClosedBarTriggerInput`) + resolved trigger
  params (`ITriggerParams`). No `Date.now()`, no `Math.random()`, no I/O.
- Output: a small decision object (`ITriggerResult`) — `fired: boolean`, the deviation
  `side`, and which conditions passed (for logging/calibration).

It fires on a closed 5-min bar when **all** hold:

1. `abs(vwapDeviationSigma) >= params.vwapSigmaTrigger`
2. `volumeRatio >= params.volumeRatioMin`
3. `abs(vwapDeviationPct) >= params.tierMinAbsMovePct`
4. `abs(vwapDeviationPct) <= params.tierMaxAbsMovePct`

σ is a **normalized distance, not a probability** (crypto returns are fat-tailed; bands
are calibrated empirically). `side` is the **deviation direction of the event**
(price above vs below VWAP), explicitly **not** a trade direction — direction is
decided downstream by the strategy. A unit test pins the function against a known
candle series. The function's **input/output types are the cross-workspace contract**
(see contract spec) even though the body stays in the engine, because the strategy and
backtest consume those types.

### 4. In-memory per-symbol indicator state (closed-bars-only)

Each symbol owns an indicator-state object holding bounded rolling windows of
**closed** bars only. The forming (current) 5-min candle is accumulated separately and
is **never** read by indicators or the trigger; it only graduates into the closed-bar
windows when its 5-min boundary elapses. Indicators (VWAP anchors, σ, ATR(14),
ADX(14)/±DI, RSI(14), Bollinger %B, volume ratio over 20 bars) recompute on each
bar-close event, then the trigger is evaluated, then events emit. This ordering — close
→ recompute → evaluate → emit — is what guarantees live and backtest produce identical
snapshots from identical bar sequences. State classes stay internal to the engine.

### 5. What goes in `packages/shared` vs the engine

`packages/shared` (the cross-workspace **contract**, consumed by engine + future
dashboard): the two event payload interfaces, all the enums, the trigger function's
input/output types (`IClosedBarTriggerInput`, `ITriggerResult`, `ITriggerParams`), and
any view types. Money/price fields here are `string`.

Stays internal to `apps/engine`: the `IExchangeClient` wrapper and ccxt usage, the
indicator-state classes, the candle aggregator, the universe/tier manager, and the
**body** of the trigger function (backtest is also in the engine workspace, so sharing
the implementation across workspaces is unnecessary — only its types are the contract).

## Consequences

- A single chokepoint (`ExchangeModule`) for all Binance I/O keeps the exchange
  swappable and gives M5 one place to add the audited order path.
- Live and backtest cannot diverge on the trigger by construction (same function,
  shared types, no wall-clock/RNG).
- Closed-bars-only removes the most common silent backtest-inflation bug at the source.
- Tiering keeps the data plane within one socket + bounded REST polling, at the cost of
  having no deep book for symbols that never approach the trigger — acceptable, since we
  only act on triggered symbols.
- `decimal`-as-`string` on the wire forces a parse/format boundary but protects
  accounting from float drift.
- Risk: a symbol can move violently between OI polls; mitigated by escalated polling for
  approaching-trigger symbols and by M4's fast market-stress inputs.

## Alternatives considered

- **Per-symbol ticker sockets instead of `!ticker@arr`.** Rejected: ~300 connections,
  fragile reconnection, and Binance connection limits. One array stream is the whole
  point of `!ticker@arr`.
- **Stream full order books for the entire universe.** Rejected: bandwidth/CPU blow-up
  and Binance stream caps; we only need depth around triggers.
- **Indicators in ExchangeModule (one "data" module).** Rejected: violates single
  responsibility and couples transport to math; the exchange would no longer be
  cleanly swappable and the order path harder to isolate.
- **Separate live and backtest trigger implementations kept "in sync" by review.**
  Rejected outright — drift is inevitable and silent; it breaks the core invariant.
- **Read the forming candle for "fresher" signals.** Rejected: textbook look-ahead
  bias; un-reproducible live and inflates backtests.
- **Put the trigger implementation in `packages/shared`.** Rejected as unnecessary:
  backtest lives in the engine workspace, so only the input/output *types* need to be
  shared; the body stays internal.

## See also

- Contract specification + build-order note: sections below in this ADR.
- `docs/plans/archive/M1-exchange-market-data.md`, `docs/plans/00-overview.md`

---

# Contract specification (for `bot-shared-maintainer`, implement verbatim in `packages/shared`)

All names follow `code-conventions.md`: interfaces `I`-prefixed, enums `Enum`-suffixed,
TS properties camelCase, enum string **values** snake_case (matching DB), money/price
fields typed `string` (decimal serialized across the wire), non-money scores/ratios/
counts typed `number`. Suggested layout: `packages/shared/src/enum/`, `.../interface/`,
each with a barrel re-exported from `src/index.ts`.

## Enums

```ts
// RegimeLabelEnum.ts
export enum RegimeLabelEnum {
    RANGING = 'ranging',
    TRENDING_UP = 'trending_up',
    TRENDING_DOWN = 'trending_down',
    TRANSITIONING = 'transitioning',
}

// CoinTierEnum.ts  (tier1 = top 50, tier2 = 51–150, tier3 = 151–300)
export enum CoinTierEnum {
    TIER_1 = 'tier1',
    TIER_2 = 'tier2',
    TIER_3 = 'tier3',
}

// VwapAnchorTypeEnum.ts
export enum VwapAnchorTypeEnum {
    ROLLING_20BAR = 'rolling_20bar',
    ROLLING_24H = 'rolling_24h',
    SESSION = 'session',
    EVENT_ANCHORED = 'event_anchored',
}

// DeviationSideEnum.ts
// NOTE: this is the deviation DIRECTION of the event (price vs VWAP),
// NOT a trade direction. Trade direction is decided downstream by the strategy.
export enum DeviationSideEnum {
    ABOVE = 'above', // price above VWAP (positive deviation)
    BELOW = 'below', // price below VWAP (negative deviation)
}

// FlowTypeEnum.ts
// PLACEHOLDER — values are provisional; flow is classified in M3.
// Carried as a placeholder field on the M1 payload so the contract is stable.
export enum FlowTypeEnum {
    UNCLASSIFIED = 'unclassified',
    LIQUIDATION_CASCADE = 'liquidation_cascade',
    NEW_MONEY = 'new_money',
    CATALYST = 'catalyst',
}
```

## `price.update` payload

```ts
// IPriceUpdateEvent.ts — emitted on each tick
export interface IPriceUpdateEvent {
    symbol: string;
    price: string;           // decimal-as-string (money)
    timestampMs: number;     // exchange event time, epoch ms (transport metadata, not money)
}
```

## `volatility.detected` payload

Emitted when the shared trigger fires on a closed 5-min bar. Every field from the M1
"Emit events" task is enumerated. Money/price fields are `string`; scores, ratios,
percentages-as-numbers, ranks, counts, and ages are `number`; enums as declared above.

```ts
// IVolatilityDetectedEvent.ts
export interface IVolatilityDetectedEvent {
    // identity / event meta
    symbol: string;
    side: DeviationSideEnum;          // deviation direction, NOT trade direction
    entryCandleOpenTime: number;      // closed-bar open time, epoch ms

    // VWAP / deviation
    vwapSession: string;              // decimal-as-string (price)
    vwap20bar: string;                // decimal-as-string (price)
    vwapAnchorType: VwapAnchorTypeEnum;
    vwapDeviationPct: number;         // % deviation (not money)
    vwapDeviationSigma: number;       // normalized distance (not a probability)

    // volume
    volumeRatio: number;              // currentBarVolume / 20bar avg
    volume20barAvg: string;           // decimal-as-string (base-asset volume)

    // indicators
    atr14: string;                    // decimal-as-string (price units)
    adx14: number;
    adxDiPlus: number;
    adxDiMinus: number;
    rsi14: number;
    bollingerUpper: string;           // decimal-as-string (price)
    bollingerLower: string;           // decimal-as-string (price)
    bollingerPctB: number;

    // BTC reference / idiosyncrasy
    btc5mMovePct: number;
    idiosyncrasyScore: number;        // clamped [0,1]

    // universe / liquidity context
    coinTier: CoinTierEnum;
    coinVolumeRank: number;
    symbolUniverseAgeHours: number;

    // funding / flow context
    fundingRate: number;              // periodic rate (ratio, not money)
    fundingRateAnnualized: number;
    openInterest: string;             // decimal-as-string (contracts/notional)
    openInterestChange5mPct: number;
    openInterestChange15mPct: number;
    aggTradeBuyVolumeRatio: number;   // buy vol / (buy+sell) over trigger window

    // order-book / spread (captured around trigger)
    bidAskSpreadPct: number;
    bookDepth10bpsUsdt: string;       // decimal-as-string (USDT notional)
    bookDepth50bpsUsdt: string;       // decimal-as-string (USDT notional)

    // breadth / stress / regime
    regimeLabel: RegimeLabelEnum;
    marketBreadth5mUpPct: number;
    sameBarTriggerCount: number;
    btc1mMovePct: number;
    eth5mMovePct: number;

    // classified in M3 — placeholder in M1
    flowType: FlowTypeEnum;
}
```

## Trigger function input / output types

```ts
// IClosedBarTriggerInput.ts — the closed-bar snapshot the trigger reads (pure input)
export interface IClosedBarTriggerInput {
    symbol: string;
    vwapDeviationSigma: number;  // normalized distance from the active VWAP anchor
    vwapDeviationPct: number;    // signed % deviation; sign yields the side
    volumeRatio: number;         // currentBarVolume / 20bar avg
}

// ITriggerParams.ts — resolved per evaluation (see source-of-truth note)
export interface ITriggerParams {
    vwapSigmaTrigger: number;
    volumeRatioMin: number;
    tierMinAbsMovePct: number;
    tierMaxAbsMovePct: number;
}

// ITriggerResult.ts — boolean decision + audit detail
export interface ITriggerResult {
    fired: boolean;
    side: DeviationSideEnum;     // derived from sign(vwapDeviationPct)
    sigmaConditionMet: boolean;
    volumeConditionMet: boolean;
    minMoveConditionMet: boolean;
    maxMoveConditionMet: boolean;
}
```

### Trigger params — source of truth

`ITriggerParams` is resolved at evaluation time, never hard-coded in the trigger body:

- `vwapSigmaTrigger`, `volumeRatioMin` come from the active strategy version's
  `params` (jsonb on `strategy_versions`) — calibrated empirically (M7), versioned.
- `tierMinAbsMovePct`, `tierMaxAbsMovePct` are **per-tier** bands resolved from the
  symbol's `CoinTierEnum` via engine-side constants in
  `apps/engine/src/<market-data>/const/*Consts.ts` (UPPER_SNAKE_CASE), overridable by
  the strategy version's params. Keeping them in `const/` (not inline) is required by
  the constants-placement rule.

The trigger reads `abs()` of the deviation fields for conditions 1/3/4 and derives
`side` from the sign of `vwapDeviationPct`.

---

# Build-order note

1. **`bot-shared-maintainer` first (serial).** Implement the enums, `IPriceUpdateEvent`,
   `IVolatilityDetectedEvent`, and the trigger I/O types
   (`IClosedBarTriggerInput` / `ITriggerParams` / `ITriggerResult`) exactly as specified,
   with barrels. Nothing downstream compiles without this.

2. **`bot-engine-nestjs` next.** Within the engine, `ExchangeModule` (`IExchangeClient`
   ccxt wrapper) and `MarketDataModule` can largely proceed in **parallel** once the
   `IExchangeClient` interface signature is agreed: ExchangeModule implements it;
   MarketDataModule codes against the interface and can use a stub/fake until the real
   client lands. The shared **trigger function** + its unit test should land early
   inside the engine so candle/indicator wiring can target it.

3. **Parallelizable:** indicator-state classes, candle aggregator, and the
   universe/tier manager are independent of each other and of the order path (none
   exists yet in M1).

## Key risks to defend in review

- **Look-ahead bias.** Reviewers must confirm indicators/trigger read closed bars only;
  the forming candle must be physically separate from the closed-bar windows.
- **Float money math.** Price/VWAP/ATR/depth/OI fields are `decimal` in the engine and
  `string` on the wire; any `number` arithmetic on a money value is a must-fix.
- **Trigger divergence.** Exactly one trigger function, pure/deterministic, imported by
  both live and backtest; no second copy, no `Date.now()`/`Math.random()`/I/O inside it.
- **Tiering correctness.** "Approaching trigger" must be computed from already-streamed
  ticker data only — it must not require the deep data it is gating.
