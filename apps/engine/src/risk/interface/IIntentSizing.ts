import { DecimalValue, MoneyValue } from '../../common/utils/money';

// Concrete decimal sizing for an order intent (ADR 0004 §1/§8). Engine-internal:
// it carries MoneyValue/DecimalValue and never crosses the shared boundary. Produced by
// PositionSizer, attached to IOrderIntent, and (post-clamp) returned on IRiskDecision.
export interface IIntentSizing {
    readonly qty: MoneyValue; // base-asset quantity, step-rounded DOWN
    readonly notional: MoneyValue; // USDT notional reserved against caps
    readonly leverage: DecimalValue; // <= MAX_LEVERAGE
    readonly riskPerTradeUsdt: MoneyValue; // pre-clamp 1%-risk target (sizing audit; never overwritten)
    readonly effectiveRiskUsdt: MoneyValue; // post-ceiling-clamp, pre-step-rounding realized risk; slight overestimate of final fill risk; == riskPerTradeUsdt when no ceiling binds
}
