/**
 * ExecutionService — M45 D4 adversarial double-close guard tests.
 *
 * Coverage:
 *   D1 — double close: two concurrent closing fills on the same positionId;
 *        exactly one proceeds to POSITION_CLOSED_EVENT; the second returns
 *        silently without emitting POSITION_CLOSED_EVENT a second time.
 *   D3 — failure-path lifecycle: the first close attempt throws after the guard
 *        adds the positionId to closingInFlight; a subsequent attempt on the
 *        same positionId must succeed (finally block cleared the set).
 */

import {
    ExitReasonEnum,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    StrategyDirectionEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { POSITION_CLOSED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../../src/position/repository/TransactionRepository';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildOrderIntent, buildSizing } from '../../risk/support/fixtures';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot } from '../support/fixtures';

jest.useFakeTimers();

// ─── shared reduce-plan ───────────────────────────────────────────────────────

function buildReducePlan() {
    return {
        policy: OrderPolicyEnum.REDUCE_MARKET,
        limitPrice: new Money('30000'),
        timeoutMs: 0,
        slippageCapPct: new Money('0'),
        reduceOnly: true,
    };
}

// ─── position row helpers ─────────────────────────────────────────────────────

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
        stopLossPrice: new Money('29500'),
        takeProfitPrice: new Money('31000'),
        ...overrides,
    } as PositionEntity;
}

// ─── close-intent builder ─────────────────────────────────────────────────────

function buildCloseIntent() {
    return buildApprovedEvent({
        intent: buildOrderIntent({
            intentAction: OrderIntentActionEnum.CLOSE,
            sizing: buildSizing({ qty: new Money('0.01') }),
            exitReason: ExitReasonEnum.STOP_LOSS,
        }),
    });
}

// ─── service factory ──────────────────────────────────────────────────────────

interface IServiceDeps {
    service: ExecutionService;
    positionService: {
        transition: jest.Mock;
        adjustQty: jest.Mock;
        finalizeRealizedPnl: jest.Mock;
    };
    positions: {
        createOpen: jest.Mock;
        save: jest.Mock;
        findOpenBySymbolAndSlot: jest.Mock;
    };
    transactions: { recordTerminal: jest.Mock };
    riskGate: { releaseReservation: jest.Mock; confirmReservation: jest.Mock };
    emitSpy: jest.SpyInstance;
    events: EventEmitter2;
}

function makeService(
    overrides: {
        positionRow?: PositionEntity;
        transitionFn?: jest.Mock;
        finalizeRealizedPnlFn?: jest.Mock;
    } = {},
): IServiceDeps {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const policyRouter = {
        plan: jest.fn().mockReturnValue(buildReducePlan()),
    } as unknown as OrderPolicyRouter;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );

    const haltFlag = new HaltFlagService();
    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as never;

    const clientOrderIdFactory = new ClientOrderIdFactory();

    const snapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
    const submitter = {
        submit: jest.fn().mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        }),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    fillAccumulator.record(snapshot);

    const positionRow = overrides.positionRow ?? buildPositionRow();

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue({ ...positionRow }),
    } as unknown as IServiceDeps['positions'];

    const transactions = {
        recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as TransactionRepository;

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = {
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
    } as unknown as IServiceDeps['riskGate'];

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()),
    } as unknown as ProtectiveOrderAttacher;

    const finalizeResult = buildPositionRow({
        state: PositionStateEnum.CLOSED,
        exitReason: ExitReasonEnum.STOP_LOSS,
    });

    const positionService = {
        transition: overrides.transitionFn ?? jest.fn().mockResolvedValue(positionRow),
        adjustQty: jest.fn().mockImplementation(async (_id: number, newQty: import('../../../src/common/utils/money').MoneyValue) => {
            return { ...positionRow, qty: newQty };
        }),
        finalizeRealizedPnl: overrides.finalizeRealizedPnlFn ?? jest.fn().mockResolvedValue(finalizeResult),
    } as unknown as IServiceDeps['positionService'];

    const service = new ExecutionService(
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter,
        fillAccumulator,
        protectiveAttacher,
        localProtectiveMonitor,
        positions as unknown as PositionRepository,
        positionService as unknown as PositionService,
        transactions as never,
        strategyVersions,
        riskGate as unknown as RiskGateService,
        haltFlag,
        // partial mocks — only the tested methods are needed; full type unused
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any,
        // M47 Task 5a — instrumentor seed stub (synchronous open-path seeding).
        { onPositionOpened: jest.fn(), applyEntryTick: jest.fn() } as never,
    );

    return {
        service,
        positionService,
        positions: positions as unknown as IServiceDeps['positions'],
        transactions: transactions as unknown as IServiceDeps['transactions'],
        riskGate: riskGate as unknown as IServiceDeps['riskGate'],
        emitSpy,
        events,
    };
}

// ─── D1: double-close concurrent guard ───────────────────────────────────────

describe('ExecutionService M45 D4 — D1: concurrent closing fills on the same position', () => {
    it('only one POSITION_CLOSED_EVENT emitted when two closing fills race', async () => {
        // BUILD: resolve is deferred so the first call holds the closingInFlight set
        // entry while the second call starts. Use a latch to control ordering.
        let firstCallResolve!: () => void;
        const firstCallBarrier = new Promise<void>((res) => {
            firstCallResolve = res;
        });

        // transitionFn: first invocation blocks until we release it; second invocation
        // (if it ever reaches here — it should NOT, the guard fires first) resolves immediately.
        let transitionCallCount = 0;
        const transitionFn = jest.fn().mockImplementation(async () => {
            transitionCallCount++;
            if (transitionCallCount === 1) {
                await firstCallBarrier;
            }
        });

        const { service, emitSpy } = makeService({ transitionFn });

        const closeIntent = buildCloseIntent();

        // OPERATE: start both calls without awaiting either yet
        const firstCall = service.onOrderIntentApproved(closeIntent);

        // Yield so the first call reaches the closingInFlight.add() (before awaiting transition)
        await Promise.resolve();
        await Promise.resolve();

        // Second call starts — the guard should detect positionId in closingInFlight and return
        const secondCall = service.onOrderIntentApproved(closeIntent);

        // Release the first call's latch so it can finish
        firstCallResolve();

        await Promise.all([firstCall, secondCall]);

        // CHECK: exactly one POSITION_CLOSED_EVENT
        const closedEvents = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedEvents).toHaveLength(1);
    });

    it('second concurrent close does not emit POSITION_CLOSED_EVENT — the guard prevents double finalize', async () => {
        // The closingInFlight guard prevents the close FINALIZATION path (qty→0, transition→CLOSING,
        // finalizeRealizedPnl, POSITION_CLOSED_EVENT) from running twice. The reservation release
        // in handleReduceTerminal is intentionally outside the guard (each call manages its own
        // order reservation). This test asserts the specific contract: one POSITION_CLOSED_EVENT.
        let firstCallResolve!: () => void;
        const firstCallBarrier = new Promise<void>((res) => {
            firstCallResolve = res;
        });

        let transitionCallCount = 0;
        const transitionFn = jest.fn().mockImplementation(async () => {
            transitionCallCount++;
            if (transitionCallCount === 1) {
                await firstCallBarrier;
            }
        });

        const { service, emitSpy } = makeService({ transitionFn });

        const closeIntent = buildCloseIntent();

        const firstCall = service.onOrderIntentApproved(closeIntent);

        await Promise.resolve();
        await Promise.resolve();

        const secondCall = service.onOrderIntentApproved(closeIntent);

        firstCallResolve();
        await Promise.all([firstCall, secondCall]);

        // Only one POSITION_CLOSED_EVENT — the guard blocked the second finalize
        const closedEvents = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedEvents).toHaveLength(1);
    });
});

// ─── D3: failure-path lifecycle — finally block clears the set ───────────────

describe('ExecutionService M45 D4 — D3: finally block clears closingInFlight after a thrown error', () => {
    it('a subsequent close attempt succeeds after the first threw during positions.save', async () => {
        // BUILD: positions.save throws on first call, succeeds on second.
        // The throw fires AFTER closingInFlight.add() runs — verifying the finally clears it.
        // findOpenBySymbolAndSlot uses mockImplementation to return a FRESH entity per call
        // so the second call does not see the qty=0 mutation left by the first call.
        let saveCallCount = 0;

        const positionRow = buildPositionRow();

        const saveFn = jest.fn().mockImplementation(async () => {
            saveCallCount++;
            if (saveCallCount === 1) {
                throw new Error('simulated save failure');
            }
            return positionRow;
        });

        // Each findOpenBySymbolAndSlot call returns a fresh snapshot of positionRow
        // so the second close attempt does not see qty=0 from the first attempt's mutation.
        const findSlotFn = jest.fn().mockImplementation(async () => ({ ...positionRow }));

        const finalizeResult = buildPositionRow({
            state: PositionStateEnum.CLOSED,
            exitReason: ExitReasonEnum.STOP_LOSS,
        } as unknown as Partial<PositionEntity>);

        const { service, emitSpy } = makeService({
            positionRow,
            finalizeRealizedPnlFn: jest.fn().mockResolvedValue(finalizeResult),
        });

        // Patch save and findOpenBySymbolAndSlot on the positions mock after construction
        // by accessing the service's deps through a spy approach. Since ExecutionService
        // is constructed with the positions mock, we patch the mock directly:
        const positionsMockViaService = (service as unknown as { positions: { save: jest.Mock; findOpenBySymbolAndSlot: jest.Mock } }).positions;
        positionsMockViaService.save = saveFn;
        positionsMockViaService.findOpenBySymbolAndSlot = findSlotFn;

        const closeIntent = buildCloseIntent();

        // OPERATE: first call — save throws, finally must clear closingInFlight
        await service.onOrderIntentApproved(closeIntent);

        // The first call threw inside the try. The finally block must have deleted
        // the positionId from closingInFlight.

        // Second call — must not be blocked by the closingInFlight guard
        await service.onOrderIntentApproved(closeIntent);

        // CHECK: second attempt reached POSITION_CLOSED_EVENT (it ran the full close path)
        const closedEvents = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedEvents).toHaveLength(1);
    });

    it('closingInFlight guard does not permanently lock the position after a failed close attempt', async () => {
        // If closingInFlight is not cleared by finally, the second close would be rejected by
        // the guard (early return without POSITION_CLOSED_EVENT). This test verifies that the
        // second attempt reaches POSITION_CLOSED_EVENT — confirming the guard was cleared.
        let saveCallCount = 0;

        const positionRow = buildPositionRow();

        const saveFn = jest.fn().mockImplementation(async () => {
            saveCallCount++;
            if (saveCallCount === 1) {
                throw new Error('first save failed');
            }
            return positionRow;
        });

        const findSlotFn = jest.fn().mockImplementation(async () => ({ ...positionRow }));

        const finalizeResult = buildPositionRow({
            state: PositionStateEnum.CLOSED,
            exitReason: ExitReasonEnum.STOP_LOSS,
        } as unknown as Partial<PositionEntity>);

        const { service, emitSpy } = makeService({
            positionRow,
            finalizeRealizedPnlFn: jest.fn().mockResolvedValue(finalizeResult),
        });

        const positionsMockViaService = (service as unknown as { positions: { save: jest.Mock; findOpenBySymbolAndSlot: jest.Mock } }).positions;
        positionsMockViaService.save = saveFn;
        positionsMockViaService.findOpenBySymbolAndSlot = findSlotFn;

        const closeIntent = buildCloseIntent();

        // First attempt: save throws → closingInFlight.add() ran, finalizeRealizedPnl did NOT run
        await service.onOrderIntentApproved(closeIntent);

        // Second attempt: the finally block cleared the set → this call is NOT rejected by the guard
        await service.onOrderIntentApproved(closeIntent);

        // If the guard was NOT cleared, the second call would return early without POSITION_CLOSED_EVENT.
        // One POSITION_CLOSED_EVENT confirms the second call completed the close path successfully.
        const closedEvents = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedEvents).toHaveLength(1);
    });
});
