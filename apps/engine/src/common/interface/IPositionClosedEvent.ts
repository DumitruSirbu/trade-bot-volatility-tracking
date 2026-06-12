import { ExitReasonEnum, PositionSideEnum } from '@bot/shared';

import { DecimalValue, MoneyValue } from '../utils/money';

// Payload for POSITION_CLOSED_EVENT (round-5 #4). Emitted by ExecutionService when a
// reduce-family fill fully closes a position. Consumers (M6 reconciliation, M9 alerting)
// subscribe to this typed shape rather than reaching back into the position row.
//
// M32 §4.3 widened this payload with the fields the alert listener needs to render the
// enriched close message without reaching back into the DB (entry/exit price, leverage,
// strategy version, openedAt for hold duration). `leverage` is a DecimalValue multiplier
// (NOT money) per PositionEntity.leverage — render it as `{leverage}x`, never $.
export interface IPositionClosedEvent {
    readonly positionId: number;
    readonly symbol: string;
    readonly side: PositionSideEnum;
    readonly exitReason: ExitReasonEnum | null | undefined;
    readonly realizedPnl: MoneyValue | null | undefined;
    readonly closedAt: Date | null | undefined;
    readonly entryPrice: MoneyValue;
    readonly exitPrice: MoneyValue | null | undefined;
    readonly leverage: DecimalValue;
    readonly strategyVersionId: number;
    readonly openedAt: Date;
}
