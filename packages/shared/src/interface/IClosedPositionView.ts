import { PositionSideEnum } from '../enum/PositionSideEnum.js';
import { ExitReasonEnum } from '../enum/ExitReasonEnum.js';

export interface IClosedPositionView {
    id: string;
    symbol: string;
    side: PositionSideEnum;
    entryPrice: string;
    exitPrice: string | null;
    qty: string;
    leverage: string;
    realizedPnlUsd: string | null;
    openedAt: string;
    closedAt: string;
    exitReason: ExitReasonEnum;
    strategyVersionId: string;
    /** strategy_versions.name (e.g. "xmom", "volatility-vwap") */
    strategyVersionName: string;
}
