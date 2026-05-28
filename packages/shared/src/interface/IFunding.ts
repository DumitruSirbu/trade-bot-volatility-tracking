/**
 * Funding payment record from the exchange. Represents one funding settlement
 * event on a perpetual futures position.
 *
 * Money fields are decimal-as-string to avoid float precision loss across
 * the wire and throughout the application.
 *
 * @cite M11a R2a.1b — shared DTO for IAccountStateSource port
 * @cite IFundingPaymentSnapshot — the exchange boundary type
 */
export interface IFunding {
    /** Exchange transaction ID (if provided; used for deduplication). */
    id: string | null;

    /** Trading pair (e.g., 'BTCUSDT'). */
    symbol: string;

    /** 8-hour funding settlement boundary (epoch milliseconds). */
    fundingTimeMs: number;

    /** Signed funding payment: positive = received, negative = paid. */
    amount: string;

    /** Settlement asset code (e.g., 'USDT'). Informational. */
    asset: string;
}
