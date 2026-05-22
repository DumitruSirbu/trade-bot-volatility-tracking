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

export interface ITradeSnapshot {
    symbol: string;
    timestampMs: number;
    price: string;
    amount: string;
    // Aggressor side: 'buy' = taker bought (lifted ask), 'sell' = taker sold.
    isBuyerAggressor: boolean;
}
