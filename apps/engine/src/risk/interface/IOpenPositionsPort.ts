import { CorrelationModeEnum, PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// A normalised view of one open position the gate reasons over (ADR 0004 §4/§7): slot,
// side, notional, correlation mode, symbol, and close timing for cooldown/consecutive-loss
// derivation. Engine-internal; carries MoneyValue.
export interface IOpenPositionView {
    readonly symbol: string;
    readonly slot: PositionSlotEnum | null;
    readonly side: PositionSideEnum;
    readonly notional: MoneyValue;
    readonly correlationMode: CorrelationModeEnum;
}

// A closed position the gate reads for cooldown + consecutive-loss derivation (ADR 0004 §5).
export interface IClosedPositionView {
    readonly symbol: string;
    readonly realizedPnl: MoneyValue;
    readonly closedAtMs: number;
}

// State port for open exposure / slot occupancy and recent closes (ADR 0004 §7). Live impl
// reads PositionRepository; backtest uses the simulated book. The pure decision core
// receives the loaded arrays — it never queries.
export interface IOpenPositionsPort {
    findOpen(): Promise<IOpenPositionView[]>;
    findClosedOnUtcDay(dateString: string): Promise<IClosedPositionView[]>;
    findLastCloseForSymbol(symbol: string): Promise<IClosedPositionView | null>;
    countOpenedOnUtcDayForSymbol(symbol: string, dateString: string): Promise<number>;
}
