import { PositionStateEnum } from '@bot/shared';

// Legal-transition graph for the position state machine (ADR 0009 §3). The
// transition API consults this lookup; anything not listed throws
// IllegalStateTransitionException.
//
// Edges (ADR 0009 §3):
//   pending_open -> open, reconciling
//   open         -> closing, reconciling
//   closing      -> open (intent rejected post-emission, no fill landed),
//                   closed,
//                   reconciling
//   reconciling  -> open, closed, manual_adopted_unmanaged
//   manual_adopted_unmanaged -> open (operator ack), closing (operator flatten)
//   closed       -> (terminal; no outgoing edges)
//
// Encoded as a Map<from, Set<to>> for O(1) lookup and so adding a new state
// can't silently bypass legality checks — every new enum value MUST get an
// entry here or transitions originating from it throw.

const LEGAL_TRANSITIONS: ReadonlyMap<PositionStateEnum, ReadonlySet<PositionStateEnum>> = new Map([
    // pending_open -> closing is DELIBERATELY absent (ADR 0009 §3 / §6.3). A reduce-family
    // close on a pending_open row promotes through `open` first (two-step, via
    // ExecutionService.promotePendingOpenBeforeClose) so the close never fires on an
    // unprotected, un-finalized row. Do NOT add a direct pending_open -> closing edge.
    [PositionStateEnum.PENDING_OPEN, new Set<PositionStateEnum>([PositionStateEnum.OPEN, PositionStateEnum.RECONCILING])],
    [PositionStateEnum.OPEN, new Set<PositionStateEnum>([PositionStateEnum.CLOSING, PositionStateEnum.RECONCILING])],
    [PositionStateEnum.CLOSING, new Set<PositionStateEnum>([PositionStateEnum.OPEN, PositionStateEnum.CLOSED, PositionStateEnum.RECONCILING])],
    [PositionStateEnum.RECONCILING, new Set<PositionStateEnum>([PositionStateEnum.OPEN, PositionStateEnum.CLOSED, PositionStateEnum.MANUAL_ADOPTED_UNMANAGED])],
    [PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, new Set<PositionStateEnum>([PositionStateEnum.OPEN, PositionStateEnum.CLOSING])],
    [PositionStateEnum.CLOSED, new Set<PositionStateEnum>()],
]);

export function isLegalTransition(from: PositionStateEnum, to: PositionStateEnum): boolean {
    const outgoing = LEGAL_TRANSITIONS.get(from);

    if (!outgoing) {
        return false;
    }

    return outgoing.has(to);
}
