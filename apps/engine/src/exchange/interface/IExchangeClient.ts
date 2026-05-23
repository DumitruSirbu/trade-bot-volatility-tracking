import {
    IBalanceSnapshot,
    ICreateOrderRequest,
    IExchangeOrderSnapshot,
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

    // --- M5 order surface ---
    //
    // The ONLY methods that touch the exchange order API. Every caller must be inside
    // ExecutionModule (ADR 0005/0006 reviewer must-fix). Strategies, controllers, dashboards,
    // and reconciliation (M6) never call these directly — they go through ExecutionService.
    //
    // The `clientOrderId` in createOrder is the deterministic bot-controlled key (ADR 0006 §1);
    // fetchOrder looks an order up by it for the timeout-recovery protocol (ADR 0006 §3).
    createOrder(request: ICreateOrderRequest): Promise<IExchangeOrderSnapshot>;

    fetchOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null>;

    cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot>;

    // Releases the underlying socket(s); called on shutdown.
    close(): Promise<void>;
}

// DI token — the interface is erased at runtime, so providers bind to this symbol.
export const EXCHANGE_CLIENT = Symbol('EXCHANGE_CLIENT');
