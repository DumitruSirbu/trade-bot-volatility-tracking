import {
    IBalanceSnapshot,
    IFundingRateSnapshot,
    IMarketInfo,
    IOpenInterestSnapshot,
    IOrderBookSnapshot,
    ITickerSnapshot,
    ITradeSnapshot,
} from './IExchangeSnapshots';

// The exchange-agnostic contract. This is the ONLY surface the rest of the engine
// touches; the concrete ccxt implementation lives behind it so the exchange stays
// swappable and the (future) order path is auditable in one place. All methods
// reject with a domain ExchangeRequestException on failure — never a raw ccxt error.
//
// Streaming methods follow ccxt.pro semantics: each call resolves with the latest
// snapshot; callers loop (while-true) to consume the stream, and the client owns
// reconnection internally.
export interface IExchangeClient {
    loadMarkets(): Promise<IMarketInfo[]>;

    fetchBalance(): Promise<IBalanceSnapshot[]>;

    fetchOpenInterest(symbol: string): Promise<IOpenInterestSnapshot>;

    fetchFundingRate(symbol: string): Promise<IFundingRateSnapshot>;

    // REST full-snapshot of all tickers. Unlike the !ticker@arr socket frame (which
    // can be partial), this returns the complete set in one response — used to seed
    // and refresh the universe so tiers/ranks are never built from a partial frame.
    fetchTickers(): Promise<ITickerSnapshot[]>;

    // Resolves with the latest batch of ticker snapshots from the single
    // !ticker@arr all-symbol stream. Call in a loop to consume incremental updates.
    watchTickers(): Promise<ITickerSnapshot[]>;

    watchOrderBook(symbol: string): Promise<IOrderBookSnapshot>;

    watchTrades(symbol: string): Promise<ITradeSnapshot[]>;

    // Releases the underlying socket(s); called on shutdown.
    close(): Promise<void>;
}

// DI token — the interface is erased at runtime, so providers bind to this symbol.
export const EXCHANGE_CLIENT = Symbol('EXCHANGE_CLIENT');
