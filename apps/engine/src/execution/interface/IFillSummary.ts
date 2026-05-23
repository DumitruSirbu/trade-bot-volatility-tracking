import { MoneyValue } from '../../common/utils/money';

// Terminal-fill summary produced by FillAccumulator (ADR 0007 §1/§2). The single source of
// truth for downstream qty/price/exposure math: position notional, SL/TP recomputation, and
// risk-reservation confirm all derive from this struct — never from intent.sizing or the
// limit/ref price. One summary per `clientOrderId` at terminal state.
export interface IFillSummary {
    readonly filledQty: MoneyValue;
    readonly filledNotional: MoneyValue;
    readonly avgFillPrice: MoneyValue;
    readonly feeTotal: MoneyValue;
    readonly feeCurrency: string | null;
}
