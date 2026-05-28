/**
 * R4.1 paired tests — fail-before / pass-after.
 *
 * Coverage:
 *   - R4.1.1 (instrumentor re-seed on RECONCILING → OPEN): the case-(f)
 *     terminal-survived path now produces this transition in production. The
 *     instrumentor must re-seed the accumulator (mirror of the existing
 *     MANUAL_ADOPTED_UNMANAGED → OPEN seeder) so the recovered position
 *     accrues MAE/MFE from the recovery instant rather than staying null.
 *   - R4.2.1 (case-(f) no-transaction defensive close-out): when
 *     `findRecentTransactionFor` returns null/missing-clientOrderId, case-(f)
 *     used to emit UNRESOLVED_TTL and leave the row in RECONCILING. Same
 *     stuck-loop pathology as the original 3.1.1 (different entry condition).
 *     Now drives the row out via the shared `transitionOutOfReconciling`
 *     helper.
 */

import { DriftCaseEnum, ExitReasonEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IOpenOrderSnapshot, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';
import { PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(NOW_MS),
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

// ─── R4.1.1 — PositionInstrumentor harness ──────────────────────────────────

function buildInstrumentorHarness(row: PositionEntity | null) {
    const findById = jest.fn().mockResolvedValue(row);
    const save = jest.fn().mockImplementation(async (p: PositionEntity) => p);
    const positions = { findById, save } as unknown as PositionRepository;
    const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as never;
    const instrumentor = new PositionInstrumentor(positions, riskGate);

    return { instrumentor, findById, save };
}

describe('R4.1.1 — PositionInstrumentor re-seeds on RECONCILING → OPEN (ADR 0013 §5)', () => {
    it('RECONCILING → OPEN transition reads the freshest row and seeds the accumulator', async () => {
        const recoveredRow = buildPositionRow({ id: 77, side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        const { instrumentor, findById } = buildInstrumentorHarness(recoveredRow);

        // Pre-state: accumulator empty (the row was dropped on entry into RECONCILING).
        expect(instrumentor.getLifeStats(77)).toBeNull();

        await instrumentor.onPositionStateTransitioned({
            positionId: 77,
            fromState: PositionStateEnum.RECONCILING,
            toState: PositionStateEnum.OPEN,
            transitionedAtMs: NOW_MS,
            eventClass: 'reconciliation.f.intent_terminal.open',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(findById).toHaveBeenCalledTimes(1);
        expect(findById).toHaveBeenCalledWith(77);

        const stats = instrumentor.getLifeStats(77);
        expect(stats).not.toBeNull();
        expect(stats!.positionId).toBe(77);

        // Next price tick now accrues MAE on an adverse mark — the load-bearing
        // post-fix behaviour. Pre-fix the tick was dropped because no
        // accumulator entry existed.
        instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });

        const afterTick = instrumentor.getLifeStats(77)!;
        expect(afterTick.maePct).not.toBeNull();
        expect(afterTick.maePct!.lessThan(0)).toBe(true);
    });

    it('RECONCILING → CLOSED still drops without re-seed (closed-path; not a survived recovery)', async () => {
        const { instrumentor, findById } = buildInstrumentorHarness(buildPositionRow({ id: 77 }));

        // First seed via the normal open path so the accumulator exists.
        instrumentor.onPositionOpened(buildPositionRow({ id: 77 }));
        expect(instrumentor.getLifeStats(77)).not.toBeNull();

        // RECONCILING → CLOSED is the close path (handleClose), NOT the recover path.
        findById.mockClear();
        await instrumentor.onPositionStateTransitioned({
            positionId: 77,
            fromState: PositionStateEnum.RECONCILING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: NOW_MS,
            eventClass: 'reconciliation.f.intent_terminal.closed',
            symbol: 'BTCUSDT',
            exitReason: ExitReasonEnum.RECONCILED_MISSING,
            realizedPnl: null,
        });

        // handleClose does its own findById, but the re-seed branch must NOT fire.
        // The accumulator is dropped (CLOSED handling), not re-seeded.
        expect(instrumentor.getLifeStats(77)).toBeNull();
    });

    it('vanished DB row on RECONCILING → OPEN: log + skip (no crash)', async () => {
        const { instrumentor, findById } = buildInstrumentorHarness(null);

        await instrumentor.onPositionStateTransitioned({
            positionId: 999,
            fromState: PositionStateEnum.RECONCILING,
            toState: PositionStateEnum.OPEN,
            transitionedAtMs: NOW_MS,
            eventClass: 'reconciliation.f.intent_terminal.open',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        });

        expect(findById).toHaveBeenCalledWith(999);
        expect(instrumentor.getLifeStats(999)).toBeNull();
    });
});

// ─── R4.2.1 — ReconciliationService case-(f) no-transaction harness ─────────

function buildExchangeSnapshot(qty: string, overrides: Partial<IPositionSnapshot> = {}): IPositionSnapshot {
    return {
        symbol: 'BTCUSDT',
        side: 'long',
        qty,
        entryPrice: '30000',
        markPrice: '30100',
        liquidationPrice: '28000',
        marginType: 'isolated',
        leverage: '5',
        timestampMs: NOW_MS,
        ...overrides,
    };
}

interface IReconHarness {
    service: ReconciliationService;
    positionService: { transition: jest.Mock; finalizeRealizedPnl: jest.Mock };
    riskGate: { reconcileClose: jest.Mock };
    monitor: { arm: jest.Mock; disarm: jest.Mock };
    exchangeClient: { fetchOrderByClientId: jest.Mock };
}

function buildReconHarness(opts: {
    dbPositions?: PositionEntity[];
    exchangePositions?: IPositionSnapshot[];
    openOrders?: IOpenOrderSnapshot[];
    latestTxIsNull?: boolean;
}): IReconHarness {
    const dbPositions = opts.dbPositions ?? [];
    const exchangePositions = opts.exchangePositions ?? [];
    const openOrders = opts.openOrders ?? [];

    const exchangeClient = {
        fetchPositions: jest.fn().mockResolvedValue(exchangePositions),
        fetchOpenOrders: jest.fn().mockResolvedValue(openOrders),
        fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    };

    const positions = {
        findById: jest.fn().mockImplementation(async (id: number) => dbPositions.find((p) => p.id === id) ?? null),
        findOpen: jest.fn().mockResolvedValue(dbPositions),
        createOpen: jest.fn(),
        save: jest.fn().mockImplementation(async (e: PositionEntity) => e),
        findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        updateProtectiveOrderTypeIfState: jest.fn().mockResolvedValue(1),
    };

    const transactions = {
        findByClientOrderId: jest.fn().mockResolvedValue(null),
        findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        // R4.2.1 entry condition: no transaction at all (or null clientOrderId).
        findLatestByPositionId: jest
            .fn()
            .mockResolvedValue(opts.latestTxIsNull === false ? { clientOrderId: 'tbvt-x', createdAt: new Date(NOW_MS - 1_000) } : null),
    };

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(undefined),
        recordFunding: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockResolvedValue(undefined),
    };

    const riskGate = {
        expireStaleReservations: jest.fn(),
        reconcileClose: jest.fn().mockResolvedValue(undefined),
    };

    const monitor = { arm: jest.fn(), disarm: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7, name: 'manual_adopted', version: 0 }) };
    const events = new EventEmitter2();
    const haltFlag = new HaltFlagService();
    const instrumentor = { setLiquidationPrice: jest.fn() } as never;
    const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as never;

    const service = new ReconciliationService(
        exchangeClient as never,
        exchangeClient as never,
        { exchangeEnv: 'testnet' } as never,
        positions as unknown as PositionRepository,
        transactions as unknown as TransactionRepository,
        positionService as unknown as PositionService,
        riskGate as unknown as RiskGateService,
        monitor as unknown as LocalProtectiveMonitor,
        retainer,
        strategyVersions as unknown as StrategyVersionRepository,
        haltFlag,
        instrumentor,
        snapshotWriter,
        events,
    );

    return { service, positionService, riskGate, monitor, exchangeClient };
}

describe('R4.2.1 — case-(f) UNRESOLVED_TTL no-transaction path drives the row out of RECONCILING', () => {
    it('no recent transaction + exchange qty > 0 → transitions RECONCILING → OPEN (survived recovery)', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const exchangePos = buildExchangeSnapshot('0.01');
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [exchangePos],
            latestTxIsNull: true,
        });

        const pass = await h.service.forceTick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]).toBe(1);

        // The transition fires via the shared transitionOutOfReconciling helper.
        expect(h.positionService.transition).toHaveBeenCalledTimes(1);
        const [pid, toState, ctx] = h.positionService.transition.mock.calls[0];
        expect(pid).toBe(42);
        expect(toState).toBe(PositionStateEnum.OPEN);
        expect(ctx.eventClass).toBe('reconciliation.f.intent_terminal.open');

        // No fetchOrderByClientId — we short-circuited on the no-tx branch.
        expect(h.exchangeClient.fetchOrderByClientId).not.toHaveBeenCalled();
    });

    it('no recent transaction + exchange qty == 0 → finalizes RECONCILING → CLOSED with RECONCILED_MISSING', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const exchangePos = buildExchangeSnapshot('0');
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [exchangePos],
            latestTxIsNull: true,
        });

        await h.service.forceTick(NOW_MS);

        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);
        const [pid, exitReason, ctx] = h.positionService.finalizeRealizedPnl.mock.calls[0];
        expect(pid).toBe(42);
        expect(exitReason).toBe(ExitReasonEnum.RECONCILED_MISSING);
        expect(ctx.eventClass).toBe('reconciliation.f.intent_terminal.closed');

        // Symmetric cleanup with case-(b) vanish path.
        expect(h.monitor.disarm).toHaveBeenCalledWith(42);
        expect(h.riskGate.reconcileClose).toHaveBeenCalledWith(42, NOW_MS);
    });

    it('anti-loop: subsequent tick after the no-tx close-out does NOT re-fire case-(f)', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [buildExchangeSnapshot('0.01')],
            latestTxIsNull: true,
        });

        await h.service.forceTick(NOW_MS);
        expect(h.positionService.transition).toHaveBeenCalledTimes(1);

        // Simulate post-transition row state (mocked transition does not mutate dbPositions).
        dbRow.state = PositionStateEnum.OPEN;
        await h.service.forceTick(NOW_MS + 30_000);

        // No additional case-(f) transition — the row is no longer RECONCILING
        // so the case-(f) loop skips it.
        const fTransitions = h.positionService.transition.mock.calls.filter(([, , ctx]) =>
            ((ctx as { eventClass: string }).eventClass ?? '').startsWith('reconciliation.f.intent_terminal'),
        );
        expect(fTransitions).toHaveLength(1);
    });
});
