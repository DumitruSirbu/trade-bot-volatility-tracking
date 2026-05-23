import { ProtectiveOrderTypeEnum } from '@bot/shared';

// Outcome of attaching exchange-side SL/TP after entry-fill confirmation (ADR 0008 §1/§3).
// The protective_order_type column flips to EXCHANGE_SIDE only when both legs ack; any other
// outcome leaves the position on LOCAL_FALLBACK (and emits the fallback event for the future
// M6 local monitor to consume).
export interface IProtectiveAttachResult {
    readonly protectiveOrderType: ProtectiveOrderTypeEnum;
    readonly stopLossClientOrderId: string;
    readonly takeProfitClientOrderId: string;
    readonly errorMessage: string | null; // sanitized when fallback was taken
}
