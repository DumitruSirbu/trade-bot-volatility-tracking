/**
 * SlotReleaseListener — M34 slot-reservation release on POSITION_CLOSED_EVENT.
 *
 * Coverage:
 *   - Happy path: valid positionSlot → riskGate.releaseSlotForClosedPosition called
 *   - Null-slot backstop: positionSlot null → release NOT called, warn logged
 *   - Idempotent double-release: calling releaseSlotForClosedPosition twice for the same
 *     (symbol, slot) is a safe no-op (ledger's RELEASED → RELEASED guard covers it at
 *     the ledger layer; the listener delegates and does not re-gate itself)
 */

import { PositionSideEnum, PositionSlotEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { IPositionClosedEvent } from '../../../src/common/interface';
import { SlotReleaseListener } from '../../../src/risk/listener/SlotReleaseListener';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildEvent(overrides: Partial<IPositionClosedEvent> = {}): IPositionClosedEvent {
    return {
        positionId: 1,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        exitReason: null,
        realizedPnl: new Money('50'),
        closedAt: new Date(1_716_307_200_000),
        entryPrice: new Money('30000'),
        exitPrice: new Money('30500'),
        leverage: new Money('3'),
        strategyVersionId: 1,
        openedAt: new Date(1_716_307_200_000 - 60_000),
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    };
}

interface IMockRiskGate {
    releaseSlotForClosedPosition: jest.Mock;
}

function buildMockRiskGate(): IMockRiskGate {
    return { releaseSlotForClosedPosition: jest.fn() };
}

function buildListener(mockGate: IMockRiskGate): SlotReleaseListener {
    return new SlotReleaseListener(mockGate as unknown as RiskGateService);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('SlotReleaseListener', () => {
    describe('happy path: valid positionSlot triggers slot release', () => {
        it('calls releaseSlotForClosedPosition with the correct symbol and slot', () => {
            const mockGate = buildMockRiskGate();
            const listener = buildListener(mockGate);
            const event = buildEvent({ symbol: 'ETHUSDT', positionSlot: PositionSlotEnum.B });

            listener.onPositionClosed(event);

            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenCalledTimes(1);
            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenCalledWith('ETHUSDT', PositionSlotEnum.B);
        });

        it('passes through slot C (correlated slot) correctly', () => {
            const mockGate = buildMockRiskGate();
            const listener = buildListener(mockGate);
            const event = buildEvent({ symbol: 'BTCUSDT', positionSlot: PositionSlotEnum.C });

            listener.onPositionClosed(event);

            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenCalledWith('BTCUSDT', PositionSlotEnum.C);
        });
    });

    describe('null-slot backstop: missing slot is a no-op', () => {
        it('does NOT call releaseSlotForClosedPosition when positionSlot is null', () => {
            const mockGate = buildMockRiskGate();
            const listener = buildListener(mockGate);
            const event = buildEvent({ positionSlot: null });

            listener.onPositionClosed(event);

            expect(mockGate.releaseSlotForClosedPosition).not.toHaveBeenCalled();
        });

        it('does not throw when positionSlot is null (legacy/adopted row)', () => {
            const mockGate = buildMockRiskGate();
            const listener = buildListener(mockGate);
            const event = buildEvent({ positionSlot: null });

            expect(() => listener.onPositionClosed(event)).not.toThrow();
        });
    });

    describe('idempotent double-release: duplicate POSITION_CLOSED_EVENT does not cause error', () => {
        it('delegates both calls; the ledger RELEASED → RELEASED no-op is the safety net', () => {
            // The listener itself does not gate on a second call — it passes through to the gate
            // which passes through to the ledger where the terminal-state guard lives. Both calls
            // must succeed without throwing.
            const mockGate = buildMockRiskGate();
            const listener = buildListener(mockGate);
            const event = buildEvent({ symbol: 'SOLUSDT', positionSlot: PositionSlotEnum.A });

            expect(() => {
                listener.onPositionClosed(event);
                listener.onPositionClosed(event);
            }).not.toThrow();

            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenCalledTimes(2);
            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenNthCalledWith(1, 'SOLUSDT', PositionSlotEnum.A);
            expect(mockGate.releaseSlotForClosedPosition).toHaveBeenNthCalledWith(2, 'SOLUSDT', PositionSlotEnum.A);
        });
    });

    describe('ledger-level idempotency via ReservationLedger: double-release returns 0 on second call', () => {
        it('RELEASED → RELEASED transition is a safe no-op in the ledger (terminal state guard)', () => {
            // This wires the REAL ledger so we can verify the ledger-level idempotency that
            // guards the narrow race between the SlotReleaseListener and reconcileClose.
            const { ReservationLedger } = jest.requireActual<typeof import('../../../src/risk/service/ReservationLedger')>(
                '../../../src/risk/service/ReservationLedger',
            );
            const { ReservationStateEnum } = jest.requireActual<typeof import('../../../src/risk/enum')>('../../../src/risk/enum');
            const { PositionSlotEnum: SlotEnum } = jest.requireActual<typeof import('@bot/shared')>('@bot/shared');

            const ledger = new ReservationLedger();

            const { buildReservation } = jest.requireActual<typeof import('../support/fixtures')>('../support/fixtures');
            ledger.reserve(buildReservation({ reservationId: 'r1:A', symbol: 'AVAXUSDT', slot: SlotEnum.A, state: ReservationStateEnum.PENDING }));
            ledger.confirmReservation('r1:A');

            const firstRelease = ledger.releaseConfirmedReservationsFor('AVAXUSDT', SlotEnum.A);
            const secondRelease = ledger.releaseConfirmedReservationsFor('AVAXUSDT', SlotEnum.A);

            expect(firstRelease).toBe(1);
            expect(secondRelease).toBe(0);
            expect(ledger.listActive()).toHaveLength(0);
        });
    });
});
