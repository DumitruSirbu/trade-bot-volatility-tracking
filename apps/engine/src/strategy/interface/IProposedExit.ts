import { StopTypeEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';

// PROPOSED protective targets only (ADR 0003 §3). Enforcement is M4 (risk validates the
// stop sits inside liquidation distance) and M6 (position layer places the orders). A
// strategy never watches price or fires these closes itself.
export interface IProposedExit {
    readonly takeProfitPrice: MoneyValue;
    readonly stopLossPrice: MoneyValue;
    readonly stopType: StopTypeEnum;
    readonly timeStopAtMs: number; // = nowMs + params.time_stop_minutes * 60_000 (deterministic)
}
