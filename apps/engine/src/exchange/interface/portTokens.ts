// DI tokens for the M11a R2a shared-port surface (ADR 0032 §3 D2 + D14).
//
// `IExecutionClient` and `IAccountStateSource` are TypeScript interfaces from
// `@bot/shared` — erased at runtime — so Nest providers must bind to a symbol.
// Two ports + two LIVE-or-TESTNET adapters + two PAPER stub adapters. The
// module-level factory dispatches on `EXCHANGE_ENV` (see ExchangeModule).

export const EXECUTION_CLIENT = Symbol('EXECUTION_CLIENT');
export const ACCOUNT_STATE_SOURCE = Symbol('ACCOUNT_STATE_SOURCE');

// M11a R4 Item 4C — engine-shape order-command port (see
// `IEngineExecutionClient`). Distinct from `EXECUTION_CLIENT` because the
// engine-shape surface returns the richer engine-internal
// `IExchangeOrderSnapshot` rather than shared `IOrder`. Same env-conditional
// dispatch as `EXECUTION_CLIENT` (PAPER → PaperExecutionClient,
// LIVE/TESTNET → CcxtExecutionClient).
export const ENGINE_EXECUTION_CLIENT = Symbol('ENGINE_EXECUTION_CLIENT');
