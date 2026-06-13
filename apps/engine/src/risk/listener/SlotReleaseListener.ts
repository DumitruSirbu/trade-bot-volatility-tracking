import { PositionSlotEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { POSITION_CLOSED_EVENT } from '../../common/const';
import { IPositionClosedEvent } from '../../common/interface';
import { RiskGateService } from '../service/RiskGateService';

// M34 (ADR 0004 §3) — the normal close-path slot-reservation release.
//
// The reservation ledger is the authoritative source for slot occupancy. On OPEN/ADD the gate
// mints a CONFIRMED reservation that occupies the slot exactly as a live position does. Before
// M34 only the reconciliation path (reconcileClose) released it; a position closed via the
// normal executor path (time-stop, local SL/TP, FLATTEN) leaked its reservation and the slot
// stayed occupied until restart — the production false-reject this milestone fixes.
//
// This is a DEDICATED listener, deliberately NOT co-located in RiskStateLifecycleListener: that
// listener has a documented invariant of reading NO event fields (it recomputes the full UTC-day
// rollup from authoritative DB rows). The slot release MUST read `event.positionSlot`, so merging
// the two would break that SRP boundary.
//
// Only the executor reduce/close fills emit POSITION_CLOSED_EVENT — the reconcile / zombie /
// exchange-SL-TP paths self-release inside reconcileClose and emit no such event, so the two
// release paths are largely disjoint (the narrow same-position race is a terminal RELEASED →
// RELEASED no-op in the ledger).
@Injectable()
export class SlotReleaseListener {
    private readonly logger = new Logger(SlotReleaseListener.name);

    constructor(private readonly riskGate: RiskGateService) {}

    @OnEvent(POSITION_CLOSED_EVENT)
    onPositionClosed(event: IPositionClosedEvent): void {
        if (event.positionSlot === null) {
            // Null-slot backstop for legacy/adopted rows that carry no slot. The (symbol, slot)
            // matcher cannot resolve, so reconciliation remains the release path; the
            // slot-accounting invariant check will surface any residual divergence in soak.
            this.logger.warn(`position ${event.positionId} ${event.symbol} closed with null slot - skipping slot release (reconciliation backstop)`);

            return;
        }

        // Defense-in-depth: reject an out-of-enum slot value before it reaches the ledger matcher,
        // so a malformed event can never drive a release against a bogus (symbol, slot).
        if (!Object.values(PositionSlotEnum).includes(event.positionSlot)) {
            this.logger.warn(`position ${event.positionId} ${event.symbol} closed with unknown positionSlot=${event.positionSlot} - skipping slot release`);

            return;
        }

        this.riskGate.releaseSlotForClosedPosition(event.symbol, event.positionSlot);
    }
}
