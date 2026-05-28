/**
 * Order state snapshot from the exchange. Represents a placed/queried order
 * with its current status, fills, and fees.
 *
 * Money fields are decimal-as-string to avoid float precision loss across
 * the wire and throughout the application.
 *
 * @cite M11a R2a.1b — shared DTO for IExecutionClient and IAccountStateSource ports
 */
export interface IOrder {
    /** Exchange-assigned order ID. Null if not yet assigned. */
    exchangeOrderId: string | null;

    /** Client-assigned order ID for deduplication. */
    clientOrderId: string | null;

    /** Trading pair (e.g., 'BTCUSDT'). */
    symbol: string;

    /** Order status: 'open' | 'closed' | 'canceled' | 'expired' | 'rejected' (lowercase ccxt convention). */
    status: string;

    /** Order type: 'market' | 'limit' | 'stop_market' | 'take_profit_market' etc. */
    type: string;

    /** Order side: 'buy' | 'sell'. */
    side: string;

    /** True when the order can only reduce an existing position (Binance reduce-only flag). Used by reconciliation to distinguish protective close orders (SL/TP) from strategy entries. */
    reduceOnly: boolean;

    /** Limit price (for limit orders). Null for market orders. */
    price: string | null;

    /** Volume requested. */
    amount: string | null;

    /** Volume filled so far (cumulative). */
    filled: string | null;

    /** Volume remaining to fill. */
    remaining: string | null;

    /** Total notional (price × filled quantity) at execution. */
    cost: string | null;

    /** Average fill price across all fills. Null if not filled or unknown. */
    average: string | null;

    /** Total fee paid for this order. Null if no fees or unknown. */
    fee: string | null;

    /** Asset in which fee was paid (e.g., 'USDT'). */
    feeCurrency: string | null;

    /** Timestamp when the order was created or last updated (epoch milliseconds). */
    timestampMs: number | null;
}
