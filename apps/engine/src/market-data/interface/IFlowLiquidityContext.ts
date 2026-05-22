import { MoneyValue } from '../../common/utils/money';

// Flow / liquidity / order-book context assembled around a trigger from the tiered
// subscriptions (OI poll, funding poll, aggressor capture, depth snapshot). Any
// field may be null when its (escalated) data was not yet available at trigger time.
export interface IFlowLiquidityContext {
    openInterest: MoneyValue | null;
    openInterestChange5mPct: number | null;
    openInterestChange15mPct: number | null;
    fundingRate: number | null;
    fundingRateAnnualized: number | null;
    aggTradeBuyVolumeRatio: number | null;
    bidAskSpreadPct: number | null;
    bookDepth10bpsUsdt: MoneyValue | null;
    bookDepth50bpsUsdt: MoneyValue | null;
}
