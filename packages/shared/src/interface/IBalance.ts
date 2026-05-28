/**
 * Per-asset balance snapshot from the exchange wallet.
 *
 * Money fields are decimal-as-string to avoid float precision loss across
 * the wire and throughout the application.
 *
 * @cite M11a R2a.1b — shared DTO for IAccountStateSource port
 */
export interface IBalance {
    /** Asset code (e.g., 'USDT', 'BTC'). */
    asset: string;

    /** Free balance available for trading. */
    free: string;

    /** Balance locked in open orders or positions. */
    used: string;

    /** Total balance (free + used). */
    total: string;
}
