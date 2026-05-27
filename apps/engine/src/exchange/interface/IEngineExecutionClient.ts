import { ICreateOrderRequest, IExchangeOrderSnapshot } from './IExchangeSnapshots';

// M11a R4 Item 4C — engine-shape order-command port (ADR 0032 §3 D2).
//
// The shared `IExecutionClient.placeOrder` returns shared `IOrder` and accepts
// shared `IOrderIntent` (minimal cross-boundary DTOs). The engine's M5
// execution loop consumes the richer engine-shape `ICreateOrderRequest →
// IExchangeOrderSnapshot` so it has full access to fee currency, average
// fill price, partial-fill quantities, and the ccxt-side params bag.
//
// Both `CcxtExecutionClient` (LIVE / TESTNET) and `PaperExecutionClient`
// (PAPER) implement this engine-shape surface so the three engine callers
// (`ExchangeOrderSubmitter`, `ProtectiveOrderAttacher`, `ExecutionService`'s
// future protective-orders surface) can inject via the
// `ENGINE_EXECUTION_CLIENT` port token without caring which adapter is wired.
//
// This sits ALONGSIDE the shared `IExecutionClient` port — it does NOT
// replace it. The shared port stays the minimal cross-boundary contract;
// this engine-internal port is the richer adapter used by the M5 surface
// until a future wave migrates the engine to consume shared `IOrder` end
// to end.
//
// COMPILE-TIME INVARIANT (per the same ESLint rule whitelist that guards
// EXCHANGE_CLIENT): only the `exchange/`, `execution/`, and
// `market-data/` module paths may inject this port.
export interface IEngineExecutionClient {
    createOrder(request: ICreateOrderRequest): Promise<IExchangeOrderSnapshot>;
    fetchOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null>;
    cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot>;
}
