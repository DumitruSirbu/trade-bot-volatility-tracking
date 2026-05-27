import { IBalance, IFunding, IOrder, IPosition } from '../interface/index.js';

/**
 * Account-state port: the abstraction over account balance, positions, and funding.
 *
 * Two implementations:
 * - `ExchangeAccountStateSource` (LIVE / TESTNET) — delegates to ccxt.
 * - `PaperAccountStateSource` (PAPER) — backed by the in-memory
 *   `PaperAccountStateService`.
 *
 * The engine injects this port into callers like `AccountSnapshotWriter`,
 * reconciliation, funding accrual, and read-API account projections. In PAPER mode,
 * this binding ensures account-state reads come from the local simulation, not the
 * live exchange.
 *
 * Exception list (D14): the following two services are explicitly whitelisted to
 * call the live ccxt account-state methods directly via `IExchangeClient`:
 * 1. `KeyPermissionAssertionService` (boot-time `/sapi` calls for key validation).
 * 2. `PaperExchangeNullityProbe` (defence-in-depth probe that asserts the live
 *    exchange holds no engine-attributed positions/orders under the PAPER key).
 *
 * Compile-time invariant: `PaperAccountStateSource` does **not** import any ccxt
 * module, so an accidental reach for the live exchange from the decision path is a
 * build-time error (ADR 0032 §3 D14).
 *
 * Runtime guard: capability-tagged `AsyncLocalStorage` proxy on the two whitelisted
 * methods rejects any call without the matching tag, and an ESLint CI gate bans
 * `ModuleRef.get(IExchangeClient)` outside the whitelisted file set.
 *
 * @cite ADR 0032 §3 D14 — `IAccountStateSource` port (full surface, not only orders)
 * @cite M11a R2a.1b — typed DTOs replace Record<string, unknown>
 */
export interface IAccountStateSource {
	/**
	 * Fetch the account balance snapshot (free, used, total for each asset).
	 */
	fetchBalance(): Promise<IBalance[]>;

	/**
	 * Fetch all open positions (holding state), optionally filtered by symbol.
	 */
	fetchPositions(symbol?: string): Promise<IPosition[]>;

	/**
	 * Fetch all open (resting) orders, optionally filtered by symbol.
	 * Shared across both ports for consistency; also on `IExecutionClient`
	 * because the engine treats it as part of the order-lifecycle surface.
	 */
	fetchOpenOrders(symbol?: string): Promise<IOrder[]>;

	/**
	 * Fetch historical funding payments since a given timestamp (epoch ms).
	 */
	fetchFundingHistory(
		symbol: string,
		since: number,
	): Promise<IFunding[]>;
}
