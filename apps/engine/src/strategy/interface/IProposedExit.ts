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
    // M38 D1 (ADR 0045): the arm-seam discriminator. momentum=true (TP is reference+ATR,
    // rebase-eligible), meanReversion=false (TP is VWAP-anchored; applying fill ± ATR would
    // corrupt it). Required boolean so every producer declares intent — no silent default.
    readonly tpRebaseEligible: boolean;
    // M38 D1 (ADR 0045): the post-clamp atr14 × MULTIPLIER distance, computed ONCE in the
    // strategy layer and consumed verbatim at the arm/backtest seams (never re-derived — a
    // re-multiply can diverge at the last decimal and fail the live/backtest parity test).
    // null on the mean-reversion path and any producer that is not rebase-eligible.
    readonly atrDistance: MoneyValue | null;
}
