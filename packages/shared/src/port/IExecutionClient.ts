import { IOrder, IOrderIntent } from '../interface/index.js';

/**
 * Order-command port: the abstraction over order placement and lifecycle.
 *
 * Two implementations:
 * - `CcxtExecutionClient` (LIVE / TESTNET) — delegates to ccxt, rate-limited.
 * - `PaperExecutionClient` (PAPER) — delegates to the local fill simulator.
 *
 * The engine injects this port into the execution loop; it never injects the
 * concrete ccxt client directly. This boundary permits PAPER mode to intercept
 * orders before they leave the process.
 *
 * Account-state reads (balance, positions, funding history) are **not** on this
 * port; they live on `IAccountStateSource` (ADR 0032 §3 D2).
 *
 * Compile-time invariant: `PaperExecutionClient` does **not** import the
 * `RateLimitPolicyService` module, so an accidental rate-limit call from PAPER
 * is a build-time error (ADR 0032 §3 D2).
 *
 * @cite ADR 0032 §3 D2 — `IExecutionClient` surface (frozen — order commands only)
 * @cite M11a R2a.1b — typed DTOs replace Record<string, unknown>
 */
export interface IExecutionClient {
	/**
	 * Place an order based on the intent and return the resulting order state.
	 */
	placeOrder(intent: IOrderIntent): Promise<IOrder>;

	/**
	 * Cancel a specific order by symbol and exchange order ID.
	 */
	cancelOrder(symbol: string, id: string): Promise<void>;

	/**
	 * Cancel all resting orders for a given symbol.
	 */
	cancelAllOrdersForSymbol(symbol: string): Promise<void>;

	/**
	 * Fetch the current status of a specific order.
	 */
	fetchOrderStatus(symbol: string, id: string): Promise<IOrder>;

	/**
	 * Fetch all open (resting) orders, optionally filtered by symbol.
	 * Kept here because the engine treats it as part of the order-lifecycle surface
	 * — pair with cancel/status (ADR 0032 §3 D2).
	 */
	fetchOpenOrders(symbol?: string): Promise<IOrder[]>;
}
