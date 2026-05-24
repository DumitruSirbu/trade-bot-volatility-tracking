/**
 * R1.3b — adoption-ack instrumentor seeding (R1.3.5).
 *
 * Paired-per-fix coverage:
 *   - R1.3.5: a position promoted via the operator-ack arrow
 *     MANUAL_ADOPTED_UNMANAGED → OPEN seeds the in-memory accumulator
 *     immediately after the transition fires. Pre-fix the instrumentor
 *     ignored this arrow (no `POSITION_OPENED_EVENT` is emitted on ack), so
 *     MAE/MFE/timeToReversion stayed null forever. Post-fix the next
 *     `price.update` after ack accrues analytics as expected.
 *
 * R1.3.3 (constants + exception moves) is mechanical and verified by the
 * build + lint + the full focused test run — no dedicated spec needed.
 */

import { PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';

import { Money } from '../../src/common/utils/money';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 77,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(1_700_000_000_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        vwapAtEntry: null,
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        stopGapPct: null,
        stopLossPrice: new Money('29500'),
        ...overrides,
    } as PositionEntity;
}

function buildHarness(rowOnFind: PositionEntity | null) {
    const findById = jest.fn().mockResolvedValue(rowOnFind);
    const save = jest.fn().mockImplementation(async (p: PositionEntity) => p);
    const positions = { findById, save } as unknown as PositionRepository;
    const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as never;
    const instrumentor = new PositionInstrumentor(positions, riskGate);

    return { instrumentor, findById, save };
}

describe('PositionInstrumentor — R1.3.5 adoption-ack seeding (ADR 0014 §4a)', () => {
    it('MANUAL_ADOPTED_UNMANAGED → OPEN seeds the accumulator from the freshest row (operator-ack path)', async () => {
        const acked = buildPositionRow({ id: 77, side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        const { instrumentor, findById } = buildHarness(acked);

        // Sanity: before the ack the position is NOT in the accumulator —
        // ADR 0013 §2 excludes MANUAL_ADOPTED_UNMANAGED rows from sampling.
        expect(instrumentor.getLifeStats(77)).toBeNull();

        await instrumentor.onPositionStateTransitioned({
            positionId: 77,
            fromState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            toState: PositionStateEnum.OPEN,
            transitionedAtMs: 1_700_000_010_000,
            eventClass: 'adoption.ack',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(findById).toHaveBeenCalledTimes(1);
        expect(findById).toHaveBeenCalledWith(77);

        const stats = instrumentor.getLifeStats(77);
        expect(stats).not.toBeNull();
        expect(stats!.positionId).toBe(77);

        // The next price tick is now sampled (accumulator alive) and accrues
        // analytics — the load-bearing post-fix behavior. Pre-fix this
        // tick was dropped because the accumulator entry never existed.
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: 1_700_000_011_000 });

        const afterTick = instrumentor.getLifeStats(77)!;
        expect(afterTick.maePct).not.toBeNull();
        expect(afterTick.maePct!.lessThan(0)).toBe(true);
    });

    it('PENDING_OPEN → OPEN does NOT trigger the ack-seed path (no findById call from the listener; executor seeds via POSITION_OPENED_EVENT)', async () => {
        const { instrumentor, findById } = buildHarness(buildPositionRow());

        await instrumentor.onPositionStateTransitioned({
            positionId: 77,
            fromState: PositionStateEnum.PENDING_OPEN,
            toState: PositionStateEnum.OPEN,
            transitionedAtMs: 1_700_000_010_000,
            eventClass: 'protective.attached',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        // The transition handler must NOT consume a DB read for the normal
        // open path — POSITION_OPENED_EVENT (a separate handler) owns that
        // seeding. Routing both paths through findById here would double-
        // read the row on every executor-driven open.
        expect(findById).not.toHaveBeenCalled();
        expect(instrumentor.getLifeStats(77)).toBeNull();
    });

    it('adoption ack with a vanished DB row logs + skips (no crash)', async () => {
        const { instrumentor, findById } = buildHarness(null);

        await instrumentor.onPositionStateTransitioned({
            positionId: 999,
            fromState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            toState: PositionStateEnum.OPEN,
            transitionedAtMs: 1_700_000_010_000,
            eventClass: 'adoption.ack',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(findById).toHaveBeenCalledWith(999);
        expect(instrumentor.getLifeStats(999)).toBeNull();
    });
});
