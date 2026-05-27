// Exchange-agnostic snapshot shapes returned by IExchangeClient. These are the
// boundary types: ccxt's own structures are normalised into these here and never
// leak past ExchangeModule. Money/price/volume fields are decimal-as-string (the
// raw exchange numbers are parsed into strings so no float math precedes Decimal).

export interface IMarketInfo {
    symbol: string;
    base: string;
    quote: string;
    settle: string | null;
    active: boolean;
    isLinearPerpetual: boolean;
    contractSize: string | null;
    pricePrecision: number | null;
    amountPrecision: number | null;
    // Real exchange filters for M5 sizing/quantization, sourced from ccxt market.limits
    // (decimal-as-string, never float): price increment, amount increment, min order
    // notional. Null when the exchange does not report the limit (caller falls back).
    tickSize: string | null;
    stepSize: string | null;
    minNotional: string | null;
}

export interface ITickerSnapshot {
    symbol: string;
    timestampMs: number;
    last: string | null;
    bid: string | null;
    ask: string | null;
    // 24h quote-asset (USDT) volume — drives universe ranking.
    quoteVolume: string | null;
}

export interface IBalanceSnapshot {
    asset: string;
    free: string;
    used: string;
    total: string;
}

export interface IOpenInterestSnapshot {
    symbol: string;
    timestampMs: number;
    openInterestAmount: string | null;
    openInterestValue: string | null;
}

export interface IFundingRateSnapshot {
    symbol: string;
    // Quote/poll wall-clock time of THIS observation (when we fetched it).
    timestampMs: number;
    // The 8h SETTLEMENT boundary this rate applies to (ccxt fundingTimestamp). Kept
    // separate from timestampMs so funding_rates de-dups to one row per settlement,
    // not one per poll, and the backtest replays funding as it actually settled.
    fundingTimestampMs: number | null;
    fundingRate: number | null;
    markPrice: string | null;
    fundingIntervalHours: number | null;
}

export interface IOrderBookLevel {
    price: string;
    amount: string;
}

export interface IOrderBookSnapshot {
    symbol: string;
    timestampMs: number;
    bids: IOrderBookLevel[];
    asks: IOrderBookLevel[];
}

// Boundary type for an order placed/queried via IExchangeClient. ccxt's Order shape is
// normalised into decimal-as-string fields so no float math precedes Decimal upstream. The
// `status` is the lower-case ccxt status ('open' | 'closed' | 'canceled' | 'expired' |
// 'rejected') — ExecutionService maps it to the internal SubmitStateEnum (ADR 0006 §2).
export interface IExchangeOrderSnapshot {
    exchangeOrderId: string | null;
    clientOrderId: string | null;
    symbol: string;
    status: string;
    type: string;
    side: string;
    reduceOnly: boolean;
    price: string | null;
    average: string | null;
    amount: string | null;
    filled: string | null;
    remaining: string | null;
    cost: string | null;
    fee: string | null;
    feeCurrency: string | null;
    timestampMs: number | null;
}

// Request shape consumed by IExchangeClient.createOrder. Money/qty/price arrive as decimal
// strings (the ExecutionModule keeps everything in decimal.js up to the boundary). Optional
// `params` carry exchange-specific knobs (reduceOnly, closePosition, workingType, etc.).
export interface ICreateOrderRequest {
    symbol: string;
    type: string; // 'market' | 'limit' | 'stop_market' | 'take_profit_market'
    side: string; // 'buy' | 'sell'
    amount: string; // decimal-as-string
    price?: string | null;
    clientOrderId: string;
    params?: Record<string, unknown>;
}

export interface ITradeSnapshot {
    symbol: string;
    timestampMs: number;
    price: string;
    amount: string;
    // Aggressor side: 'buy' = taker bought (lifted ask), 'sell' = taker sold.
    isBuyerAggressor: boolean;
}

// M6 W4a (ADR 0010 §7 — exchange port block): exchange-side position snapshot,
// returned by `IExchangeClient.fetchPositions()`. One entry per non-zero
// `(symbol, side)` pair. `side` is the lower-case ccxt string ('long' | 'short');
// the ReconciliationService normalises to PositionSideEnum at the boundary.
// Money fields are decimal-as-string at the exchange boundary so no float math
// precedes Decimal upstream (consistent with the rest of IExchangeSnapshots).
//
// `qty` is `|contracts|`: ccxt reports contracts as a signed number for some
// venues; the ExchangeClient flattens to magnitude and exposes `side` separately,
// matching how the DB `positions` row stores them (qty is non-negative, side
// is a separate column).
export interface IPositionSnapshot {
    symbol: string;
    side: string;
    qty: string;
    entryPrice: string | null;
    markPrice: string | null;
    liquidationPrice: string | null;
    marginType: string | null;
    leverage: string | null;
    timestampMs: number | null;
}

// M6 W5 (ADR 0012 §2): exchange-side funding-payment snapshot. One entry per
// `incomeType=FUNDING_FEE` row returned by the venue's income endpoint (ccxt's
// `fetchFundingHistory`). `amount` is signed at the exchange boundary
// (positive = received, negative = paid), preserved as decimal-as-string so no
// float math precedes Decimal upstream. `id` is the exchange's tranId — used as
// the deterministic dedupe key for the `transactions` `client_order_id` per
// `funding-${positionId}-${fundingTimeMs}` rule (ADR 0012 §1).
export interface IFundingPaymentSnapshot {
    // Exchange tranId (Binance USDT-M futures returns it as a string in `info.tranId`,
    // ccxt unifies to `id`). Nullable if the venue does not surface one — the engine
    // falls back to `(positionId, fundingTimeMs)` for dedupe.
    id: string | null;
    symbol: string;
    // 8h settlement boundary (Binance income time). Always present for FUNDING_FEE rows.
    fundingTimeMs: number;
    // Signed amount in the venue's settlement asset (USDT for USDT-M). Decimal-as-string.
    amount: string;
    // The settlement asset code reported by the venue (e.g. 'USDT'). Informational.
    asset: string;
}

// M6 W4a (ADR 0010 §7): exchange-side open-order snapshot for case (e)
// PROTECTIVE_ORDER_DRIFT detection. Reconciliation reads `clientOrderId` to
// match against the `-sl` / `-tp` suffix-bearing orders the protective attacher
// minted (ADR 0008 §1 step 3); `reduceOnly` distinguishes a protective close
// order from a strategy entry; `type` and `status` are the ccxt lower-case
// strings ('stop_market' | 'take_profit_market' | 'limit' | ...; 'open' | 'closed'
// | 'canceled' | ...). Only fields the engine cares about for protective drift
// detection are required; richer fields stay opt-in for future cases.
export interface IOpenOrderSnapshot {
    exchangeOrderId: string | null;
    clientOrderId: string | null;
    symbol: string;
    status: string;
    type: string;
    side: string;
    reduceOnly: boolean;
    timestampMs: number | null;
}
