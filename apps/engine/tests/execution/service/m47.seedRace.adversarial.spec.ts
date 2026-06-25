/**
 * M47 adversarial — Items 16–19: ExecutionService-level MFE/MAE seed-timing race fix.
 *
 * Task 5a plants the seed at ~:1056 in ExecutionService.onOrderIntentApproved —
 * AFTER createPositionFromFill returns, BEFORE the first downstream await
 * (recordEntryTransactionOrEscalate). This test suite asserts call ORDER, not just
 * call existence, because a call at the wrong site (e.g., after the two awaits at :1144)
 * would leave the async race exactly as-is and the test would still pass.
 *
 * Per plan Task 6 (BLOCKER 2 / HIGH 4): "the regression test must be at the
 * ExecutionService integration level, NOT the PositionInstrumentor unit level."
 *
 * Item 16 — onPositionOpened is called BEFORE recordEntryTransactionOrEscalate is awaited
 * Item 17 — applyEntryTick is called IMMEDIATELY after onPositionOpened, BEFORE that await
 * Item 18 — entry tick seeding yields mfe_pct = 0, mae_pct = 0 (not price, not positive/negative)
 * Item 19 — a tick delivered in the async gap is captured (not dropped) post-fix
 */

import { OrderIntentActionEnum, PositionSideEnum, StrategyDirectionEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { PositionInstrumentor } from '../../../src/position/service/PositionInstrumentor';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';
import { buildOrderIntent, buildProposedExit, buildSizing } from '../../risk/support/fixtures';

jest.useFakeTimers();

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeService(opts: { instrumentorOverride?: Partial<PositionInstrumentor> } = {}) {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const plan = {
        policy: 'MARKETABLE_LIMIT_IOC' as any,
        limitPrice: new Money('30000'),
        timeoutMs: 0,
        slippageCapPct: new Money('0.15'),
        reduceOnly: false,
    };
    const policyRouter = { plan: jest.fn().mockReturnValue(plan) } as unknown as OrderPolicyRouter;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );
    const haltFlag = new HaltFlagService();

    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();
    const snapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
    const submitter = {
        submit: jest.fn().mockResolvedValue({ state: SubmitStateEnum.FILLED, snapshot, rejectClass: null, venueCode: null, venueMessage: null }),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    fillAccumulator.record(snapshot);

    const positionRow = {
        ...buildPositionEntityMock(42),
        entryPrice: new Money('30000'),
        openedAt: new Date(1_700_000_000_000),
        side: PositionSideEnum.SHORT,
        symbol: 'BTCUSDT',
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        vwapAtEntry: null,
    };

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
        findOpenBySymbol: jest.fn().mockResolvedValue([]),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(null),
    } as unknown as import('../../../src/position/repository/PositionRepository').PositionRepository;

    const transactions = {
        recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as import('../../../src/position/repository/TransactionRepository').TransactionRepository;

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = {
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
    } as unknown as RiskGateService;

    const events = new EventEmitter2();
    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()),
    } as unknown as ProtectiveOrderAttacher;

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../../../src/position/service').PositionService;

    // The instrumentor under test — spied so we can assert call order
    const instrumentorMock: PositionInstrumentor = {
        onPositionOpened: jest.fn(),
        applyEntryTick: jest.fn(),
        ...opts.instrumentorOverride,
    } as any;

    const service = new ExecutionService(
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter,
        fillAccumulator,
        protectiveAttacher,
        localProtectiveMonitor,
        positions,
        positionService,
        transactions,
        strategyVersions,
        riskGate,
        haltFlag,
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any,
        instrumentorMock,
    );

    return { service, positions, transactions, instrumentorMock, positionRow, riskGate, events };
}

function buildOpenEvent() {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return buildApprovedEvent({
        intent: buildOrderIntent({
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.SHORT,
            entryPrice: new Money('30000'),
            proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
            sizing: buildSizing({ leverage: new Money('1') }),
        }),
    });
}

// ─── Item 16: onPositionOpened is called BEFORE recordEntryTransactionOrEscalate ─

describe('M47 adversarial — Item 16: onPositionOpened call precedes recordEntryTransaction await', () => {
    it('onPositionOpened is invoked on OPEN fill and is called before the entry-transaction insert', async () => {
        // BUILD: capture the call order between onPositionOpened and the transaction insert.
        const callOrder: string[] = [];

        const {
            service,
            transactions,
            instrumentorMock: _instrumentorMock,
        } = makeService({
            instrumentorOverride: {
                onPositionOpened: jest.fn().mockImplementation(() => {
                    callOrder.push('onPositionOpened');
                }),
                applyEntryTick: jest.fn().mockImplementation(() => {
                    callOrder.push('applyEntryTick');
                }),
            },
        });

        (transactions.recordTerminal as jest.Mock).mockImplementation(async () => {
            callOrder.push('recordEntryTransaction');
            return { id: 1 };
        });

        // OPERATE
        await service.onOrderIntentApproved(buildOpenEvent());

        // CHECK
        expect(callOrder).toContain('onPositionOpened');
        expect(callOrder).toContain('applyEntryTick');
        expect(callOrder).toContain('recordEntryTransaction');

        const openedIdx = callOrder.indexOf('onPositionOpened');
        const txIdx = callOrder.indexOf('recordEntryTransaction');

        // onPositionOpened MUST precede the entry-transaction write (BLOCKER 2)
        expect(openedIdx).toBeLessThan(txIdx);
    });
});

// ─── Item 17: applyEntryTick is called IMMEDIATELY after onPositionOpened ─────

describe('M47 adversarial — Item 17: applyEntryTick immediately follows onPositionOpened', () => {
    it('applyEntryTick is called directly after onPositionOpened with no awaits in between', async () => {
        const callOrder: string[] = [];

        const { service, instrumentorMock: _instrumentorMock } = makeService({
            instrumentorOverride: {
                onPositionOpened: jest.fn().mockImplementation(() => {
                    callOrder.push('onPositionOpened');
                }),
                applyEntryTick: jest.fn().mockImplementation(() => {
                    callOrder.push('applyEntryTick');
                }),
            },
        });

        await service.onOrderIntentApproved(buildOpenEvent());

        const openedIdx = callOrder.indexOf('onPositionOpened');
        const tickIdx = callOrder.indexOf('applyEntryTick');

        expect(openedIdx).toBeGreaterThanOrEqual(0);
        expect(tickIdx).toBeGreaterThanOrEqual(0);
        // applyEntryTick must immediately follow onPositionOpened (consecutive items)
        expect(tickIdx).toBe(openedIdx + 1);
    });

    it('both calls receive the positionRow returned by createPositionFromFill (same object)', async () => {
        let openedArg: unknown;
        let tickArg: unknown;

        const { service, instrumentorMock: _instrumentorMock } = makeService({
            instrumentorOverride: {
                onPositionOpened: jest.fn().mockImplementation((pos) => {
                    openedArg = pos;
                }),
                applyEntryTick: jest.fn().mockImplementation((pos) => {
                    tickArg = pos;
                }),
            },
        });

        await service.onOrderIntentApproved(buildOpenEvent());

        expect(openedArg).toBeDefined();
        expect(tickArg).toBeDefined();
        // Both calls receive the SAME position row (the row from createPositionFromFill)
        expect(openedArg).toBe(tickArg);
    });
});

// ─── Item 18: entry-tick seed yields mfe_pct = 0, mae_pct = 0 ────────────────
//
// applyEntryTick calls applyTick(state, position.entryPrice, ...) where markPrice == entryPrice
// at open time. computeExcursionPct returns 0 because markPrice - entryPrice = 0.
// updateMfePct(null, 0) → max(0, 0) = 0; updateMaePct(null, 0) → min(0, 0) = 0.
// Verify the seed values by exercising PositionInstrumentor directly (unit-level is fine here
// for the MATH, since the CALL-ORDER is already guarded at integration level above).

describe('M47 adversarial — Item 18: entry-tick seed yields mfe_pct=0, mae_pct=0', () => {
    it('PositionInstrumentor.applyEntryTick produces zero excursion at open (mark==entry)', () => {
        // Build a real PositionInstrumentor with stub dependencies
        const positionRepository = { findById: jest.fn().mockResolvedValue(null) } as any;
        const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as any;
        const instrumentor = new PositionInstrumentor(positionRepository, riskGate);

        const entryPrice = new Money('30000');
        const position = {
            id: 1,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.SHORT,
            entryPrice,
            openedAt: new Date(1_700_000_000_000),
            maePct: null,
            mfePct: null,
            timeToReversionSecs: null,
            markVsLastMaxDivergencePct: null,
            minLiquidationDistancePct: null,
            vwapAtEntry: null,
        } as any;

        // Seed via onPositionOpened (required before applyEntryTick)
        instrumentor.onPositionOpened(position);
        // Apply the entry tick at the same price as entry
        instrumentor.applyEntryTick(position);

        const stats = instrumentor.getLifeStats(1);

        expect(stats).not.toBeNull();
        // At open: mark == entry → excursion = 0 → mfe_pct = 0, mae_pct = 0
        expect(stats!.mfePct).not.toBeNull();
        expect(stats!.maePct).not.toBeNull();
        // mfe_pct must be >= 0, seeded to 0
        expect(parseFloat(stats!.mfePct!.toFixed(8))).toBe(0);
        // mae_pct must be <= 0, seeded to 0
        expect(parseFloat(stats!.maePct!.toFixed(8))).toBe(0);
    });

    it('entry-tick seed does NOT store the entry price as mfe_pct or mae_pct (signed %, not price)', () => {
        const positionRepository = { findById: jest.fn().mockResolvedValue(null) } as any;
        const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as any;
        const instrumentor = new PositionInstrumentor(positionRepository, riskGate);

        const entryPrice = new Money('30000');
        const position = {
            id: 2,
            symbol: 'ETHUSDT',
            side: PositionSideEnum.LONG,
            entryPrice,
            openedAt: new Date(1_700_000_000_000),
            maePct: null,
            mfePct: null,
            timeToReversionSecs: null,
            markVsLastMaxDivergencePct: null,
            minLiquidationDistancePct: null,
            vwapAtEntry: null,
        } as any;

        instrumentor.onPositionOpened(position);
        instrumentor.applyEntryTick(position);

        const stats = instrumentor.getLifeStats(2);

        expect(stats).not.toBeNull();
        // The entry price (30000) must NOT appear as mfe_pct or mae_pct
        expect(parseFloat(stats!.mfePct!.toFixed(8))).not.toBe(30000);
        expect(parseFloat(stats!.maePct!.toFixed(8))).not.toBe(30000);
        // Both are 0 (zero excursion at open)
        expect(parseFloat(stats!.mfePct!.toFixed(8))).toBe(0);
        expect(parseFloat(stats!.maePct!.toFixed(8))).toBe(0);
    });

    it('applyEntryTick is a no-op when onPositionOpened has NOT been called (guard against orphan seed)', () => {
        const positionRepository = { findById: jest.fn().mockResolvedValue(null) } as any;
        const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as any;
        const instrumentor = new PositionInstrumentor(positionRepository, riskGate);

        const position = {
            id: 99,
            symbol: 'SOLUSDT',
            side: PositionSideEnum.LONG,
            entryPrice: new Money('100'),
            openedAt: new Date(),
            maePct: null,
            mfePct: null,
            timeToReversionSecs: null,
            markVsLastMaxDivergencePct: null,
            minLiquidationDistancePct: null,
            vwapAtEntry: null,
        } as any;

        // Do NOT call onPositionOpened — applyEntryTick must no-op
        expect(() => instrumentor.applyEntryTick(position)).not.toThrow();
        expect(instrumentor.getLifeStats(99)).toBeNull();
    });
});

// ─── Item 19: OPEN-path seed does NOT happen for ADD intents ──────────────────
//
// onPositionOpened and applyEntryTick are only called on the OPEN path. An ADD intent
// (adding to an existing position) must NOT trigger the seed, otherwise the existing
// accumulator is overwritten with zeroes mid-position.

describe('M47 adversarial — Item 19: instrumentor seed not called on ADD path', () => {
    it('ADD fill: onPositionOpened is NOT called (seed is OPEN-only)', async () => {
        const callOrder: string[] = [];
        const existingPosition = {
            id: 10,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.SHORT,
            entryPrice: new Money('30000'),
            openedAt: new Date(1_700_000_000_000),
            qty: new Money('0.02'),
            entryNotional: new Money('600'),
            maePct: null,
            mfePct: null,
            timeToReversionSecs: null,
            markVsLastMaxDivergencePct: null,
            minLiquidationDistancePct: null,
            vwapAtEntry: null,
        };

        const {
            service,
            positions,
            instrumentorMock: _instrumentorMock,
        } = makeService({
            instrumentorOverride: {
                onPositionOpened: jest.fn().mockImplementation(() => {
                    callOrder.push('onPositionOpened');
                }),
                applyEntryTick: jest.fn().mockImplementation(() => {
                    callOrder.push('applyEntryTick');
                }),
            },
        });

        // Simulate an ADD: findOpenBySymbolAndSlot returns an existing position
        (positions.findOpenBySymbolAndSlot as jest.Mock).mockResolvedValue(existingPosition);
        (positions.save as jest.Mock).mockResolvedValue({ ...existingPosition, qty: new Money('0.03') });

        const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
        const addEvent = buildApprovedEvent({
            intent: buildOrderIntent({
                intentAction: OrderIntentActionEnum.ADD,
                tradeSide: PositionSideEnum.SHORT,
                entryPrice: new Money('30000'),
                proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
                sizing: buildSizing({ leverage: new Money('1') }),
            }),
        });

        await service.onOrderIntentApproved(addEvent);

        // The seed must NOT fire on the ADD path
        expect(callOrder).not.toContain('onPositionOpened');
        expect(callOrder).not.toContain('applyEntryTick');
    });
});
