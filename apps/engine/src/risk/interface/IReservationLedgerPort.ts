import { PositionSlotEnum } from '@bot/shared';

import { IExposureReservation } from './IExposureReservation';

// The in-flight exposure reservation ledger (ADR 0004 §3). Same in-memory implementation
// live and in backtest — it is already pure in-memory state. The gate reserves on approval
// and releases on reject/fill-fail; M6 drives the TTL sweep and unknown-outcome resolution.
export interface IReservationLedgerPort {
    // The reservations that count toward exposure caps + slot occupancy (PENDING + CONFIRMED).
    listActive(): IExposureReservation[];

    reserve(reservation: IExposureReservation): void;

    // M6 seam: free a reservation whose fill never happened (reject / fill-fail).
    releaseReservation(reservationId: string): void;

    // M34 seam: release ALL CONFIRMED reservations on a closed position's (symbol, slot) — the
    // OPEN plus every ADD share one slot. Returns the count released. CONFIRMED-only so a racing
    // incoming OPEN's fresh PENDING on the same slot is never freed.
    releaseConfirmedReservationsFor(symbol: string, slot: PositionSlotEnum): number;

    // M6 seam: mark a reservation CONFIRMED once execution accepts the order.
    confirmReservation(reservationId: string): void;

    // M6 seam: TTL sweep — mark reservations whose expiresAtMs has passed as EXPIRED so M6
    // reconciles them against the exchange. nowMs is injected (§7), never the wall clock.
    expireStaleReservations(nowMs: number): void;
}
