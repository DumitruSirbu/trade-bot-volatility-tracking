export interface IPriceUpdateEvent {
    symbol: string;
    price: string;           // decimal-as-string (money)
    timestampMs: number;     // exchange event time, epoch ms (transport metadata, not money)
}
