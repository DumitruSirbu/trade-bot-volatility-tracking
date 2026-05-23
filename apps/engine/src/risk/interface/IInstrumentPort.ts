import { DecimalValue, MoneyValue } from '../../common/utils/money';

// The instrument constraints sizing needs (ADR 0004 §8): step size, min notional, tick, plus
// the maintenance-margin rate the SL-inside-liquidation check needs to locate the real
// liquidation price. Engine-internal; carries decimal values. Live impl reads the instruments
// table; backtest replays the instruments snapshot.
export interface IInstrumentConstraints {
    readonly symbol: string;
    readonly stepSize: DecimalValue;
    readonly tickSize: DecimalValue;
    readonly minNotional: MoneyValue;
    readonly maintenanceMarginRate: DecimalValue; // fraction of notional; defaulted when no Binance tier metadata exists
}

export interface IInstrumentPort {
    findConstraints(symbol: string): Promise<IInstrumentConstraints | null>;
}
