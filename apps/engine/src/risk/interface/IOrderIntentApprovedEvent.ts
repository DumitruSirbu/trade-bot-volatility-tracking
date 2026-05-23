import { PositionSlotEnum } from '@bot/shared';

import { IProposedExit } from '../../strategy/interface';
import { IIntentSizing } from './IIntentSizing';
import { IOrderIntent } from './IOrderIntent';

// The risk-gate approval seam payload (ADR 0004 §1). Emitted by the orchestrator on APPROVAL;
// M5 consumes it to submit the order. Engine-internal (carries MoneyValue); the dashboard
// reads the persisted decisions/positions rows instead.
export interface IOrderIntentApprovedEvent {
    readonly intent: IOrderIntent;
    readonly approvedSlot: PositionSlotEnum;
    readonly approvedSizing: IIntentSizing;
    readonly clampedExit: IProposedExit;
    readonly reservationId: string;
    readonly strategyVersionId: number;
}
