/**
 * Order intent consumed by FillSimulatorCore.
 * Defines the order properties needed to simulate a fill.
 */
export interface IFillIntent {
    readonly side: 'long' | 'short';
    readonly action: 'open' | 'reduce' | 'close'; // mirrors 'intent' in backtest
    readonly policy: string; // e.g. OrderPolicyEnum.MARKETABLE_LIMIT_IOC
    readonly limitPrice: string; // decimal, the order's limit (or reference price for market)
    readonly qty: string; // decimal, base-asset quantity
    readonly postOnly: boolean; // true if POST_ONLY_MAKER
    readonly reduceOnly: boolean; // true if REDUCE order (unused in current fill logic but part of intent surface)
}
