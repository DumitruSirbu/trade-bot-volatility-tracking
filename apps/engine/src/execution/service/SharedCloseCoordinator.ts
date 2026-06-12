import { Injectable, Logger } from '@nestjs/common';

// M33 Fix 1b (ADR 0011 §9) — the single in-memory dedup substrate for ALL gate-routed
// close producers (the local SL/TP monitor, the live time-stop enforcer, and the
// reconciliation foreign-position flatten). Every producer MUST `tryAcquire` the
// position's slot before emitting a CLOSE intent and release it per the locked release
// table in the M33 plan (Fix 1b). The slot is the single "a CLOSE intent is already in
// flight for this positionId" fact so a same-tick collision between any two producers
// emits exactly one close — the executor's deterministic-eventId guard does NOT catch two
// closes with different eventIds, which is the double-close BLOCKER this registry resolves.
//
// In-memory only; no DB, no events. Reset on restart is acceptable — the durable layer is
// the DB position state plus the executor's clientOrderId idempotency on the close
// transaction. Boot reconciliation (ADR 0014) handles a close in flight across a restart.
@Injectable()
export class SharedCloseCoordinator {
    private readonly logger = new Logger(SharedCloseCoordinator.name);

    private readonly inFlight = new Set<number>();

    // Atomic check-and-set. Returns false if a close is already in flight for this
    // positionId (the caller must skip emitting), true if the slot was newly acquired.
    tryAcquire(positionId: number): boolean {
        if (this.inFlight.has(positionId)) {
            return false;
        }

        this.inFlight.add(positionId);
        this.logger.log(`close slot acquired positionId=${positionId}`);

        return true;
    }

    // Frees the slot so a future close can be emitted. Released per the Fix 1b outcome
    // table — never on generic disarm(), never on ORDER_INTENT_UNKNOWN (reconciliation
    // owns the row); each producer releases only its own slot.
    release(positionId: number): void {
        if (!this.inFlight.delete(positionId)) {
            return;
        }

        this.logger.log(`close slot released positionId=${positionId}`);
    }

    // Non-destructive check — does NOT acquire.
    isHeld(positionId: number): boolean {
        return this.inFlight.has(positionId);
    }
}
