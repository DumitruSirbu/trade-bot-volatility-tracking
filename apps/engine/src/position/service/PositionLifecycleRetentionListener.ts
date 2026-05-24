import { ExitReasonEnum, IPositionStateTransitionedEvent, PositionStateEnum, RetainReasonEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { Money } from '../../common/utils/money';
import { SubscriptionRetainer } from '../../market-data/service/SubscriptionRetainer';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../const';

// Wires PositionService transitions to the SubscriptionRetainer per the
// producer table in ADR 0011 §5. The listener is intentionally separate
// from PositionService — it consumes the same domain event the rest of
// the engine reads, keeping the retainer wiring a thin observer rather
// than a hidden side-effect inside the state writer.
//
// M6 R1.3.4: the IPositionStateTransitionedEvent payload now carries
// symbol + exitReason + realizedPnl (decimal-as-string), so the listener
// no longer re-reads the row via PositionRepository. The producer side
// (PositionService.transition) reads off the just-saved entity, so the
// payload reflects the same atomic row state the DB committed (ADR 0009
// §6.1 dual-write atomicity preserved end-to-end).
//
// Cooldown wiring (ADR 0011 §5 row 7-8): there is no standalone
// "cooldown ledger" in M4 — cooldown is derived on-the-fly in
// `RiskGateService.isCooldownActive`. To honor the §5 retainer table
// without inventing a parallel ledger, we retain COOLDOWN_ACTIVE on
// the CLOSED-with-loss transition (the only legitimate cooldown
// trigger). Release-on-expiry is handled by
// `ReconciliationService.releaseExpiredCooldownRetentions` on the 30s
// tick (ADR 0010 §7).
@Injectable()
export class PositionLifecycleRetentionListener {
    private readonly logger = new Logger(PositionLifecycleRetentionListener.name);

    constructor(private readonly retainer: SubscriptionRetainer) {}

    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    onStateTransitioned(event: IPositionStateTransitionedEvent): void {
        const symbol = event.symbol;

        // OPEN_POSITION reason — retained whenever the row is in any live
        // entry state (pending_open or open), released when the row reaches
        // closed. Per ADR 0011 §5 the same OPEN_POSITION retention covers
        // both the pending-open window (where local monitor is the only
        // protection, ADR 0008 §2) and the open window.
        if (event.toState === PositionStateEnum.PENDING_OPEN || event.toState === PositionStateEnum.OPEN) {
            this.retainer.retain(symbol, RetainReasonEnum.OPEN_POSITION);
        }

        if (event.toState === PositionStateEnum.CLOSED) {
            this.retainer.release(symbol, RetainReasonEnum.OPEN_POSITION);
            this.retainer.release(symbol, RetainReasonEnum.PENDING_RECONCILE);
            this.retainer.release(symbol, RetainReasonEnum.FOREIGN_ADOPTED);
            this.retainCooldownIfLoss(event.exitReason, event.realizedPnl, symbol);
        }

        // PENDING_RECONCILE — retained while the row is under reconciliation
        // (ADR 0011 §5 row 5/6). The ReconciliationService (W4) releases on
        // resolved; here we just produce the retain on entry to RECONCILING.
        if (event.toState === PositionStateEnum.RECONCILING) {
            this.retainer.retain(symbol, RetainReasonEnum.PENDING_RECONCILE);
        }

        if (event.fromState === PositionStateEnum.RECONCILING && event.toState !== PositionStateEnum.CLOSED) {
            this.retainer.release(symbol, RetainReasonEnum.PENDING_RECONCILE);
        }

        // FOREIGN_ADOPTED — retained while the bot holds an adopted-foreign
        // position (ADR 0011 §5 row 7). The release fires on transition OUT
        // (operator ack to OPEN, or operator-issued flatten path).
        if (event.toState === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED) {
            this.retainer.retain(symbol, RetainReasonEnum.FOREIGN_ADOPTED);
        }

        if (event.fromState === PositionStateEnum.MANUAL_ADOPTED_UNMANAGED && event.toState !== PositionStateEnum.CLOSED) {
            this.retainer.release(symbol, RetainReasonEnum.FOREIGN_ADOPTED);
        }
    }

    // M6 W4b (ADR 0011 §5 revised). Narrowed from "any negative PnL CLOSED" to the
    // loss-class exit-reason set:
    //   - STOP_LOSS, LIQUIDATED: always arm cooldown (a loss by definition).
    //   - TIME_STOP, SIGNAL: arm only if realized PnL is negative.
    //   - KILL_SWITCH, MANUAL, TAKE_PROFIT, RECONCILED_MISSING: never arm cooldown
    //     (kill-switch is operator intervention, manual is operator-driven, TP is a
    //     win by definition, reconciled-missing has null PnL — bot didn't see fills).
    // Release-on-expiry is handled by `ReconciliationService.releaseExpiredCooldownRetentions`
    // on the 30s tick (ADR 0010 §7, ADR 0011 §5).
    //
    // M6 R1.3.4: the realizedPnl arrives as a decimal-as-string from the event
    // payload (shared serialization rule for money on the wire). Parsed locally
    // to Decimal so the negative test stays float-free.
    private retainCooldownIfLoss(exitReason: ExitReasonEnum | null, realizedPnl: string | null, symbol: string): void {
        if (exitReason === null) {
            return;
        }

        if (exitReason === ExitReasonEnum.STOP_LOSS || exitReason === ExitReasonEnum.LIQUIDATED) {
            this.retainer.retain(symbol, RetainReasonEnum.COOLDOWN_ACTIVE);

            return;
        }

        if (exitReason === ExitReasonEnum.TIME_STOP || exitReason === ExitReasonEnum.SIGNAL) {
            if (this.isNegativeMoneyString(realizedPnl)) {
                this.retainer.retain(symbol, RetainReasonEnum.COOLDOWN_ACTIVE);
            }
        }
    }

    private isNegativeMoneyString(raw: string | null): boolean {
        if (raw === null) {
            return false;
        }

        try {
            return new Money(raw).isNegative();
        } catch {
            this.logger.warn(`unparsable realizedPnl='${raw}' on transition — treating as non-loss`);

            return false;
        }
    }
}
