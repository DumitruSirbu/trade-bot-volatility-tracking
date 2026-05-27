import { IKeyPermissionSnapshot } from '@bot/shared';

import {
    IBalanceSnapshot,
    IFundingPaymentSnapshot,
    IFundingRateSnapshot,
    IMarketInfo,
    IOpenInterestSnapshot,
    IOpenOrderSnapshot,
    IOrderBookSnapshot,
    IPositionSnapshot,
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

    // M11a R2a.3 (ADR 0032 §3 D2). The order-command surface (`createOrder` /
    // `fetchOrderByClientId` / `cancelOrderByClientId`) was extracted to
    // `CcxtExecutionClient` so the shared `IExecutionClient` port can swap a
    // `PaperExecutionClient` in PAPER mode. `IExchangeClient` now owns only
    // connection management, market-data, key permissions, and the residual
    // account-state surface used by the two D14 whitelisted callers.

    // --- M6 W4a reconciliation surface (ADR 0010 §2, §7) ---
    //
    // Exchange-side truth read by `ReconciliationService` ONLY. Per ADR 0010 §6 reviewer
    // rule: "No code path calls `exchange.fetchPositions()` or `fetchOpenOrders()` outside
    // the reconciliation service (other readers consume the in-memory cache). One source of
    // truth pull per tick."
    //
    // `fetchPositions` returns one entry per NON-ZERO `(symbol, side)` pair; zero-qty
    // positions are filtered at the client boundary so the reconciliation tick never has
    // to re-filter. `fetchOpenOrders` returns all resting orders across symbols — used
    // for case (e) protective-drift detection (matching the `-sl` / `-tp` suffix on
    // `clientOrderId`).
    fetchPositions(): Promise<readonly IPositionSnapshot[]>;

    fetchOpenOrders(): Promise<readonly IOpenOrderSnapshot[]>;

    // --- M6 W5 funding-history surface (ADR 0012 §2) ---
    //
    // Returns FUNDING_FEE income rows for the given `symbol` since the `sinceMs`
    // boundary (inclusive lower bound; the venue may return rows >= sinceMs). The
    // reconciliation tick is the ONLY caller; per-symbol filtering keeps the payload
    // bounded so the 30s cadence does not pull the full account history each tick.
    // Failures bubble up as ExchangeRequestException (callers swallow per-tick errors
    // and retry on the next sweep — funding ingestion must NOT cascade into the main
    // strategy loop).
    fetchFundingHistory(symbol: string, sinceMs: number): Promise<readonly IFundingPaymentSnapshot[]>;

    // M11a W1.2 (ADR 0028 §2.2). Capability + IP-allow-list snapshot used by
    // the startup allowlist gate. Implementations merge
    // `sapiGetAccountApiRestrictions` + `sapiGetAccountApiRestrictionsIpRestriction`
    // into a single `IKeyPermissionSnapshot`. Throws `ExchangeRequestException`
    // on any underlying ccxt failure — the boot caller treats that as
    // assertion-failure, never as "skip and continue."
    fetchKeyPermissions(): Promise<IKeyPermissionSnapshot>;

    // Releases the underlying socket(s); called on shutdown.
    close(): Promise<void>;
}

// DI token — the interface is erased at runtime, so providers bind to this symbol.
export const EXCHANGE_CLIENT = Symbol('EXCHANGE_CLIENT');
