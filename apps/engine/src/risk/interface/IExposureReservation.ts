import { CorrelationModeEnum, PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { MoneyValue } from '../../common/utils/money';
import { ReservationStateEnum } from '../enum';

// An in-flight exposure reservation (ADR 0004 §3). Lives only in RiskGateService in-memory
// state (a Map<reservationId, IExposureReservation>) — NOT a DB table. Transient by
// definition: it exists only between approval and fill/fail. PENDING + CONFIRMED both count
// toward exposure caps and the slot count; RELEASED/EXPIRED do not.
export interface IExposureReservation {
    readonly reservationId: string; // gate-minted opaque id (deterministic seed `${eventId}:${slot}`, §7)
    readonly symbol: string;
    readonly slot: PositionSlotEnum;
    readonly tradeSide: PositionSideEnum;
    readonly notional: MoneyValue; // reserved against per-coin + portfolio caps
    readonly correlationMode: CorrelationModeEnum;
    readonly createdAtMs: number; // injected clock (§7)
    readonly expiresAtMs: number; // createdAtMs + RESERVATION_TTL_MS
    state: ReservationStateEnum; // pending | confirmed | released | expired
}
