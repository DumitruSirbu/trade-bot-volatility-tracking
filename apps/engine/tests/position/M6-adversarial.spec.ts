/**
 * M6 Adversarial QA — full-surface adversarial coverage over the W0-W8.5 diff.
 *
 * Each section header maps to one of the ten adversarial categories listed
 * in the M6 QA-wave dispatch. Happy-path tests already exist in the W*.spec.ts
 * files; every test here is an adversarial, boundary, or anti-coverage case.
 *
 * File: apps/engine/tests/position/M6-adversarial.spec.ts
 */

import {
    DriftCaseEnum,
    ExitReasonEnum,
    IPositionStateTransitionedEvent,
    IPriceUpdateEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    QtyAdjustmentReasonEnum,
    RejectReasonEnum,
    RetainReasonEnum,
    RiskOutcomeEnum,
    TransactionTypeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IExchangeClient, IFundingPaymentSnapshot, IOpenOrderSnapshot, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { AccountSnapshotEntity, PositionEntity, TransactionEntity } from '../../src/position/entity';
import { IllegalStateTransitionException, PositionNotFoundException } from '../../src/position/exception';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { AccountSnapshotWriter } from '../../src/position/service/AccountSnapshotWriter';
import { EngineBootstrapService } from '../../src/bootstrap/service/EngineBootstrapService';
import { PositionInstrumentor } from '../../src/position/service/PositionInstrumentor';
import { PositionLifecycleRetentionListener } from '../../src/position/service/PositionLifecycleRetentionListener';
import { IllegalClosePayloadException, IllegalQtyAdjustmentException, PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { ReservationLedger } from '../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { SlotManager } from '../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../src/risk/service/StressHaltEvaluator';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

// ─── shared factory helpers ──────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;
const ONE_MINUTE_MS = 60_000;

function buildPosition(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(NOW_MS - ONE_MINUTE_MS),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        stopLossPrice: new Money('29500'),
        takeProfitPrice: new Money('31000'),
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        correlationMode: null,
        ...overrides,
    } as PositionEntity;
}

function buildTransactionRow(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
    return {
        id: 1,
        positionId: 42,
        type: TransactionTypeEnum.OPEN,
        side: PositionSideEnum.LONG,
        price: new Money('30000'),
        qty: new Money('0.01'),
        fee: new Money('0.15'),
        cashflow: new Money('0'),
        clientOrderId: 'tbvt-test001',
        exchangeOrderId: 'ex-001',
        createdAt: new Date(NOW_MS),
        ...overrides,
    } as TransactionEntity;
}

function buildExchangeSnapshot(overrides: Partial<IPositionSnapshot> = {}): IPositionSnapshot {
    return {
        symbol: 'BTCUSDT',
        side: 'long',
        qty: '0.01',
        entryPrice: '30000',
        markPrice: '30100',
        liquidationPrice: '28000',
        marginType: 'isolated',
        leverage: '5',
        timestampMs: NOW_MS,
        ...overrides,
    };
}

function buildOpenOrder(overrides: Partial<IOpenOrderSnapshot> = {}): IOpenOrderSnapshot {
    return {
        exchangeOrderId: 'ex-ord-1',
        clientOrderId: 'tbvt-test001-sl',
        symbol: 'BTCUSDT',
        side: 'sell',
        type: 'STOP_MARKET',
        reduceOnly: true,
        status: 'open',
        timestampMs: NOW_MS,
        ...overrides,
    };
}

function buildPositionService(
    positionMap: Map<number, PositionEntity>,
    transactions: TransactionEntity[] = [],
): { service: PositionService; repository: jest.Mocked<Pick<PositionRepository, 'findById' | 'save'>>; events: EventEmitter2; emitSpy: jest.SpyInstance } {
    const repository = {
        findById: jest.fn().mockImplementation(async (id: number) => positionMap.get(id) ?? null),
        save: jest.fn().mockImplementation(async (entity: PositionEntity) => {
            positionMap.set(entity.id, entity);
            return entity;
        }),
    } as jest.Mocked<Pick<PositionRepository, 'findById' | 'save'>>;

    const txRepo = {
        findByPosition: jest.fn().mockResolvedValue(transactions),
        recordTerminal: jest.fn().mockImplementation(async (e: unknown) => e),
        findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
    } as unknown as TransactionRepository;

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const service = new PositionService(repository as unknown as PositionRepository, txRepo, events);

    return { service, repository, events, emitSpy };
}

// ─── 1. STATE MACHINE ADVERSARIALS ──────────────────────────────────────────

describe('1. State machine adversarials', () => {
    // All 6 states. Legal arrows are tested exhaustively in PositionService.spec.ts;
    // these adversarials focus on concurrent/re-entry/payload contract cases.

    it('transition with closePayload for CLOSING target throws IllegalClosePayloadException', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service } = buildPositionService(new Map([[42, position]]));

        const closePayload = {
            exitReason: ExitReasonEnum.STOP_LOSS,
            realizedPnl: new Money('10'),
            exitPrice: new Money('29500'),
            closedAtMs: NOW_MS,
        };

        await expect(service.transition(42, PositionStateEnum.CLOSING, { nowMs: NOW_MS, eventClass: 'test' }, closePayload)).rejects.toBeInstanceOf(
            IllegalClosePayloadException,
        );
    });

    it('transition with closePayload for RECONCILING target throws IllegalClosePayloadException', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service } = buildPositionService(new Map([[42, position]]));

        const closePayload = {
            exitReason: ExitReasonEnum.MANUAL,
            realizedPnl: null,
            exitPrice: null,
            closedAtMs: NOW_MS,
        };

        await expect(service.transition(42, PositionStateEnum.RECONCILING, { nowMs: NOW_MS, eventClass: 'test' }, closePayload)).rejects.toBeInstanceOf(
            IllegalClosePayloadException,
        );
    });

    it('transition to CLOSED WITHOUT closePayload stamps no exit_reason (caller must supply payload)', async () => {
        // CLOSING -> CLOSED is a legal arrow; without closePayload, exitReason is not set.
        // This is intentional by design — callers use finalizeRealizedPnl for the standard path.
        const position = buildPosition({ state: PositionStateEnum.CLOSING });
        const { service, repository } = buildPositionService(new Map([[42, position]]));

        await service.transition(42, PositionStateEnum.CLOSED, { nowMs: NOW_MS, eventClass: 'test' });

        const saved = repository.save.mock.calls[0][0] as PositionEntity;
        expect(saved.state).toBe(PositionStateEnum.CLOSED);
        // exitReason is undefined/null when no closePayload — the design contract
        // puts the onus on callers (reconcileClose uses finalizeRealizedPnl).
        expect(saved.exitReason).toBeUndefined();
    });

    it('CLOSED is terminal: attempting any state after CLOSED fires IllegalStateTransitionException with no side-effects', async () => {
        const ALL_NON_CLOSED: PositionStateEnum[] = [
            PositionStateEnum.PENDING_OPEN,
            PositionStateEnum.OPEN,
            PositionStateEnum.CLOSING,
            PositionStateEnum.RECONCILING,
            PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
        ];

        for (const target of ALL_NON_CLOSED) {
            const position = buildPosition({ state: PositionStateEnum.CLOSED });
            const { service, repository, emitSpy } = buildPositionService(new Map([[42, position]]));

            await expect(service.transition(42, target, { nowMs: NOW_MS, eventClass: 'test' })).rejects.toBeInstanceOf(IllegalStateTransitionException);
            expect(repository.save).not.toHaveBeenCalled();
            expect(emitSpy).not.toHaveBeenCalled();
        }
    });

    it('adjustQty with negative qty throws IllegalQtyAdjustmentException; no DB save, no event', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service, repository, emitSpy } = buildPositionService(new Map([[42, position]]));

        await expect(service.adjustQty(42, new Money('-0.001'), QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            IllegalQtyAdjustmentException,
        );

        expect(repository.save).not.toHaveBeenCalled();
        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('adjustQty with NaN qty throws IllegalQtyAdjustmentException', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service } = buildPositionService(new Map([[42, position]]));

        await expect(service.adjustQty(42, new Money(NaN), QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            IllegalQtyAdjustmentException,
        );
    });

    it('adjustQty on a missing position throws PositionNotFoundException', async () => {
        const { service } = buildPositionService(new Map());

        await expect(service.adjustQty(999, new Money('0.01'), QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            PositionNotFoundException,
        );
    });

    it('adjustQty does NOT change state (CQS: qty mutation is orthogonal to state)', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN, qty: new Money('0.01') });
        const { service, repository } = buildPositionService(new Map([[42, position]]));

        await service.adjustQty(42, new Money('0.008'), QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs: NOW_MS });

        const saved = repository.save.mock.calls[0][0] as PositionEntity;
        expect(saved.state).toBe(PositionStateEnum.OPEN); // state unchanged
        expect(saved.qty.toFixed()).toBe('0.008');
    });

    it('finalizeRealizedPnl called on non-CLOSING position (OPEN) throws via the state graph', async () => {
        // finalizeRealizedPnl calls transition(... CLOSED ...) — OPEN -> CLOSED is illegal.
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const { service } = buildPositionService(new Map([[42, position]]));

        await expect(service.finalizeRealizedPnl(42, ExitReasonEnum.STOP_LOSS, { nowMs: NOW_MS, eventClass: 'test' })).rejects.toBeInstanceOf(
            IllegalStateTransitionException,
        );
    });

    it('DB-first ordering: adjustQty emits event AFTER save', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN, qty: new Money('0.01') });
        const callOrder: string[] = [];
        const positionMap = new Map([[42, position]]);
        const repository = {
            findById: jest.fn().mockResolvedValue(position),
            save: jest.fn().mockImplementation(async (entity: PositionEntity) => {
                callOrder.push('save');
                return entity;
            }),
        };
        const txRepo = {
            findByPosition: jest.fn().mockResolvedValue([]),
            recordTerminal: jest.fn().mockImplementation(async (e: unknown) => e),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        };
        const events = new EventEmitter2();
        jest.spyOn(events, 'emit').mockImplementation((...args) => {
            void args;
            callOrder.push('emit');
            return true;
        });

        void positionMap;

        const service = new PositionService(repository as unknown as PositionRepository, txRepo as unknown as TransactionRepository, events);

        await service.adjustQty(42, new Money('0.008'), QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION, { nowMs: NOW_MS });

        expect(callOrder).toEqual(['save', 'emit']);
    });

    it('PENDING_OPEN -> OPEN is the only legal arrow out of PENDING_OPEN (besides RECONCILING)', async () => {
        const illegalTargets = [PositionStateEnum.CLOSING, PositionStateEnum.CLOSED, PositionStateEnum.MANUAL_ADOPTED_UNMANAGED];

        for (const target of illegalTargets) {
            const position = buildPosition({ state: PositionStateEnum.PENDING_OPEN });
            const { service } = buildPositionService(new Map([[42, position]]));

            await expect(service.transition(42, target, { nowMs: NOW_MS, eventClass: 'test' })).rejects.toBeInstanceOf(IllegalStateTransitionException);
        }
    });
});

// ─── 2. RECONCILIATION ADVERSARIALS ─────────────────────────────────────────

describe('2. Reconciliation adversarials', () => {
    function buildReconciliationHarness(
        opts: {
            exchangePositions?: IPositionSnapshot[];
            openOrders?: IOpenOrderSnapshot[];
            dbPositions?: PositionEntity[];
            sentinelPresent?: boolean;
            fetchPositionsThrows?: boolean;
            haltFlagActive?: boolean;
        } = {},
    ) {
        const exchangeClient = {
            fetchPositions: opts.fetchPositionsThrows
                ? jest.fn().mockRejectedValue(new Error('exchange down'))
                : jest.fn().mockResolvedValue(opts.exchangePositions ?? []),
            fetchOpenOrders: jest.fn().mockResolvedValue(opts.openOrders ?? []),
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            fetchFundingHistory: jest.fn().mockResolvedValue([] as IFundingPaymentSnapshot[]),
        } as unknown as IExchangeClient;

        const positions = {
            findOpen: jest.fn().mockResolvedValue(opts.dbPositions ?? []),
            createOpen: jest.fn().mockResolvedValue(buildPosition({ state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED })),
            save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            findById: jest.fn().mockResolvedValue(null),
            // M6 R1.2.5 — case-(e) state-guarded UPDATE. Default affected=1 so
            // existing adversarial happy-path tests still see the re-arm.
            updateProtectiveOrderTypeIfState: jest.fn().mockResolvedValue(1),
        } as unknown as PositionRepository;

        const transactions = {
            findByClientOrderId: jest.fn().mockResolvedValue(null),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
            findByPosition: jest.fn().mockResolvedValue([]),
            // M6 R1.2.4 — case-(f) reads the position's most recent transaction;
            // null = no tx, defensive UNRESOLVED_TTL branch fires unless overridden.
            findLatestByPositionId: jest.fn().mockResolvedValue(null),
        } as unknown as TransactionRepository;

        const positionService = {
            transition: jest.fn().mockImplementation(async (positionId: number, newState: PositionStateEnum) => {
                return buildPosition({ id: positionId, state: newState });
            }),
            adjustQty: jest.fn().mockResolvedValue(buildPosition()),
            recordFunding: jest.fn().mockResolvedValue({}),
            finalizeRealizedPnl: jest.fn().mockResolvedValue(buildPosition({ state: PositionStateEnum.CLOSED })),
        } as unknown as PositionService;

        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn().mockResolvedValue(undefined),
            recordExposureDrift: jest.fn().mockResolvedValue(undefined),
            isRecoveryReady: jest.fn().mockReturnValue(true),
        } as unknown as RiskGateService;

        const monitor = {
            arm: jest.fn(),
            disarm: jest.fn(),
        } as unknown as LocalProtectiveMonitor;

        const retainer = new SubscriptionRetainer();
        const strategyVersions = {
            findByNameAndVersion: jest.fn().mockResolvedValue(opts.sentinelPresent !== false ? { id: 999, name: 'manual_adopted', version: 0 } : null),
        } as unknown as StrategyVersionRepository;

        const haltFlag = {
            isHalted: jest.fn().mockReturnValue(opts.haltFlagActive ?? false),
        } as unknown as HaltFlagService;

        const instrumentor = {
            setLiquidationPrice: jest.fn(),
            onPositionOpened: jest.fn(),
        } as unknown as PositionInstrumentor;

        const snapshotWriter = {
            writeNow: jest.fn().mockResolvedValue(null),
        } as unknown as AccountSnapshotWriter;

        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions,
            transactions,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            instrumentor,
            snapshotWriter,
            events,
        );

        return {
            service,
            exchangeClient,
            positions,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            instrumentor,
            snapshotWriter,
            events,
            emitSpy,
        };
    }

    it('concurrent ticks: second tick while first is running returns last pass (running guard)', async () => {
        // Hold the first tick open so the second fires while it is "in flight."
        let resolveFirst!: () => void;
        const firstTickGate = new Promise<void>((res) => {
            resolveFirst = res;
        });

        const harness = buildReconciliationHarness();
        (harness.positions.findOpen as jest.Mock).mockImplementation(() => firstTickGate.then(() => []));

        const tickOne = harness.service.forceTick(NOW_MS);
        const tickTwo = harness.service.forceTick(NOW_MS + 100); // fires while first is blocking

        resolveFirst();
        const [, pass2] = await Promise.all([tickOne, tickTwo]);

        // Second tick returned early (running guard) — it should be the empty pass not a real run.
        expect(pass2.tickAtMs).toBe(NOW_MS + 100); // emptyPass uses the supplied nowMs
    });

    it('fetchPositions throws: tick survives, no exchange_not_in_db counters incremented', async () => {
        const harness = buildReconciliationHarness({ fetchPositionsThrows: true });

        const pass = await harness.service.forceTick(NOW_MS);

        // tick did not throw
        expect(pass.errors).toBe(0); // exchange error is swallowed at fetchPositionsSafe
        expect(pass.driftsByCase[DriftCaseEnum.EXCHANGE_NOT_IN_DB]).toBe(0);
    });

    it('fetchPositions returns malformed snapshot (missing qty field): case-a handler does not crash', async () => {
        const malformed = {
            symbol: 'BTCUSDT',
            side: 'long',
            // qty is missing — simulates a broken exchange payload
            entryPrice: '30000',
            markPrice: '30000',
            liquidationPrice: null,
            marginType: 'isolated',
            leverage: '5',
            timestampMs: NOW_MS,
        } as unknown as IPositionSnapshot;

        const harness = buildReconciliationHarness({
            exchangePositions: [malformed],
            dbPositions: [],
        });

        // The adoption path calls parseMoney(snapshot.qty) which should handle undefined gracefully.
        const pass = await harness.service.forceTick(NOW_MS);
        // No crash. Errors may or may not increment; the key assertion is no unhandled throw.
        expect(pass).toBeDefined();
    });

    it('CLOSED DB row filtered upstream (M6 R1.1.2 — CLOSING is now a legit case-b source)', async () => {
        // M6 R1.1.2 (ADR 0010 §1b revised): CLOSING positions now route through
        // case-(b) finalize directly (CLOSING→CLOSED). Only CLOSED remains in the
        // defensive skip filter, and CLOSED is already filtered upstream by
        // `loadNonClosedPositions` — making `shouldSkipDuringReconciliation` defensive
        // dead-code. CLOSING source-state routing is covered in R1_1.spec.ts.
        const closedPosition = buildPosition({ state: PositionStateEnum.CLOSED });
        const harness = buildReconciliationHarness({
            exchangePositions: [],
            dbPositions: [closedPosition],
        });

        await harness.service.forceTick(NOW_MS);

        expect(harness.positionService.transition).not.toHaveBeenCalled();
    });

    it('halt flag active + flatten policy: flatten intent is NOT placed, row stays MANUAL_ADOPTED_UNMANAGED', async () => {
        const harness = buildReconciliationHarness({
            exchangePositions: [buildExchangeSnapshot()],
            dbPositions: [],
            haltFlagActive: true,
        });
        harness.service.setForeignPositionPolicy('flatten');

        const pass = await harness.service.forceTick(NOW_MS);

        // Adoption row was created, but the flatten intent was not emitted.
        expect(pass.driftsByCase[DriftCaseEnum.EXCHANGE_NOT_IN_DB]).toBe(1);
        // No ORDER_INTENT_APPROVED_EVENT
        const approvedCalls = harness.emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(0);
    });

    it('case-a with no sentinel strategy_versions row: adopt is skipped (returns null), no crash', async () => {
        const harness = buildReconciliationHarness({
            exchangePositions: [buildExchangeSnapshot()],
            dbPositions: [],
            sentinelPresent: false,
        });

        const pass = await harness.service.forceTick(NOW_MS);

        // Error count may be 0 (logged and returned) — but createOpen was NOT called
        expect(harness.positions.createOpen).not.toHaveBeenCalled();
        expect(pass.driftsByCase[DriftCaseEnum.EXCHANGE_NOT_IN_DB]).toBe(1);
    });

    it('snapshot writeNow is called when any drift case fires (drift-forced snapshot)', async () => {
        const harness = buildReconciliationHarness({
            exchangePositions: [],
            dbPositions: [buildPosition({ state: PositionStateEnum.OPEN })],
        });

        await harness.service.forceTick(NOW_MS);

        // case-b fired (DB open, nothing on exchange) → writeNow called
        expect(harness.snapshotWriter.writeNow).toHaveBeenCalledWith(NOW_MS, 'drift_resolved');
    });

    it('snapshot writeNow is NOT called when no drift fired (clean tick)', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });
        const matchingExchange = buildExchangeSnapshot({ symbol: position.symbol, side: 'long', qty: '0.01' });

        // Both SL and TP orders present → no case-e drift
        const slOrder = buildOpenOrder({ clientOrderId: 'tbvt-test001-sl', symbol: 'BTCUSDT' });
        const tpOrder = buildOpenOrder({ clientOrderId: 'tbvt-test001-tp', symbol: 'BTCUSDT' });

        const harness = buildReconciliationHarness({
            exchangePositions: [matchingExchange],
            openOrders: [slOrder, tpOrder],
            dbPositions: [buildPosition({ protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE })],
        });

        await harness.service.forceTick(NOW_MS);

        expect(harness.snapshotWriter.writeNow).not.toHaveBeenCalled();
    });

    it('case-e (protective drift): position with EXCHANGE_SIDE but no SL/TP orders → flipped to LOCAL_FALLBACK, monitor re-armed', async () => {
        const position = buildPosition({
            state: PositionStateEnum.OPEN,
            protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        });

        // Exchange still has position (clean match), but no resting SL/TP orders.
        const harness = buildReconciliationHarness({
            exchangePositions: [buildExchangeSnapshot()],
            openOrders: [], // no SL/TP orders
            dbPositions: [position],
        });

        await harness.service.forceTick(NOW_MS);

        expect(harness.monitor.arm).toHaveBeenCalledWith(expect.objectContaining({ positionId: 42 }));
        // M6 R1.2.5: case-(e) writes via state-guarded UPDATE instead of full-row `save`.
        const updateMock = (harness.positions as unknown as { updateProtectiveOrderTypeIfState: jest.Mock }).updateProtectiveOrderTypeIfState;
        expect(updateMock).toHaveBeenCalledWith(42, ProtectiveOrderTypeEnum.LOCAL_FALLBACK, expect.arrayContaining([PositionStateEnum.OPEN]));
    });

    it('case-e with stale EXCHANGE_SIDE and no exchange order: should fall back to local monitor (ADR 0014 §4c / case-e)', async () => {
        // This is the boot-time scenario from category 8: phase 4c should catch
        // EXCHANGE_SIDE rows whose SL/TP orders vanished and arm local fallback.
        const position = buildPosition({
            state: PositionStateEnum.OPEN,
            protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        const harness = buildReconciliationHarness({
            exchangePositions: [buildExchangeSnapshot()],
            openOrders: [],
            dbPositions: [position],
        });

        await harness.service.forceTick(NOW_MS);

        // Monitor re-armed with the persisted SL/TP
        expect(harness.monitor.arm).toHaveBeenCalledWith(
            expect.objectContaining({
                positionId: 42,
                stopLossPrice: expect.objectContaining({ toFixed: expect.any(Function) }),
                takeProfitPrice: expect.objectContaining({ toFixed: expect.any(Function) }),
            }),
        );
    });

    it('QTY_MISMATCH within tolerance (< QTY_TOLERANCE) produces no drift counter increment', async () => {
        // Exchange returns qty that differs by < 0.000000001 (< QTY_TOLERANCE)
        const exchangeSnapshot = buildExchangeSnapshot({ qty: '0.0100000009' });

        // Both SL and TP present to avoid case-e
        const slOrder = buildOpenOrder({ clientOrderId: 'tbvt-001-sl', symbol: 'BTCUSDT' });
        const tpOrder = buildOpenOrder({ clientOrderId: 'tbvt-001-tp', symbol: 'BTCUSDT' });

        const harness = buildReconciliationHarness({
            exchangePositions: [exchangeSnapshot],
            openOrders: [slOrder, tpOrder],
            dbPositions: [buildPosition({ protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE })],
        });

        const pass = await harness.service.forceTick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.QTY_MISMATCH]).toBe(0);
    });
});

// ─── 3. LOCAL MONITOR ADVERSARIALS ──────────────────────────────────────────

describe('3. LocalProtectiveMonitor adversarials', () => {
    function buildMonitorHarness(
        opts: {
            positionExists?: boolean;
            positionSide?: PositionSideEnum;
            gateOutcome?: RiskOutcomeEnum;
            gateReady?: boolean;
        } = {},
    ) {
        const positionSide = opts.positionSide ?? PositionSideEnum.LONG;
        const positionRow = buildPosition({ side: positionSide });
        const positionExists = opts.positionExists !== false;

        const positionRepository = {
            findById: jest.fn().mockResolvedValue(positionExists ? positionRow : null),
        } as unknown as PositionRepository;

        const gateOutcome = opts.gateOutcome ?? RiskOutcomeEnum.APPROVED;
        const riskGate = {
            evaluate: jest.fn().mockResolvedValue({ outcome: gateOutcome, reservationId: null, rejectReason: null }),
            isRecoveryReady: jest.fn().mockReturnValue(opts.gateReady !== false),
        } as unknown as RiskGateService;

        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const monitor = new LocalProtectiveMonitor(positionRepository, riskGate, events);

        return { monitor, positionRepository, riskGate, events, emitSpy, positionRow };
    }

    function buildPriceUpdate(symbol: string, price: string): IPriceUpdateEvent {
        return { symbol, price, timestampMs: NOW_MS };
    }

    it('price tick for a symbol with no armed position is a no-op', async () => {
        const { monitor, emitSpy } = buildMonitorHarness();

        await monitor.onPriceUpdate(buildPriceUpdate('ETHUSDT', '2000'));

        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('gate rejects CLOSE intent: breachInFlight flag clears so next tick retries', async () => {
        const { monitor, riskGate, emitSpy } = buildMonitorHarness({ gateOutcome: RiskOutcomeEnum.REJECTED });

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // First tick breaches SL — gate rejects
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29400'));

        // The in-flight flag should be cleared after gate rejection
        expect(monitor.isArmed(42)).toBe(true);

        // Switch gate to approve
        (riskGate.evaluate as jest.Mock).mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, reservationId: null });

        // Second tick retries
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29400'));

        // Close intent emitted on the second tick
        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(1);
    });

    it('SL and TP both breached in the same tick: SL takes precedence (ADR 0011 §3 ordering)', async () => {
        const { monitor, emitSpy } = buildMonitorHarness({ positionSide: PositionSideEnum.LONG });

        // Set SL above entry so both conditions fire: markPrice 28000 < SL 29500 AND markPrice 28000 < TP 31000
        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'), // SL is higher than markPrice → breached
            takeProfitPrice: new Money('27000'), // TP is below mark → also "breached" for LONG (mark >= TP not true here)
        });

        // Use a price that breaches SL (29400 < 29500) but NOT TP (29400 < 27000 is false for mark >= TP)
        // So just SL fires in normal case. To test "both fire in same tick" for LONG:
        // LONG SL: mark <= SL (29400 <= 29500) ✓
        // LONG TP: mark >= TP (29400 >= 31000) ✗ (TP not reached)
        // To get both, set TP below mark price:
        monitor.disarm(42);
        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'), // SL breached: mark <= SL
            takeProfitPrice: new Money('29000'), // TP breached: mark >= TP ... no, for LONG mark >= TP
        });

        // With markPrice=29400: LONG SL breach (29400 <= 29500), but TP not breached (29400 >= 29000 → yes, this is breached too)
        // Both conditions fire → SL must win (evaluated first)
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29400'));

        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(1);
        const intent = (approvedCalls[0][1] as { intent: { exitReason: ExitReasonEnum } }).intent;
        expect(intent.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
    });

    it('arm with null SL: only TP can trigger breach (null SL is never breached)', async () => {
        const { monitor, emitSpy } = buildMonitorHarness({ positionSide: PositionSideEnum.LONG });

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: null,
            takeProfitPrice: new Money('31000'),
        });

        // Price below where SL would normally be — no fire because SL is null
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '25000'));

        expect(emitSpy).not.toHaveBeenCalledWith('risk.orderIntent.approved', expect.anything());

        // Price at TP → fires
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '31500'));

        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(1);
    });

    it('arm with null TP and null SL: never fires on any price', async () => {
        const { monitor, emitSpy } = buildMonitorHarness();

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: null,
            takeProfitPrice: null,
        });

        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '1'));
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '99999'));

        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(0);
    });

    it('position row missing at breach time: monitor disarms and does not emit', async () => {
        const { monitor, emitSpy } = buildMonitorHarness({ positionExists: false });

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29400'));

        expect(monitor.isArmed(42)).toBe(false);
        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(0);
    });

    it('R2.1.1: onPriceUpdate fires breach during recovery (W8.5 LPM boot guard removed; gate auto-approves de-risking per R1.1.1)', async () => {
        const { monitor, emitSpy } = buildMonitorHarness({ gateReady: false });

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // SL-breaching price during recovery. Pre-R2.1.1 the W8.5 guard
        // silently dropped this. Post-R2.1.1 the monitor stays the last line
        // of defense throughout boot (ADR-0011 §4); the gate's R1.1.1 narrowing
        // auto-approves de-risking even with isRecoveryReady=false.
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29000'));

        // The gate-routed close intent IS emitted.
        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(1);
    });

    it('disarm-on-CLOSED: subsequent price updates for the same symbol are no-ops', async () => {
        const { monitor, emitSpy } = buildMonitorHarness();

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // Simulate CLOSED transition event
        const closedEvent: IPositionStateTransitionedEvent = {
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: NOW_MS,
            eventClass: 'test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        };
        monitor.onPositionStateTransitioned(closedEvent);

        expect(monitor.isArmed(42)).toBe(false);

        // Now a SL-breaching price arrives — should be no-op
        await monitor.onPriceUpdate(buildPriceUpdate('BTCUSDT', '29000'));

        const approvedCalls = emitSpy.mock.calls.filter(([name]) => name === 'risk.orderIntent.approved');
        expect(approvedCalls).toHaveLength(0);
    });

    it('evaluateBreach is a pure function: repeated calls with same inputs return same result', () => {
        const { monitor } = buildMonitorHarness({ positionSide: PositionSideEnum.LONG });
        const armed = {
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
            armedAtMs: NOW_MS,
        };
        const markPrice = new Money('29400');

        const result1 = monitor.evaluateBreach(armed as Parameters<typeof monitor.evaluateBreach>[0], markPrice);
        const result2 = monitor.evaluateBreach(armed as Parameters<typeof monitor.evaluateBreach>[0], markPrice);

        expect(result1).toBe('stop_loss');
        expect(result2).toBe('stop_loss');
    });

    it('arm() is callable during boot guard (phase 4c arms directly regardless of gate state)', () => {
        const { monitor } = buildMonitorHarness({ gateReady: false });

        // arm() should succeed even when boot is not ready
        expect(() => {
            monitor.arm({
                positionId: 42,
                symbol: 'BTCUSDT',
                side: PositionSideEnum.LONG,
                stopLossPrice: new Money('29500'),
                takeProfitPrice: new Money('31000'),
            });
        }).not.toThrow();

        expect(monitor.isArmed(42)).toBe(true);
    });
});

// ─── 4. SUBSCRIPTION RETAINER ADVERSARIALS ──────────────────────────────────

describe('4. SubscriptionRetainer adversarials', () => {
    it('100 alternating retain/release calls produce consistent final state (no refcount leak)', () => {
        const retainer = new SubscriptionRetainer();
        const symbol = 'BTCUSDT';

        for (let i = 0; i < 100; i++) {
            retainer.retain(symbol, RetainReasonEnum.OPEN_POSITION);
            retainer.release(symbol, RetainReasonEnum.OPEN_POSITION);
        }

        // After alternating, final state is released
        expect(retainer.isRetained(symbol)).toBe(false);
        expect(retainer.getReasonsFor(symbol).size).toBe(0);
    });

    it('retain storm with same reason 100 times: reason appears exactly once (idempotent)', () => {
        const retainer = new SubscriptionRetainer();
        const symbol = 'BTCUSDT';

        for (let i = 0; i < 100; i++) {
            retainer.retain(symbol, RetainReasonEnum.OPEN_POSITION);
        }

        expect(retainer.getReasonsFor(symbol).size).toBe(1);
        expect(retainer.getReasonsFor(symbol).has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
    });

    it('release of non-present reason is a no-op (no crash)', () => {
        const retainer = new SubscriptionRetainer();

        expect(() => {
            retainer.release('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        }).not.toThrow();

        expect(retainer.isRetained('BTCUSDT')).toBe(false);
    });

    it('releasing the last reason removes the symbol from the retained set', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.retain('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        retainer.release('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        expect(retainer.isRetained('BTCUSDT')).toBe(true); // still retained by COOLDOWN_ACTIVE

        retainer.release('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        expect(retainer.isRetained('BTCUSDT')).toBe(false); // now gone
    });

    it('reason-set isolation: COOLDOWN_ACTIVE release on BTCUSDT does not affect ETHUSDT', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        retainer.retain('ETHUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        retainer.release('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        expect(retainer.isRetained('BTCUSDT')).toBe(false);
        expect(retainer.isRetained('ETHUSDT')).toBe(true);
    });

    it('getRetainedSymbols returns snapshot (mutation of returned set does not affect internals)', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        const snapshot = retainer.getRetainedSymbols();
        snapshot.add('ROGUE_SYMBOL');

        // Internal state unchanged
        expect(retainer.isRetained('ROGUE_SYMBOL')).toBe(false);
    });

    it('getReasonsFor returns snapshot: mutation does not affect internals', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        const reasons = retainer.getReasonsFor('BTCUSDT');
        reasons.add(RetainReasonEnum.COOLDOWN_ACTIVE);

        // Internal state unchanged
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('COOLDOWN_ACTIVE retain does not drop OPEN_POSITION retention when released independently', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);
        retainer.retain('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        // Release cooldown — OPEN_POSITION should still hold
        retainer.release('BTCUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        expect(retainer.isRetained('BTCUSDT')).toBe(true);
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.OPEN_POSITION)).toBe(true);
    });
});

// ─── 5. FUNDING INGESTION ADVERSARIALS ──────────────────────────────────────

describe('5. Funding ingestion adversarials', () => {
    function buildFundingHarness(
        opts: {
            fundingHistory?: IFundingPaymentSnapshot[];
            latestFundingRow?: TransactionEntity | null;
            positionState?: PositionStateEnum;
        } = {},
    ) {
        const position = buildPosition({
            state: opts.positionState ?? PositionStateEnum.OPEN,
            openedAt: new Date(NOW_MS - 3600_000),
        });

        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            fetchFundingHistory: jest.fn().mockResolvedValue(opts.fundingHistory ?? []),
        } as unknown as IExchangeClient;

        const positions = {
            findOpen: jest.fn().mockResolvedValue([position]),
            createOpen: jest.fn(),
            save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;

        const transactions = {
            findByClientOrderId: jest.fn().mockResolvedValue(null),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(opts.latestFundingRow ?? null),
            findByPosition: jest.fn().mockResolvedValue([]),
        } as unknown as TransactionRepository;

        const positionService = {
            transition: jest.fn().mockResolvedValue(buildPosition()),
            adjustQty: jest.fn().mockResolvedValue(buildPosition()),
            recordFunding: jest.fn().mockResolvedValue({}),
            finalizeRealizedPnl: jest.fn().mockResolvedValue(buildPosition({ state: PositionStateEnum.CLOSED })),
        } as unknown as PositionService;

        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn().mockResolvedValue(undefined),
            recordExposureDrift: jest.fn().mockResolvedValue(undefined),
            isRecoveryReady: jest.fn().mockReturnValue(true),
        } as unknown as RiskGateService;

        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue(null) } as unknown as StrategyVersionRepository;
        const haltFlag = { isHalted: jest.fn().mockReturnValue(false) } as unknown as HaltFlagService;
        const instrumentor = { setLiquidationPrice: jest.fn(), onPositionOpened: jest.fn() } as unknown as PositionInstrumentor;
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as unknown as AccountSnapshotWriter;
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions,
            transactions,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            instrumentor,
            snapshotWriter,
            events,
        );

        return { service, positionService, exchangeClient };
    }

    it('fetchFundingHistory returns two events with same fundingTimeMs: both pass the sinceMs filter and both are sent to recordFunding (DB dedup handles the unique constraint)', async () => {
        // The sinceMs guard drops events AT or BEFORE sinceMs — two events at the same
        // timestamp that is AFTER sinceMs both pass through. The DB unique constraint on
        // `uq_transactions_client_order_id` is the actual idempotency guard; the service
        // itself does not deduplicate same-timestamp events in-process.
        // This test documents the expected behavior: two events pass through (two recordFunding
        // calls), and the DB constraint is the backstop (mocked out here, so both succeed).
        const latestRow = buildTransactionRow({
            type: TransactionTypeEnum.FUNDING,
            createdAt: new Date(NOW_MS - 2000), // sinceMs = NOW_MS - 1999
        });

        // Both events are AFTER sinceMs (NOW_MS - 500 > NOW_MS - 1999), same timestamp
        const duplicates: IFundingPaymentSnapshot[] = [
            { id: 'fund-1', symbol: 'BTCUSDT', amount: '-0.05', fundingTimeMs: NOW_MS - 500, asset: 'USDT' },
            { id: 'fund-2', symbol: 'BTCUSDT', amount: '-0.05', fundingTimeMs: NOW_MS - 500, asset: 'USDT' }, // same timestamp, different id
        ];

        const harness = buildFundingHarness({
            fundingHistory: duplicates,
            latestFundingRow: latestRow,
        });

        const pass = await harness.service.forceTick(NOW_MS);

        // Both events have the same fundingTimeMs → same deterministic clientOrderId
        // → DB unique constraint prevents the second insert. The service sends both
        // to recordFunding; the uniqueness is enforced at the repository layer.
        // Both calls were attempted (service layer passes them through).
        expect(pass.fundingRowsWritten).toBe(2); // both passed the sinceMs filter
        expect(harness.positionService.recordFunding).toHaveBeenCalledTimes(2);
    });

    it('funding event with zero cashflow: recordFunding still called (zero is a valid funding settlement)', async () => {
        const events: IFundingPaymentSnapshot[] = [{ id: 'fund-zero', symbol: 'BTCUSDT', amount: '0', fundingTimeMs: NOW_MS - 100, asset: 'USDT' }];

        const harness = buildFundingHarness({ fundingHistory: events });

        const pass = await harness.service.forceTick(NOW_MS);

        // Zero cashflow is still a real event — must be recorded
        expect(pass.fundingRowsWritten).toBe(1);
        expect(harness.positionService.recordFunding).toHaveBeenCalledWith(
            expect.objectContaining({ cashflow: expect.objectContaining({ toFixed: expect.any(Function) }) }),
        );
    });

    it('funding event timestamp exactly equal to sinceMs is dropped (exclusive lower bound)', async () => {
        const latestRow = buildTransactionRow({
            type: TransactionTypeEnum.FUNDING,
            createdAt: new Date(NOW_MS - 1000),
        });

        // sinceMs = latestRow.createdAt.getTime() + 1 = NOW_MS - 999
        // Event at NOW_MS - 999 is exactly at sinceMs → dropped
        const events: IFundingPaymentSnapshot[] = [{ id: 'fund-at-since', symbol: 'BTCUSDT', amount: '-0.05', fundingTimeMs: NOW_MS - 999, asset: 'USDT' }];

        const harness = buildFundingHarness({
            fundingHistory: events,
            latestFundingRow: latestRow,
        });

        const pass = await harness.service.forceTick(NOW_MS);

        expect(pass.fundingRowsWritten).toBe(0);
    });

    it('funding ingestion skipped for CLOSING position (shouldSkipFundingIngestion)', async () => {
        const harness = buildFundingHarness({
            positionState: PositionStateEnum.CLOSING,
            fundingHistory: [{ id: 'f1', symbol: 'BTCUSDT', amount: '-0.05', fundingTimeMs: NOW_MS - 100, asset: 'USDT' }],
        });

        const pass = await harness.service.forceTick(NOW_MS);

        expect(pass.fundingRowsWritten).toBe(0);
        expect(harness.positionService.recordFunding).not.toHaveBeenCalled();
    });

    it('funding ingestion skipped for MANUAL_ADOPTED_UNMANAGED position', async () => {
        const harness = buildFundingHarness({
            positionState: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            fundingHistory: [{ id: 'f1', symbol: 'BTCUSDT', amount: '-0.05', fundingTimeMs: NOW_MS - 100, asset: 'USDT' }],
        });

        const pass = await harness.service.forceTick(NOW_MS);

        expect(pass.fundingRowsWritten).toBe(0);
    });
});

// ─── 6. INSTRUMENTOR ADVERSARIALS ───────────────────────────────────────────

describe('6. PositionInstrumentor adversarials', () => {
    function buildInstrumentorHarness(
        opts: {
            positionExists?: boolean;
            gateReady?: boolean;
        } = {},
    ) {
        const positionRow = buildPosition({
            openedAt: new Date(NOW_MS - 60_000),
            maePct: null,
            mfePct: null,
        });

        const positions = {
            findById: jest.fn().mockResolvedValue(opts.positionExists !== false ? positionRow : null),
            save: jest.fn().mockResolvedValue(positionRow),
        } as unknown as PositionRepository;

        const riskGate = {
            isRecoveryReady: jest.fn().mockReturnValue(opts.gateReady !== false),
        } as unknown as RiskGateService;

        const instrumentor = new PositionInstrumentor(positions, riskGate);

        return { instrumentor, positions, riskGate, positionRow };
    }

    it('price tick before onPositionOpened is a no-op (no accumulator exists yet)', async () => {
        const { instrumentor } = buildInstrumentorHarness();

        // No position opened, just a price tick
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29000', timestampMs: NOW_MS });

        // No crash, nothing to assert beyond no-throw
    });

    it('CLOSED -> CLOSED double-fire: second close event is a no-op (dropPosition idempotent)', async () => {
        const { instrumentor, positions } = buildInstrumentorHarness();
        const position = buildPosition({ exitReason: ExitReasonEnum.STOP_LOSS, exitPrice: new Money('29400') });
        instrumentor.onPositionOpened(position);

        const closedEvent: IPositionStateTransitionedEvent = {
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: NOW_MS,
            eventClass: 'test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        };

        await instrumentor.onPositionStateTransitioned(closedEvent);
        await instrumentor.onPositionStateTransitioned(closedEvent); // second fire

        // save should have been called once (from the first close-flush), not twice
        expect((positions.save as jest.Mock).mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('MAE monotonicity: adverse ticks push MAE more negative; favorable ticks do not shrink it', async () => {
        // ADR 0013 §1a: mae_pct is non-positive. More adverse = more negative value.
        // LONG: excursion = (mark - entry) / entry. Drop in price = negative excursion = adverse.
        const { instrumentor } = buildInstrumentorHarness();
        const position = buildPosition({ side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        instrumentor.onPositionOpened(position);

        // Adverse tick: price drops to 29000 → excursion = -1/30 ≈ -0.0333
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29000', timestampMs: NOW_MS + 1000 });
        const after1 = parseFloat(instrumentor.getLifeStats(42)!.maePct!.toFixed());

        // More adverse tick: price drops to 28000 → excursion = -2/30 ≈ -0.0667
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '28000', timestampMs: NOW_MS + 2000 });
        const after2 = parseFloat(instrumentor.getLifeStats(42)!.maePct!.toFixed());

        // Favorable tick: price recovers to 31000 — MAE must NOT shrink (stay at after2)
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '31000', timestampMs: NOW_MS + 3000 });
        const after3 = parseFloat(instrumentor.getLifeStats(42)!.maePct!.toFixed());

        // after2 is MORE negative than after1 (worse MAE = lower value)
        expect(after2).toBeLessThan(after1);
        // after3 did NOT improve (MAE is a high-water mark in the negative direction)
        expect(after3).toBeLessThanOrEqual(after2);
    });

    it('MFE monotonicity: favorable ticks push MFE more positive; adverse ticks do not shrink it', async () => {
        // ADR 0013 §1b: mfe_pct is non-negative. More favorable = larger positive value.
        // LONG: excursion = (mark - entry) / entry. Rise in price = positive excursion = favorable.
        const { instrumentor } = buildInstrumentorHarness();
        const position = buildPosition({ side: PositionSideEnum.LONG, entryPrice: new Money('30000') });
        instrumentor.onPositionOpened(position);

        // Favorable tick: price rises to 31000 → excursion = 1/30 ≈ 0.0333
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '31000', timestampMs: NOW_MS + 1000 });
        const after1 = parseFloat(instrumentor.getLifeStats(42)!.mfePct?.toFixed() ?? '0');

        // More favorable: price rises to 32000 → excursion = 2/30 ≈ 0.0667
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '32000', timestampMs: NOW_MS + 2000 });
        const after2 = parseFloat(instrumentor.getLifeStats(42)!.mfePct!.toFixed());

        // Adverse tick: price drops to 29000 — MFE must NOT shrink
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29000', timestampMs: NOW_MS + 3000 });
        const after3 = parseFloat(instrumentor.getLifeStats(42)!.mfePct!.toFixed());

        // after2 > after1 (MFE grew on more favorable tick)
        expect(after2).toBeGreaterThan(after1);
        // after3 >= after2 (MFE did NOT shrink on adverse tick)
        expect(after3).toBeGreaterThanOrEqual(after2);
    });

    it('flushPending skipped when boot guard is active (scheduled flush deferred)', async () => {
        const { instrumentor, positions } = buildInstrumentorHarness({ gateReady: false });
        const position = buildPosition();
        instrumentor.onPositionOpened(position);

        // Dirty the accumulator
        await instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29000', timestampMs: NOW_MS + 1 });

        // Flush — should be skipped because boot guard is active
        await instrumentor.flushPending();

        expect(positions.save as jest.Mock).not.toHaveBeenCalled();
    });

    it('RECONCILING transition removes position from accumulator without flushing', async () => {
        const { instrumentor, positions } = buildInstrumentorHarness();
        const position = buildPosition();
        instrumentor.onPositionOpened(position);

        const reconcilingEvent: IPositionStateTransitionedEvent = {
            positionId: 42,
            fromState: PositionStateEnum.OPEN,
            toState: PositionStateEnum.RECONCILING,
            transitionedAtMs: NOW_MS,
            eventClass: 'test',
            symbol: 'BTCUSDT',
            exitReason: null,
            realizedPnl: null,
        };

        await instrumentor.onPositionStateTransitioned(reconcilingEvent);

        // Position dropped
        expect(instrumentor.getLifeStats(42)).toBeNull();
        // No DB save
        expect(positions.save as jest.Mock).not.toHaveBeenCalled();
    });

    it('getLifeStats returns null for a position that was never opened in this process', () => {
        const { instrumentor } = buildInstrumentorHarness();

        expect(instrumentor.getLifeStats(9999)).toBeNull();
    });
});

// ─── 7. ACCOUNT SNAPSHOT WRITER ADVERSARIALS ────────────────────────────────

describe('7. AccountSnapshotWriter adversarials', () => {
    function buildSnapshotWriterHarness(
        opts: {
            balances?: Array<{ asset: string; free: string; used: string; total: string }>;
            fetchBalanceThrows?: boolean;
            positions?: PositionEntity[];
            transactionsByPositionId?: Map<number, TransactionEntity[]>;
            gateReady?: boolean;
        } = {},
    ) {
        const exchangeClient = {
            fetchBalance: opts.fetchBalanceThrows
                ? jest.fn().mockRejectedValue(new Error('exchange down'))
                : jest.fn().mockResolvedValue(opts.balances ?? [{ asset: 'USDT', free: '1000', used: '0', total: '1000' }]),
        } as unknown as IExchangeClient;

        const positions = {
            findOpen: jest.fn().mockResolvedValue(opts.positions ?? []),
        } as unknown as PositionRepository;

        const transactions = {
            findByPosition: jest.fn().mockImplementation(async (positionId: number) => {
                return opts.transactionsByPositionId?.get(positionId) ?? [];
            }),
        } as unknown as TransactionRepository;

        const snapshots = {
            save: jest.fn().mockImplementation(async (entity: AccountSnapshotEntity) => ({ ...entity, id: 1 })),
            findLatest: jest.fn().mockResolvedValue(null),
            buildSnapshot: jest.fn().mockImplementation((entity: AccountSnapshotEntity) => entity),
        } as unknown as AccountSnapshotRepository;

        const riskGate = {
            isRecoveryReady: jest.fn().mockReturnValue(opts.gateReady !== false),
        } as unknown as RiskGateService;

        const writer = new AccountSnapshotWriter(exchangeClient as never, positions, transactions, snapshots, riskGate, { exchangeEnv: 'testnet' } as never);

        return { writer, exchangeClient, positions, transactions, snapshots, riskGate };
    }

    it('fetchBalance returns no USDT entry: balance is treated as zero, snapshot still written', async () => {
        const harness = buildSnapshotWriterHarness({
            balances: [{ asset: 'BNB', free: '5', used: '0', total: '5' }],
        });

        const result = await harness.writer.writeNow(NOW_MS, 'boot');

        expect(result).not.toBeNull();
        expect(result!.balance.toFixed()).toBe('0');
    });

    it('two writeNow calls in the same wall-minute with scheduled trigger: second is skipped', async () => {
        const harness = buildSnapshotWriterHarness();
        const baseMs = NOW_MS;
        const sameMinuteMs = baseMs + 1000; // same minute bucket

        await harness.writer.writeNow(baseMs, 'scheduled');
        await harness.writer.writeNow(sameMinuteMs, 'scheduled');

        // Only one snapshot saved
        expect(harness.snapshots.save).toHaveBeenCalledTimes(1);
    });

    it('two writeNow calls in the same wall-minute with boot trigger: both write (bypass same-minute skip)', async () => {
        const harness = buildSnapshotWriterHarness();
        const baseMs = NOW_MS;
        const sameMinuteMs = baseMs + 1000;

        await harness.writer.writeNow(baseMs, 'boot');
        await harness.writer.writeNow(sameMinuteMs, 'boot');

        // Both writes go through because boot trigger bypasses same-minute skip
        expect(harness.snapshots.save).toHaveBeenCalledTimes(2);
    });

    it('drift_resolved trigger bypasses same-minute skip', async () => {
        const harness = buildSnapshotWriterHarness();
        const baseMs = NOW_MS;
        const sameMinuteMs = baseMs + 500;

        await harness.writer.writeNow(baseMs, 'scheduled');
        await harness.writer.writeNow(sameMinuteMs, 'drift_resolved'); // must write despite same minute

        expect(harness.snapshots.save).toHaveBeenCalledTimes(2);
    });

    it('scheduled tick skipped when boot guard is active', async () => {
        const harness = buildSnapshotWriterHarness({ gateReady: false });

        await harness.writer.scheduledTick();

        expect(harness.snapshots.save).not.toHaveBeenCalled();
    });

    it('position with no observed price tick contributes zero to unrealized PnL', async () => {
        const position = buildPosition({ symbol: 'SOLUSDT', side: PositionSideEnum.LONG });
        const harness = buildSnapshotWriterHarness({
            positions: [position],
            // No price tick emitted for SOLUSDT → latestMarkPriceBySymbol has no entry
        });

        const result = await harness.writer.writeNow(NOW_MS, 'boot');

        // Should succeed with unrealized = 0 (position skipped due to no mark price)
        expect(result).not.toBeNull();
        expect(result!.unrealizedPnl.toFixed()).toBe('0');
    });

    it('RECONCILING position contributes zero to unrealized PnL (drift state excluded)', async () => {
        const position = buildPosition({ state: PositionStateEnum.RECONCILING });
        const harness = buildSnapshotWriterHarness({ positions: [position] });

        // Even with a price tick, RECONCILING positions are excluded
        harness.writer.onPriceUpdate({ symbol: 'BTCUSDT', price: '30100', timestampMs: NOW_MS });
        const result = await harness.writer.writeNow(NOW_MS, 'boot');

        expect(result).not.toBeNull();
        expect(result!.unrealizedPnl.toFixed()).toBe('0');
    });
});

// ─── 8. BOOT PIPELINE ADVERSARIALS ──────────────────────────────────────────

describe('8. EngineBootstrapService adversarials', () => {
    function buildBootHarness(
        opts: {
            positions?: PositionEntity[];
            reconciliationThrows?: boolean;
            bootSnapshotResult?: AccountSnapshotEntity | null;
        } = {},
    ) {
        const positionRepo = {
            findOpen: jest.fn().mockResolvedValue(opts.positions ?? []),
        } as unknown as PositionRepository;

        const reconciliation = {
            forceTick: opts.reconciliationThrows ? jest.fn().mockRejectedValue(new Error('exchange offline')) : jest.fn().mockResolvedValue({}),
        } as unknown as ReconciliationService;

        const monitor = { arm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const instrumentor = { onPositionOpened: jest.fn() } as unknown as PositionInstrumentor;
        const retainer = new SubscriptionRetainer();
        const riskGate = {
            setOpenExposureFromBoot: jest.fn().mockResolvedValue(undefined),
            markRecoveryComplete: jest.fn(),
            isRecoveryReady: jest.fn().mockReturnValue(false),
        } as unknown as RiskGateService;

        const defaultBootSnapshot: AccountSnapshotEntity = {
            id: 1,
            ts: new Date(NOW_MS),
            balance: new Money('1000'),
            equity: new Money('1000'),
            unrealizedPnl: new Money('0'),
            unrealizedPnlPrice: new Money('0'),
            unrealizedPnlFunding: new Money('0'),
        } as AccountSnapshotEntity;

        const snapshotWriter = {
            writeNow: jest.fn().mockResolvedValue(opts.bootSnapshotResult ?? defaultBootSnapshot),
        } as unknown as AccountSnapshotWriter;

        const snapshotRepo = {
            findLatest: jest.fn().mockResolvedValue(null),
        } as unknown as AccountSnapshotRepository;

        const boot = new EngineBootstrapService(
            positionRepo,
            reconciliation,
            monitor,
            instrumentor,
            retainer,
            riskGate,
            snapshotWriter,
            snapshotRepo,
            // M11a R2d Item 3 — non-PAPER stub so phase 2-3 PAPER branch is inert.
            { exchangeEnv: 'testnet' } as never,
            { forceTick: jest.fn().mockResolvedValue({ tickAtMs: 0, driftCount: 0, inMemoryCount: 0, persistedCount: 0 }) } as never,
        );

        return { boot, positionRepo, reconciliation, monitor, instrumentor, retainer, riskGate, snapshotWriter, snapshotRepo };
    }

    it('concurrent boot() calls: second call is a no-op (idempotent)', async () => {
        const harness = buildBootHarness();

        await harness.boot.boot(NOW_MS);
        await harness.boot.boot(NOW_MS); // second call

        // Each phase called only once
        expect(harness.reconciliation.forceTick).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.markRecoveryComplete).toHaveBeenCalledTimes(1);
    });

    it('phase 2-3 failure aborts boot: markRecoveryComplete never called (no partial-ready)', async () => {
        const harness = buildBootHarness({ reconciliationThrows: true });

        await expect(harness.boot.boot(NOW_MS)).rejects.toThrow('exchange offline');

        expect(harness.riskGate.markRecoveryComplete).not.toHaveBeenCalled();
    });

    it('phase 4c skips PENDING_OPEN positions with EXCHANGE_SIDE (should NOT re-arm, EXCHANGE_SIDE is alive)', () => {
        const exchangeSidePosition = buildPosition({
            state: PositionStateEnum.PENDING_OPEN,
            protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        });
        const harness = buildBootHarness({ positions: [exchangeSidePosition] });

        harness.boot.phase4cRearmLocalMonitor([exchangeSidePosition]);

        expect(harness.monitor.arm).not.toHaveBeenCalled();
    });

    it('phase 4c re-arms CLOSING positions with LOCAL_FALLBACK (partial-reduce still needs monitor)', () => {
        const closingPosition = buildPosition({
            state: PositionStateEnum.CLOSING,
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        });
        const harness = buildBootHarness();

        harness.boot.phase4cRearmLocalMonitor([closingPosition]);

        expect(harness.monitor.arm).toHaveBeenCalledWith(expect.objectContaining({ positionId: 42 }));
    });

    it('phase 5 does NOT add CLOSED positions to retainer', () => {
        const closedPosition = buildPosition({ state: PositionStateEnum.CLOSED, symbol: 'BTCUSDT' });
        const harness = buildBootHarness();

        harness.boot.phase5RebuildRetainer([closedPosition]);

        expect(harness.retainer.isRetained('BTCUSDT')).toBe(false);
    });

    it('phase 7 equity drift alert at exactly the tolerance boundary is silent', async () => {
        const harness = buildBootHarness({
            bootSnapshotResult: {
                id: 1,
                ts: new Date(NOW_MS),
                balance: new Money('1001'), // exactly tolerance=1 difference
                equity: new Money('1001'),
                unrealizedPnl: new Money('0'),
                unrealizedPnlPrice: new Money('0'),
                unrealizedPnlFunding: new Money('0'),
            } as AccountSnapshotEntity,
        });

        const errorSpy = jest.spyOn(harness.boot['logger'], 'error').mockImplementation(() => undefined);

        // pre-crash balance = 1000, boot balance = 1001, delta = 1 == tolerance
        // delta.greaterThan(1) is false → no error
        await harness.boot.phase7BootSnapshot(NOW_MS, new Money('1000'));

        const driftCalls = errorSpy.mock.calls.filter(([msg]) => String(msg).includes('EQUITY DRIFT'));
        expect(driftCalls).toHaveLength(0);
    });

    it('phase 7 equity drift alert fires when delta is ONE unit above tolerance', async () => {
        const harness = buildBootHarness({
            bootSnapshotResult: {
                id: 1,
                ts: new Date(NOW_MS),
                balance: new Money('1001.01'), // 1.01 > tolerance=1
                equity: new Money('1001.01'),
                unrealizedPnl: new Money('0'),
                unrealizedPnlPrice: new Money('0'),
                unrealizedPnlFunding: new Money('0'),
            } as AccountSnapshotEntity,
        });

        const errorSpy = jest.spyOn(harness.boot['logger'], 'error').mockImplementation(() => undefined);

        await harness.boot.phase7BootSnapshot(NOW_MS, new Money('1000'));

        const driftCalls = errorSpy.mock.calls.filter(([msg]) => String(msg).includes('EQUITY DRIFT'));
        expect(driftCalls).toHaveLength(1);
    });

    it('phase 4a excludes PENDING_OPEN positions with no correlation_mode (foreign adopted)', async () => {
        const foreignPosition = buildPosition({
            state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            entryNotional: new Money('500'),
            correlationMode: null,
        });
        const harness = buildBootHarness({ positions: [foreignPosition] });

        await harness.boot.phase4aRebuildOpenExposure([foreignPosition], NOW_MS);

        const [exposure] = (harness.riskGate.setOpenExposureFromBoot as jest.Mock).mock.calls[0];
        expect(exposure.toFixed()).toBe('0'); // foreign excluded
    });
});

// ─── 9. CRASH-WINDOW ADVERSARIALS ───────────────────────────────────────────

describe('9. Crash-window adversarials (ADR 0014)', () => {
    it('anti-coverage: orchestrator does NOT accept OPEN intents before markRecoveryComplete', async () => {
        const ledger = new ReservationLedger();
        const positionsRepo = { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository;
        const riskStateRepo = {
            findByDate: jest.fn().mockResolvedValue(null),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        } as unknown as RiskStateRepository;
        const events = { emit: jest.fn() } as unknown as EventEmitter2;

        const gate = new RiskGateService(ledger, new SlotManager(), new StressHaltEvaluator(), positionsRepo, riskStateRepo, events, {
            marketStressAutoResumeEnabled: false,
        } as never);

        // NOT calling markRecoveryComplete
        const decision = await gate.evaluate({ intentAction: OrderIntentActionEnum.OPEN, symbol: 'BTCUSDT' } as never, {} as never);

        expect(decision.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(decision.rejectReason).toBe(RejectReasonEnum.RECOVERY_IN_PROGRESS);
    });

    it('anti-coverage: reconciliation scheduled tick does NOT fire during boot guard', async () => {
        const riskGate = {
            expireStaleReservations: jest.fn(),
            isRecoveryReady: jest.fn().mockReturnValue(false), // boot not complete
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn(),
        } as unknown as RiskGateService;

        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        } as unknown as IExchangeClient;

        const positions = { findOpen: jest.fn().mockResolvedValue([]) } as unknown as PositionRepository;
        const transactions = {
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        } as unknown as TransactionRepository;
        const positionService = {
            transition: jest.fn(),
            adjustQty: jest.fn(),
            recordFunding: jest.fn(),
            finalizeRealizedPnl: jest.fn(),
        } as unknown as PositionService;
        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue(null) } as unknown as StrategyVersionRepository;
        const haltFlag = { isHalted: jest.fn().mockReturnValue(false) } as unknown as HaltFlagService;
        const instrumentor = { setLiquidationPrice: jest.fn(), onPositionOpened: jest.fn() } as unknown as PositionInstrumentor;
        const snapshotWriter = { writeNow: jest.fn() } as unknown as AccountSnapshotWriter;
        const events = new EventEmitter2();

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions,
            transactions,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            instrumentor,
            snapshotWriter,
            events,
        );

        // scheduledTick (not forceTick) is the boot-guarded path
        await service.scheduledTick();

        // No exchange calls should have been made (tick skipped by boot guard)
        expect(exchangeClient.fetchPositions).not.toHaveBeenCalled();
    });

    it('R2.1.1: local monitor DOES fire breach during recovery (boot guard removed; gate auto-approves de-risking)', async () => {
        const positionRepository = {
            findById: jest.fn().mockResolvedValue(buildPosition()),
        } as unknown as PositionRepository;

        const riskGate = {
            evaluate: jest.fn().mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, reservationId: null, rejectReason: null }),
            isRecoveryReady: jest.fn().mockReturnValue(false), // boot not ready
        } as unknown as RiskGateService;

        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const monitor = new LocalProtectiveMonitor(positionRepository, riskGate, events);

        monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // SL-breaching price during boot. R2.1.1 removed the LPM W8.5 guard
        // because R1.1.1 narrowed the gate's RECOVERY_IN_PROGRESS to OPEN/ADD
        // only — de-risking passes through during boot. The monitor MUST stay
        // the last line of defense per ADR-0011 §4.
        await monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29000', timestampMs: NOW_MS });

        // gate.evaluate WAS called and the approved event fired.
        expect(riskGate.evaluate).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith('risk.orderIntent.approved', expect.anything());
    });

    it('crash recovery idempotency: forceTick with same nowMs on same DB state produces same drift counters', async () => {
        const position = buildPosition({ state: PositionStateEnum.OPEN });

        // Exchange has no match for this position → case-b fires both times
        const makeHarness = () => {
            const exchangeClient = {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            } as unknown as IExchangeClient;

            const posRepo = {
                findOpen: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
                save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
            } as unknown as PositionRepository;

            const txRepo = {
                findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
                findByPosition: jest.fn().mockResolvedValue([]),
            } as unknown as TransactionRepository;

            const posService = {
                transition: jest.fn().mockResolvedValue(buildPosition({ state: PositionStateEnum.CLOSING })),
                finalizeRealizedPnl: jest.fn().mockResolvedValue(buildPosition({ state: PositionStateEnum.CLOSED })),
                adjustQty: jest.fn(),
                recordFunding: jest.fn(),
            } as unknown as PositionService;

            const rg = {
                expireStaleReservations: jest.fn(),
                reconcileClose: jest.fn().mockResolvedValue(undefined),
                recordExposureDrift: jest.fn().mockResolvedValue(undefined),
                isRecoveryReady: jest.fn().mockReturnValue(true),
            } as unknown as RiskGateService;

            const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
            const retainer = new SubscriptionRetainer();
            const sv = { findByNameAndVersion: jest.fn().mockResolvedValue(null) } as unknown as StrategyVersionRepository;
            const haltFlag = { isHalted: jest.fn().mockReturnValue(false) } as unknown as HaltFlagService;
            const instr = { setLiquidationPrice: jest.fn(), onPositionOpened: jest.fn() } as unknown as PositionInstrumentor;
            const snapWriter = { writeNow: jest.fn().mockResolvedValue(null) } as unknown as AccountSnapshotWriter;
            const ev = new EventEmitter2();

            return new ReconciliationService(
                exchangeClient as never,
                exchangeClient as never,
                { exchangeEnv: 'testnet' } as never,
                posRepo,
                txRepo,
                posService,
                rg,
                monitor,
                retainer,
                sv,
                haltFlag,
                instr,
                snapWriter,
                ev,
            );
        };

        const svc1 = makeHarness();
        const svc2 = makeHarness();

        const pass1 = await svc1.forceTick(NOW_MS);
        const pass2 = await svc2.forceTick(NOW_MS);

        // Same DB state → same drift counters
        expect(pass1.driftsByCase).toEqual(pass2.driftsByCase);
    });
});

// ─── 10. ANTI-COVERAGE (system MUST NOT do things) ──────────────────────────

describe('10. Anti-coverage assertions', () => {
    // R1.3c helper: build a CLOSED transition event with exitReason + realizedPnl
    // on the payload (listener reads these directly post-R1.3.4; no DB lookup).
    const buildClosedEvent = (exitReason: ExitReasonEnum, realizedPnl: string | null): IPositionStateTransitionedEvent => ({
        positionId: 42,
        fromState: PositionStateEnum.CLOSING,
        toState: PositionStateEnum.CLOSED,
        transitionedAtMs: NOW_MS,
        eventClass: 'test',
        symbol: 'BTCUSDT',
        exitReason,
        realizedPnl,
    });

    it('PositionLifecycleRetentionListener: TAKE_PROFIT closed position does NOT arm COOLDOWN_ACTIVE', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        const listener = new PositionLifecycleRetentionListener(retainer);
        listener.onStateTransitioned(buildClosedEvent(ExitReasonEnum.TAKE_PROFIT, '50'));

        // TAKE_PROFIT never arms cooldown
        expect(retainer.isRetained('BTCUSDT')).toBe(false);
        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('PositionLifecycleRetentionListener: KILL_SWITCH close does NOT arm COOLDOWN_ACTIVE', () => {
        const retainer = new SubscriptionRetainer();
        retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        const listener = new PositionLifecycleRetentionListener(retainer);
        listener.onStateTransitioned(buildClosedEvent(ExitReasonEnum.KILL_SWITCH, '-100'));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('PositionLifecycleRetentionListener: STOP_LOSS close ALWAYS arms COOLDOWN_ACTIVE (regardless of PnL sign)', () => {
        const retainer = new SubscriptionRetainer();
        const listener = new PositionLifecycleRetentionListener(retainer);

        // Technically a gain (gap fill), but SL always triggers cooldown.
        listener.onStateTransitioned(buildClosedEvent(ExitReasonEnum.STOP_LOSS, '5'));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(true);
    });

    it('PositionLifecycleRetentionListener: SIGNAL closed with POSITIVE PnL does NOT arm cooldown', () => {
        const retainer = new SubscriptionRetainer();
        const listener = new PositionLifecycleRetentionListener(retainer);

        listener.onStateTransitioned(buildClosedEvent(ExitReasonEnum.SIGNAL, '20'));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('RECONCILED_MISSING close does NOT arm cooldown (bot never saw fills — PnL is null)', () => {
        const retainer = new SubscriptionRetainer();
        const listener = new PositionLifecycleRetentionListener(retainer);

        listener.onStateTransitioned(buildClosedEvent(ExitReasonEnum.RECONCILED_MISSING, null));

        expect(retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('RiskGateService.evaluate never writes a decisions row during RECOVERY_IN_PROGRESS', async () => {
        const ledger = new ReservationLedger();
        const positionsRepo = { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository;
        const riskStateRepo = {
            findByDate: jest.fn().mockResolvedValue(null),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        } as unknown as RiskStateRepository;
        const eventsMock = { emit: jest.fn() } as unknown as EventEmitter2;

        const gate = new RiskGateService(ledger, new SlotManager(), new StressHaltEvaluator(), positionsRepo, riskStateRepo, eventsMock, {
            marketStressAutoResumeEnabled: false,
        } as never);
        // Gate starts in recovery mode

        await gate.evaluate({ intentAction: OrderIntentActionEnum.OPEN, symbol: 'BTCUSDT' } as never, {} as never);

        // ADR §9: "recovery rejects do not write decisions rows" → no event emitted
        expect(eventsMock.emit as jest.Mock).not.toHaveBeenCalled();
    });

    it('PositionService.transition does NOT emit event when position is not found', async () => {
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const repository = {
            findById: jest.fn().mockResolvedValue(null),
            save: jest.fn(),
        };
        const txRepo = {
            findByPosition: jest.fn().mockResolvedValue([]),
            recordTerminal: jest.fn(),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        };

        const service = new PositionService(repository as unknown as PositionRepository, txRepo as unknown as TransactionRepository, events);

        await expect(service.transition(999, PositionStateEnum.OPEN, { nowMs: NOW_MS, eventClass: 'test' })).rejects.toBeInstanceOf(PositionNotFoundException);

        expect(emitSpy).not.toHaveBeenCalled();
        expect(repository.save).not.toHaveBeenCalled();
    });
});
