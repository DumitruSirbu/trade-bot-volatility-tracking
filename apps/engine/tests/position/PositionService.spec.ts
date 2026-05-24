/**
 * PositionService.transition — unit tests (M6 W1, ADR 0009 §2/§3/§6).
 *
 * Coverage matrix:
 *   - Every legal transition succeeds, persists state, emits event.
 *   - Every illegal transition throws IllegalStateTransitionException, no event emitted,
 *     no row write.
 *   - PositionNotFoundException raised when positionId does not resolve.
 *   - Event payload carries the correct fields (fromState, toState, transitionedAtMs,
 *     eventClass).
 *
 * Pure unit test: the repository and EventEmitter2 are jest mocks; no DB.
 */

import { IPositionStateTransitionedEvent, PositionStateEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { POSITION_STATE_TRANSITIONED_EVENT } from '../../src/position/const';
import { PositionEntity } from '../../src/position/entity';
import { IllegalStateTransitionException, PositionNotFoundException } from '../../src/position/exception';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { PositionService } from '../../src/position/service';

interface IMockedDeps {
    repository: jest.Mocked<Pick<PositionRepository, 'findById' | 'save'>>;
    events: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
    service: PositionService;
}

function buildPosition(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        state: PositionStateEnum.OPEN,
        ...overrides,
    } as PositionEntity;
}

function buildService(initial: PositionEntity | null): IMockedDeps {
    const repository = {
        findById: jest.fn().mockResolvedValue(initial),
        save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
    } as jest.Mocked<Pick<PositionRepository, 'findById' | 'save'>>;

    const events = {
        emit: jest.fn().mockReturnValue(true),
    } as jest.Mocked<Pick<EventEmitter2, 'emit'>>;

    // M6 W5: PositionService depends on TransactionRepository for finalizeRealizedPnl
    // + recordFunding. The existing transition / adjustQty tests don't exercise it.
    const transactions = {
        findByPosition: jest.fn().mockResolvedValue([]),
        recordTerminal: jest.fn().mockImplementation(async (e: unknown) => e),
    } as unknown as import('../../src/position/repository/TransactionRepository').TransactionRepository;

    const service = new PositionService(repository as unknown as PositionRepository, transactions, events as unknown as EventEmitter2);

    return { repository, events, service };
}

// Legal arrows under ADR 0009 §3. The graph is exhaustive: anything not in this list
// must reject (asserted in the illegal-transitions block below).
const LEGAL_ARROWS: Array<{ from: PositionStateEnum; to: PositionStateEnum }> = [
    { from: PositionStateEnum.PENDING_OPEN, to: PositionStateEnum.OPEN },
    { from: PositionStateEnum.PENDING_OPEN, to: PositionStateEnum.RECONCILING },
    { from: PositionStateEnum.OPEN, to: PositionStateEnum.CLOSING },
    { from: PositionStateEnum.OPEN, to: PositionStateEnum.RECONCILING },
    { from: PositionStateEnum.CLOSING, to: PositionStateEnum.OPEN },
    { from: PositionStateEnum.CLOSING, to: PositionStateEnum.CLOSED },
    { from: PositionStateEnum.CLOSING, to: PositionStateEnum.RECONCILING },
    { from: PositionStateEnum.RECONCILING, to: PositionStateEnum.OPEN },
    { from: PositionStateEnum.RECONCILING, to: PositionStateEnum.CLOSED },
    { from: PositionStateEnum.RECONCILING, to: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED },
    { from: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, to: PositionStateEnum.OPEN },
    { from: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, to: PositionStateEnum.CLOSING },
];

const ALL_STATES: PositionStateEnum[] = [
    PositionStateEnum.PENDING_OPEN,
    PositionStateEnum.OPEN,
    PositionStateEnum.CLOSING,
    PositionStateEnum.CLOSED,
    PositionStateEnum.RECONCILING,
    PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
];

function isLegalArrow(from: PositionStateEnum, to: PositionStateEnum): boolean {
    return LEGAL_ARROWS.some((edge) => edge.from === from && edge.to === to);
}

describe('PositionService.transition — legal transitions (ADR 0009 §3)', () => { // statusAliasFor removed in M7 W0c
    it.each(LEGAL_ARROWS)('persists $from -> $to with correct state, emits event', async ({ from, to }) => {
        // BUILD
        const position = buildPosition({ state: from });
        const { repository, events, service } = buildService(position);

        // OPERATE
        const result = await service.transition(42, to, { nowMs: 1_700_000_000_000, eventClass: 'unit.test' });

        // CHECK
        expect(result.state).toBe(to);
        expect(repository.save).toHaveBeenCalledTimes(1);
        const savedRow = repository.save.mock.calls[0][0];
        expect(savedRow.state).toBe(to);
        expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('emits IPositionStateTransitionedEvent with correct payload (fromState/toState/ts/eventClass)', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { events, service } = buildService(position);

        await service.transition(42, PositionStateEnum.CLOSING, { nowMs: 1_700_000_000_000, eventClass: 'execution.reduce.fill.terminal' });

        const [eventName, payload] = events.emit.mock.calls[0];
        expect(eventName).toBe(POSITION_STATE_TRANSITIONED_EVENT);
        const typed = payload as IPositionStateTransitionedEvent;
        expect(typed.positionId).toBe(42);
        expect(typed.fromState).toBe(PositionStateEnum.OPEN);
        expect(typed.toState).toBe(PositionStateEnum.CLOSING);
        expect(typed.transitionedAtMs).toBe(1_700_000_000_000);
        expect(typed.eventClass).toBe('execution.reduce.fill.terminal');
    });

    it('DB-first ordering: repository.save called BEFORE events.emit (ADR 0009 §6 invariant 2)', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { repository, events, service } = buildService(position);

        const callOrder: string[] = [];
        repository.save.mockImplementation(async (entity: PositionEntity) => {
            callOrder.push('save');
            return entity;
        });
        events.emit.mockImplementation(() => {
            callOrder.push('emit');
            return true;
        });

        await service.transition(42, PositionStateEnum.CLOSING, { nowMs: 1, eventClass: 'unit.test' });

        expect(callOrder).toEqual(['save', 'emit']);
    });
});

describe('PositionService.transition — illegal transitions (ADR 0009 §3 / §6 invariant 3)', () => {
    // Enumerate every (from, to) pair NOT in LEGAL_ARROWS — every such move must reject.
    const illegalArrows: Array<{ from: PositionStateEnum; to: PositionStateEnum }> = [];

    for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
            if (from === to) {
                continue;
            }

            if (!isLegalArrow(from, to)) {
                illegalArrows.push({ from, to });
            }
        }
    }

    it.each(illegalArrows)('rejects $from -> $to with IllegalStateTransitionException', async ({ from, to }) => {
        const position = buildPosition({ state: from });
        const { repository, events, service } = buildService(position);

        await expect(service.transition(42, to, { nowMs: 1, eventClass: 'unit.test' })).rejects.toBeInstanceOf(IllegalStateTransitionException);
        // No row write and no event on illegal moves.
        expect(repository.save).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('rejects self-loops (no PENDING_OPEN -> PENDING_OPEN identity move)', async () => {
        const position = buildPosition({ state: PositionStateEnum.PENDING_OPEN });
        const { service } = buildService(position);

        await expect(service.transition(42, PositionStateEnum.PENDING_OPEN, { nowMs: 1, eventClass: 'unit.test' })).rejects.toBeInstanceOf(
            IllegalStateTransitionException,
        );
    });

    it('CLOSED is terminal: rejects every outgoing move', async () => {
        for (const target of ALL_STATES) {
            if (target === PositionStateEnum.CLOSED) {
                continue;
            }

            const position = buildPosition({ state: PositionStateEnum.CLOSED });
            const { service } = buildService(position);

            await expect(service.transition(42, target, { nowMs: 1, eventClass: 'unit.test' })).rejects.toBeInstanceOf(IllegalStateTransitionException);
        }
    });
});

describe('PositionService.transition — error paths', () => {
    it('throws PositionNotFoundException when positionId resolves to null', async () => {
        const { repository, events, service } = buildService(null);

        await expect(service.transition(999, PositionStateEnum.OPEN, { nowMs: 1, eventClass: 'unit.test' })).rejects.toBeInstanceOf(PositionNotFoundException);
        expect(repository.save).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('IllegalStateTransitionException carries positionId, fromState, toState for diagnostics', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service } = buildService(position);

        let caught: unknown = null;

        try {
            await service.transition(42, PositionStateEnum.PENDING_OPEN, { nowMs: 1, eventClass: 'unit.test' });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(IllegalStateTransitionException);
        const ex = caught as IllegalStateTransitionException;
        expect(ex.positionId).toBe(42);
        expect(ex.fromState).toBe(PositionStateEnum.OPEN);
        expect(ex.toState).toBe(PositionStateEnum.PENDING_OPEN);
        expect(ex.code).toBe('POSITION_ILLEGAL_STATE_TRANSITION');
    });
});
