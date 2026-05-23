import { ExitReasonEnum, PositionSideEnum } from '@bot/shared';

import { MoneyValue } from '../utils/money';

// Payload for POSITION_CLOSED_EVENT (round-5 #4). Emitted by ExecutionService when a
// reduce-family fill fully closes a position. Consumers (M6 reconciliation, M9 alerting)
// subscribe to this typed shape rather than reaching back into the position row.
export interface IPositionClosedEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly exitReason: ExitReasonEnum | null | undefined;
    readonly realizedPnl: MoneyValue | null | undefined;
    readonly closedAt: Date | null | undefined;
}
