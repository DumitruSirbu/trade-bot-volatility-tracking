import { PositionSideEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// A frozen, readonly snapshot of the symbol's open position, mapped by the orchestrator
// from PositionEntity (ADR 0003 §1). It carries ONLY what a strategy may legitimately
// read; the strategy never touches TypeORM. The backtest builds the same struct from its
// simulated book.
export interface IOpenPositionState {
    readonly side: PositionSideEnum;
    readonly entryPrice: MoneyValue;
    readonly qty: MoneyValue;
    readonly entryNotional: MoneyValue;
    readonly strategyVersionId: number;
    readonly positionSlot: string | null;
    readonly openedAtMs: number;
    readonly timeStopAtMs: number | null;
}
