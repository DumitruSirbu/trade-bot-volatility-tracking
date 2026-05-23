import { Injectable, Logger } from '@nestjs/common';

import { ReservationStateEnum } from '../enum';
import { IExposureReservation, IReservationLedgerPort } from '../interface';

// The in-flight exposure reservation ledger (ADR 0004 §3). In-memory service state — NOT a
// DB table: reservations are transient (seconds) and the durable exposure source is
// risk_state + open positions. The same implementation runs live and in backtest (it is
// already pure in-memory state). M6 drives the TTL sweep + unknown-outcome resolution.
@Injectable()
export class ReservationLedger implements IReservationLedgerPort {
    private readonly logger = new Logger(ReservationLedger.name);

    private readonly reservations = new Map<string, IExposureReservation>();

    listActive(): IExposureReservation[] {
        return [...this.reservations.values()].filter((reservation) => this.countsTowardCaps(reservation.state));
    }

    reserve(reservation: IExposureReservation): void {
        this.reservations.set(reservation.reservationId, reservation);

        this.logger.debug(`reserved ${reservation.reservationId} slot=${reservation.slot} notional=${reservation.notional.toFixed()}`);
    }

    releaseReservation(reservationId: string): void {
        this.transition(reservationId, ReservationStateEnum.RELEASED);
    }

    confirmReservation(reservationId: string): void {
        this.transition(reservationId, ReservationStateEnum.CONFIRMED);
    }

    // TTL sweep (M6 seam). nowMs is injected (§7), never the wall clock. PENDING reservations
    // past expiry become EXPIRED so M6 reconciles them against the exchange.
    expireStaleReservations(nowMs: number): void {
        for (const reservation of this.reservations.values()) {
            if (reservation.state === ReservationStateEnum.PENDING && nowMs >= reservation.expiresAtMs) {
                reservation.state = ReservationStateEnum.EXPIRED;

                this.logger.warn(`reservation ${reservation.reservationId} expired (no fill confirmation) — M6 reconciles`);
            }
        }
    }

    private transition(reservationId: string, next: ReservationStateEnum): void {
        const reservation = this.reservations.get(reservationId);

        if (reservation === undefined) {
            this.logger.warn(`reservation ${reservationId} not found for transition to ${next}`);

            return;
        }

        if (!this.isLegalTransition(reservation.state, next)) {
            this.logger.warn(`illegal reservation transition ${reservation.state} -> ${next} for ${reservationId} (ignored)`);

            return;
        }

        reservation.state = next;
    }

    // The locked lifecycle (ADR 0004 §3): PENDING -> CONFIRMED|RELEASED|EXPIRED;
    // CONFIRMED -> RELEASED (close); terminal states do not transition further. Notably a
    // RELEASED/EXPIRED reservation can NEVER become CONFIRMED again.
    private isLegalTransition(from: ReservationStateEnum, to: ReservationStateEnum): boolean {
        const allowed: Record<ReservationStateEnum, ReservationStateEnum[]> = {
            [ReservationStateEnum.PENDING]: [ReservationStateEnum.CONFIRMED, ReservationStateEnum.RELEASED, ReservationStateEnum.EXPIRED],
            [ReservationStateEnum.CONFIRMED]: [ReservationStateEnum.RELEASED],
            [ReservationStateEnum.RELEASED]: [],
            [ReservationStateEnum.EXPIRED]: [],
        };

        return allowed[from].includes(to);
    }

    private countsTowardCaps(state: ReservationStateEnum): boolean {
        return state === ReservationStateEnum.PENDING || state === ReservationStateEnum.CONFIRMED;
    }
}
