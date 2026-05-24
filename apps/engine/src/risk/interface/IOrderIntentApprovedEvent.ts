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
    // Nullable for de-risking approvals (CLOSE/REDUCE/FLATTEN). The gate's
    // `approveDeRisking` (ADR 0004 §2) returns a null reservation because no
    // exposure is being acquired — the close releases existing exposure. The
    // executor's reservation helpers (`releaseReservationSafely` /
    // `confirmReservationSafely`) already handle the null path. M6 W3
    // (LocalProtectiveMonitor breach-close producer) emits this event for the
    // CLOSE path; the field stays non-null on every opening approval. (ADR 0011 §4)
    readonly reservationId: string | null;
    readonly strategyVersionId: number;
}
