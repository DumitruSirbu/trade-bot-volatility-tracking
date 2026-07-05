import { PositionSideEnum } from '../enum/PositionSideEnum.js';
import { PositionStateEnum } from '../enum/PositionStateEnum.js';
import { ProtectiveOrderTypeEnum } from '../enum/ProtectiveOrderTypeEnum.js';

export interface IPositionDetailView {
    id: string;
    symbol: string;
    side: PositionSideEnum;
    entryPrice: string;
    currentPrice: string;
    qty: string;
    leverage: string;
    unrealizedPnlPriceUsd: string;
    unrealizedPnlFundingUsd: string | null;
    openedAt: string;
    slot: number;
    strategyVersionId: string;
    /** strategy_versions.name (e.g. "xmom", "volatility-vwap") */
    strategyVersionName: string;
    /** Real event_id from the opening decision, or null when no joining decision exists. */
    eventId: string | null;
    state: PositionStateEnum;
    protectiveOrderType: ProtectiveOrderTypeEnum;
    slPrice: string | null;
    tpPrice: string | null;
    clientOrderId: string;
    reservationId: string | null;
    recoveryPhase: number | null;
}
