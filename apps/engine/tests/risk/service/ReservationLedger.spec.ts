/**
 * ReservationLedger — in-memory exposure reservation lifecycle.
 *
 * Coverage: reserve → listActive counts it; confirm keeps it active; release
 * removes it from caps; TTL expiry transitions PENDING → EXPIRED; RELEASED and
 * EXPIRED do not count; no reservation leak.
 */

import { PositionSlotEnum } from '@bot/shared';

import { ReservationLedger } from '../../../src/risk/service/ReservationLedger';
import { ReservationStateEnum } from '../../../src/risk/enum';
import { buildReservation } from '../support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeLedger(): ReservationLedger {
    return new ReservationLedger();
}

const T0 = 1_716_307_200_000;
const TTL = 60_000;

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ReservationLedger', () => {
    describe('reserve / listActive', () => {
        it('starts with an empty active list', () => {
            expect(makeLedger().listActive()).toHaveLength(0);
        });

        it('adds a PENDING reservation to the active list', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1', state: ReservationStateEnum.PENDING }));

            expect(ledger.listActive()).toHaveLength(1);
        });

        it('adds multiple reservations independently', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.reserve(buildReservation({ reservationId: 'r2', slot: PositionSlotEnum.B }));

            expect(ledger.listActive()).toHaveLength(2);
        });

        it('counts PENDING reservations toward caps', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1', state: ReservationStateEnum.PENDING }));

            const active = ledger.listActive();
            expect(active[0].state).toBe(ReservationStateEnum.PENDING);
        });
    });

    describe('confirmReservation', () => {
        it('transitions PENDING → CONFIRMED', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1', state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('r1');

            const active = ledger.listActive();
            expect(active).toHaveLength(1);
            expect(active[0].state).toBe(ReservationStateEnum.CONFIRMED);
        });

        it('still counts a CONFIRMED reservation toward caps (it remains active)', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.confirmReservation('r1');

            expect(ledger.listActive()).toHaveLength(1);
        });
    });

    describe('releaseReservation', () => {
        it('transitions PENDING → RELEASED and removes from active list', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.releaseReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('transitions CONFIRMED → RELEASED and removes from active list', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.confirmReservation('r1');
            ledger.releaseReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('does not throw when releasing an unknown reservationId (idempotent)', () => {
            const ledger = makeLedger();
            expect(() => ledger.releaseReservation('unknown')).not.toThrow();
        });

        it('releases only the targeted reservation; others remain active', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.reserve(buildReservation({ reservationId: 'r2', slot: PositionSlotEnum.B }));
            ledger.releaseReservation('r1');

            const active = ledger.listActive();
            expect(active).toHaveLength(1);
            expect(active[0].reservationId).toBe('r2');
        });
    });

    describe('expireStaleReservations (TTL sweep)', () => {
        it('expires PENDING reservations past their expiresAtMs', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );

            // At exactly expiresAtMs it should expire
            ledger.expireStaleReservations(T0 + TTL);

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('does NOT expire PENDING reservations before their expiresAtMs', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );

            // One millisecond before expiry
            ledger.expireStaleReservations(T0 + TTL - 1);

            expect(ledger.listActive()).toHaveLength(1);
        });

        it('does NOT expire CONFIRMED reservations (only PENDING can expire via TTL)', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );
            ledger.confirmReservation('r1');

            ledger.expireStaleReservations(T0 + TTL + 1_000);

            // CONFIRMED reservation stays active — only PENDING can TTL-expire
            expect(ledger.listActive()).toHaveLength(1);
        });

        it('expires only the stale reservation when multiple exist with different TTLs', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );
            ledger.reserve(
                buildReservation({
                    reservationId: 'r2',
                    slot: PositionSlotEnum.B,
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0 + TTL, // created later
                    expiresAtMs: T0 + TTL + TTL, // expires at 2× TTL
                }),
            );

            ledger.expireStaleReservations(T0 + TTL);

            const active = ledger.listActive();
            expect(active).toHaveLength(1);
            expect(active[0].reservationId).toBe('r2');
        });
    });

    describe('no reservation leak — approve → fail → release', () => {
        it('caps are zero after reserve → release cycle', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.releaseReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('caps are zero after reserve → confirm → release cycle', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.confirmReservation('r1');
            ledger.releaseReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('caps are zero after reserve → expire cycle', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );
            ledger.expireStaleReservations(T0 + TTL + 1);

            expect(ledger.listActive()).toHaveLength(0);
        });
    });

    describe('RELEASED and EXPIRED states do not count toward caps', () => {
        it('RELEASED reservation is excluded from listActive', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.releaseReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('EXPIRED reservation is excluded from listActive', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );
            ledger.expireStaleReservations(T0 + TTL);

            expect(ledger.listActive()).toHaveLength(0);
        });
    });

    describe('illegal state transitions are silently ignored (locked lifecycle)', () => {
        it('RELEASED → CONFIRMED is ignored: reservation stays RELEASED (not re-activated)', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.releaseReservation('r1');

            // Attempt illegal RELEASED → CONFIRMED
            ledger.confirmReservation('r1');

            // Must NOT appear in active caps — it remains RELEASED
            expect(ledger.listActive()).toHaveLength(0);
        });

        it('EXPIRED → CONFIRMED is ignored: reservation stays EXPIRED (not re-activated)', () => {
            const ledger = makeLedger();
            ledger.reserve(
                buildReservation({
                    reservationId: 'r1',
                    state: ReservationStateEnum.PENDING,
                    createdAtMs: T0,
                    expiresAtMs: T0 + TTL,
                }),
            );
            ledger.expireStaleReservations(T0 + TTL);

            // Attempt illegal EXPIRED → CONFIRMED
            ledger.confirmReservation('r1');

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('RELEASED → RELEASED is a no-op (does not throw, remains terminal)', () => {
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1' }));
            ledger.releaseReservation('r1');

            // Attempt to release again
            expect(() => ledger.releaseReservation('r1')).not.toThrow();
            expect(ledger.listActive()).toHaveLength(0);
        });
    });
});
