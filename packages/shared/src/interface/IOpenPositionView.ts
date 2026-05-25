import { PositionSideEnum } from '../enum/PositionSideEnum.js';
import { PositionStateEnum } from '../enum/PositionStateEnum.js';
import { ProtectiveOrderTypeEnum } from '../enum/ProtectiveOrderTypeEnum.js';

export interface IOpenPositionView {
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
    eventId: string;
    state: PositionStateEnum;
    protectiveOrderType: ProtectiveOrderTypeEnum;
    slPrice: string | null;
    tpPrice: string | null;
}
