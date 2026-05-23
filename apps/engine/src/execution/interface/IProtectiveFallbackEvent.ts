import { MoneyValue } from '../../common/utils/money';

// Emitted when ExecutionModule could not attach exchange-side SL/TP and the position is
// now relying on LOCAL_FALLBACK (ADR 0008 §3). M6's local protective monitor subscribes to
// this in the next milestone; M5 ships the emit + log only (the monitor itself is M6 scope).
export interface IProtectiveFallbackEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly stopLossPrice: MoneyValue;
    readonly takeProfitPrice: MoneyValue;
    readonly errorMessage: string | null;
}
