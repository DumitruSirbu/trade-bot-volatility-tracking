import { PositionSideEnum, TransactionTypeEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';
import { IMyTradeSnapshot } from '../../exchange/interface';
import type { IReconciledOrderGroup } from '../service/PositionService';

// M49 wave-2 (clean-code). Grouped input for `PositionService.insertOrderGroupIfNew`.
// `resolvedType` replaces the prior `isFinalDrainingOrder` boolean flag — the caller
// computes CLOSE (the chronologically last, draining order) vs REDUCE before calling,
// so the method no longer branches on a flag argument.
export interface IInsertOrderGroupInput {
    readonly positionId: number;
    readonly group: IReconciledOrderGroup;
    readonly resolvedType: TransactionTypeEnum;
    readonly side: PositionSideEnum;
    readonly entryPrice: MoneyValue;
}

// M49 wave-2 (clean-code). Grouped input for `PositionService.recordReconciledClosingFills`.
// `side` is the POSITION side (LONG/SHORT) — it drives the cashflow sign via
// `computeFillCashflow`. `fills` are the recovered closing fills from account history.
export interface IRecordReconciledFillsInput {
    readonly positionId: number;
    readonly fills: readonly IMyTradeSnapshot[];
    readonly entryPrice: MoneyValue;
    readonly side: PositionSideEnum;
}
