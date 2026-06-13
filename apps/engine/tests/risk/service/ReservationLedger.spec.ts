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

    describe('releaseConfirmedReservationsFor — M34 multi-release', () => {
        it('incident replay: open 3 slots, confirm all, release all, 4th reservation on any slot is permitted', () => {
            // BUILD — three positions opened and confirmed on slots A, B, C
            const ledger = makeLedger();

            for (const [id, slot] of [
                ['r-open-a', PositionSlotEnum.A],
                ['r-open-b', PositionSlotEnum.B],
                ['r-open-c', PositionSlotEnum.C],
            ] as const) {
                ledger.reserve(buildReservation({ reservationId: id, symbol: 'HYPEUSDT', slot, state: ReservationStateEnum.PENDING }));
                ledger.confirmReservation(id);
            }

            expect(ledger.listActive()).toHaveLength(3);

            // OPERATE — normal-close all three (the bug: before M34 these were never released)
            ledger.releaseConfirmedReservationsFor('HYPEUSDT', PositionSlotEnum.A);
            ledger.releaseConfirmedReservationsFor('HYPEUSDT', PositionSlotEnum.B);
            ledger.releaseConfirmedReservationsFor('HYPEUSDT', PositionSlotEnum.C);

            // CHECK — ledger is now empty; a 4th reservation on any slot succeeds
            expect(ledger.listActive()).toHaveLength(0);

            ledger.reserve(buildReservation({ reservationId: 'r-new', symbol: 'HYPEUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }));
            expect(ledger.listActive()).toHaveLength(1);
        });

        it('ADD multi-release: OPEN + ADD reservations on the same (symbol, slot) are both released on close', () => {
            // BUILD — one position with two reservations: original OPEN and one ADD
            const ledger = makeLedger();

            ledger.reserve(
                buildReservation({ reservationId: 'open-event:A', symbol: 'BTCUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }),
            );
            ledger.confirmReservation('open-event:A');

            ledger.reserve(
                buildReservation({ reservationId: 'add-event:A', symbol: 'BTCUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }),
            );
            ledger.confirmReservation('add-event:A');

            expect(ledger.listActive()).toHaveLength(2);

            // OPERATE — single close-path call releases both
            const released = ledger.releaseConfirmedReservationsFor('BTCUSDT', PositionSlotEnum.A);

            // CHECK — both CONFIRMED reservations freed; slot is fully empty
            expect(released).toBe(2);
            expect(ledger.listActive()).toHaveLength(0);
        });

        it('CONFIRMED-bias: a racing PENDING reservation on the same (symbol, slot) is NOT released by the close path', () => {
            // BUILD — one stale CONFIRMED (the closing position) and one fresh PENDING (incoming new position)
            const ledger = makeLedger();

            ledger.reserve(buildReservation({ reservationId: 'old-open:A', symbol: 'ETHUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('old-open:A');

            // Incoming new OPEN has raced and created a PENDING before the closed-event fires
            ledger.reserve(buildReservation({ reservationId: 'new-open:A', symbol: 'ETHUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }));

            expect(ledger.listActive()).toHaveLength(2);

            // OPERATE — close-path release for the closing position
            const released = ledger.releaseConfirmedReservationsFor('ETHUSDT', PositionSlotEnum.A);

            // CHECK — only the CONFIRMED reservation is freed; the PENDING survives
            expect(released).toBe(1);
            const remaining = ledger.listActive();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].reservationId).toBe('new-open:A');
            expect(remaining[0].state).toBe(ReservationStateEnum.PENDING);
        });

        it('idempotent double-release: second call on same (symbol, slot) returns 0 and does not error', () => {
            // BUILD
            const ledger = makeLedger();
            ledger.reserve(buildReservation({ reservationId: 'r1:A', symbol: 'SOLUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('r1:A');

            // OPERATE — first release succeeds; second is a no-op
            const firstCount = ledger.releaseConfirmedReservationsFor('SOLUSDT', PositionSlotEnum.A);
            const secondCount = ledger.releaseConfirmedReservationsFor('SOLUSDT', PositionSlotEnum.A);

            // CHECK
            expect(firstCount).toBe(1);
            expect(secondCount).toBe(0);
            expect(ledger.listActive()).toHaveLength(0);
        });

        it('cross-slot isolation: releasing slot A leaves slot B reservation intact', () => {
            // BUILD — two positions on different slots
            const ledger = makeLedger();

            ledger.reserve(buildReservation({ reservationId: 'r-a', symbol: 'BTCUSDT', slot: PositionSlotEnum.A, state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('r-a');

            ledger.reserve(buildReservation({ reservationId: 'r-b', symbol: 'BTCUSDT', slot: PositionSlotEnum.B, state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('r-b');

            // OPERATE — release only slot A
            ledger.releaseConfirmedReservationsFor('BTCUSDT', PositionSlotEnum.A);

            // CHECK — slot B reservation still active
            const remaining = ledger.listActive();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].reservationId).toBe('r-b');
            expect(remaining[0].slot).toBe(PositionSlotEnum.B);
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
