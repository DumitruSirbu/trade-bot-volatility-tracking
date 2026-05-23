import { PositionSlotEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { IProposedExit } from '../../strategy/interface';
import { IIntentSizing } from './IIntentSizing';

// The gate's output (ADR 0004 §1). Command-Query Separation: the gate RETURNS this value
// and performs the reservation as a controlled side effect on its own ledger (§3) only on
// approval. It writes no DB rows and emits no events — the orchestrator persists and emits.
export interface IRiskDecision {
    readonly outcome: RiskOutcomeEnum; // approved | rejected
    readonly rejectReason: RejectReasonEnum | null; // non-null IFF rejected
    readonly approvedSlot: PositionSlotEnum | null; // A|B|C, non-null IFF approved & opening
    readonly approvedSizing: IIntentSizing | null; // post-clamp sizing (funding 50% cut etc.)
    readonly clampedExit: IProposedExit | null; // SL possibly tightened to sit inside liquidation
    readonly reservationId: string | null; // ledger handle (§3), non-null IFF approved
}

// The same decision narrowed to its approved shape: the four nullable fields are guaranteed
// non-null when outcome === APPROVED & opening. The orchestrator narrows once via the type
// guard below instead of scattering `as`/`!` at the emit site.
export interface IApprovedRiskDecision extends IRiskDecision {
    readonly outcome: RiskOutcomeEnum.APPROVED;
    readonly approvedSlot: PositionSlotEnum;
    readonly approvedSizing: IIntentSizing;
    readonly clampedExit: IProposedExit;
    readonly reservationId: string;
}

// True only when the decision is an APPROVED opening with every approval field populated.
// De-risking approvals (no slot/reservation) return false — the orchestrator emits an
// order intent only for opening approvals.
export function isApprovedOpening(decision: IRiskDecision): decision is IApprovedRiskDecision {
    return (
        decision.outcome === RiskOutcomeEnum.APPROVED &&
        decision.approvedSlot !== null &&
        decision.approvedSizing !== null &&
        decision.clampedExit !== null &&
        decision.reservationId !== null
    );
}
