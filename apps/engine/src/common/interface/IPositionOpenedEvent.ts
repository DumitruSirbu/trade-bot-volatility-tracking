import { PositionSideEnum } from '@bot/shared';

import { DecimalValue, MoneyValue } from '../utils/money';

// Payload for POSITION_OPENED_EVENT (M32 §4.3). Emitted by ExecutionService once a fresh
// position row has transitioned to OPEN (post protective-layer settle). Consumers
// (M6 instrumentor, M9 alerting, WS gateway, risk-state recompute) subscribe to this typed
// shape rather than reaching back into the position row. `leverage` is a DecimalValue
// multiplier (NOT money) per PositionEntity.leverage — render it as `{leverage}x`, never $.
export interface IPositionOpenedEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly leverage: DecimalValue;
    readonly entryPrice: MoneyValue;
    readonly entryNotional: MoneyValue;
    readonly strategyVersionId: number;
}
