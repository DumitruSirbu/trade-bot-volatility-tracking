/**
 * Position (holding) snapshot from the exchange. Represents one open position
 * (one symbol, one side).
 *
 * Money fields are decimal-as-string to avoid float precision loss across
 * the wire and throughout the application.
 *
 * @cite M11a R2a.1b — shared DTO for IAccountStateSource port
 */
export interface IPosition {
    /** Trading pair (e.g., 'BTCUSDT'). */
    symbol: string;

    /** Position side: 'long' | 'short'. */
    side: string;

    /** Absolute position size (contracts/amount). Non-negative; side column carries direction. */
    qty: string;

    /** Entry price of the position (volume-weighted average if multiple entries). */
    entryPrice: string | null;

    /** Current mark price (exchange's valuation price). */
    markPrice: string | null;

    /** Liquidation price at current leverage and margin type. */
    liquidationPrice: string | null;

    /** Margin type: 'isolated' | 'cross' etc. */
    marginType: string | null;

    /** Leverage factor (e.g., '5' for 5x). */
    leverage: string | null;

    /** Timestamp of the position snapshot (epoch milliseconds). */
    timestampMs: number | null;
}
