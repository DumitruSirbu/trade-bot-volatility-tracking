/**
 * M6 R1.1 — Review-round-1 contract-blocker fix-wave paired tests.
 *
 * Each `R1.1.X` item gets its own paired tests asserting:
 *   - the new shipped behavior (post-fix), and
 *   - the regression that the prior behavior would have broken.
 *
 * R1.1.1 lives in W8.spec.ts (the gate-guard already had a test bay there).
 * R1.1.2 / R1.1.3 / R1.1.4 / R1.1.5 land here.
 */

import {
    CorrelationModeEnum,
    DriftCaseEnum,
    ExitReasonEnum,
    IPositionAdoptionVanishedEvent,
    IReconciliationResolvedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    ReconciliationOutcomeEnum,
    RetainReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { IExchangeClient, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import { POSITION_ADOPTION_VANISHED_EVENT, RECONCILIATION_RESOLVED_EVENT, ReconciliationService } from '../../src/position/service/ReconciliationService';
import { ReservationLedger } from '../../src/risk/service/ReservationLedger';
import { ReservationStateEnum } from '../../src/risk/enum';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { SlotManager } from '../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../src/risk/service/StressHaltEvaluator';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;
const UTC_DATE = '2023-11-14';

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
        openedAt: new Date(NOW_MS - 60_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        ...overrides,
    } as PositionEntity;
}

interface IReconHarness {
    service: ReconciliationService;
    positionService: { transition: jest.Mock; adjustQty: jest.Mock; finalizeRealizedPnl: jest.Mock; recordFunding: jest.Mock };
    riskGate: { reconcileClose: jest.Mock; expireStaleReservations: jest.Mock; evaluate: jest.Mock; recordExposureDrift: jest.Mock };
    monitor: { arm: jest.Mock; disarm: jest.Mock };
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
}

function buildReconHarness(opts: { positions?: PositionEntity[]; exchangePositions?: IPositionSnapshot[] } = {}): IReconHarness {
    const exchangeClient = {
        fetchPositions: jest.fn().mockResolvedValue(opts.exchangePositions ?? []),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    } as unknown as IExchangeClient;
    const positions = {
        findOpen: jest.fn().mockResolvedValue(opts.positions ?? []),
        findNonTerminal: jest.fn().mockResolvedValue(opts.positions ?? []),
        findById: jest.fn().mockImplementation(async (id: number) => (opts.positions ?? []).find((p) => p.id === id) ?? null),
        createOpen: jest.fn(),
        save: jest.fn().mockImplementation(async (entity) => entity),
        findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
    } as unknown as PositionRepository;
    const transactions = { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) } as unknown as TransactionRepository;
    const positionService = {
        transition: jest.fn(),
        adjustQty: jest.fn(),
        recordFunding: jest.fn(),
        finalizeRealizedPnl: jest.fn(),
    };
    const riskGate = {
        expireStaleReservations: jest.fn(),
        listActiveReservationSlots: jest.fn().mockReturnValue([]),
        reconcileClose: jest.fn().mockResolvedValue(undefined),
        recordExposureDrift: jest.fn(),
        evaluate: jest.fn().mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, rejectReason: null, reservationId: null }),
        isRecoveryReady: jest.fn().mockReturnValue(true),
    };
    const monitor = { arm: jest.fn(), disarm: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) } as unknown as StrategyVersionRepository;
    const haltFlag = new HaltFlagService();
    const instrumentor = { setLiquidationPrice: jest.fn() } as never;
    const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as never;
    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const service = new ReconciliationService(
        exchangeClient as never,
        exchangeClient as never,
        { exchangeEnv: 'testnet' } as never,
        positions,
        transactions,
        positionService as unknown as PositionService,
        riskGate as unknown as RiskGateService,
        monitor as unknown as LocalProtectiveMonitor,
        retainer,
        strategyVersions,
        haltFlag,
        instrumentor,
        snapshotWriter,
        events,
        new SharedCloseCoordinator(),
    );

    return { service, positionService, riskGate, monitor, events, emitSpy };
}

// ─── R1.1.2 — case-(b) transition routing by source state ──────────────────

describe('M6 R1.1.2 — ReconciliationService.handleDbOpenNotOnExchange source-state routing', () => {
    it('OPEN source: transitions OPEN→CLOSING then finalize (CLOSING→CLOSED via finalize)', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.OPEN });
        const h = buildReconHarness({ positions: [row], exchangePositions: [] });

        await h.service.tick(NOW_MS);

        const transitionCalls = h.positionService.transition.mock.calls.map((c) => c[1]);
        expect(transitionCalls).toContain(PositionStateEnum.CLOSING);
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalledWith(42, ExitReasonEnum.RECONCILED_MISSING, expect.objectContaining({ nowMs: NOW_MS }));
        expect(h.riskGate.reconcileClose).toHaveBeenCalledWith(42, NOW_MS);
        expect(h.monitor.disarm).toHaveBeenCalledWith(42);
    });

    it('CLOSING source: skips leading transition; finalize directly (CLOSING→CLOSED)', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.CLOSING });
        const h = buildReconHarness({ positions: [row], exchangePositions: [] });

        await h.service.tick(NOW_MS);

        // No transition call before finalize — finalize handles CLOSING→CLOSED.
        expect(h.positionService.transition).not.toHaveBeenCalled();
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalled();
    });

    it('PENDING_OPEN source: transitions PENDING_OPEN→RECONCILING then finalize (RECONCILING→CLOSED)', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const h = buildReconHarness({ positions: [row], exchangePositions: [] });

        await h.service.tick(NOW_MS);

        const transitionTargets = h.positionService.transition.mock.calls.map((c) => c[1]);
        expect(transitionTargets).toEqual([PositionStateEnum.RECONCILING]);
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalled();
    });

    it('RECONCILING source: skips leading transition; finalize directly (RECONCILING→CLOSED)', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.RECONCILING });
        const h = buildReconHarness({ positions: [row], exchangePositions: [] });

        await h.service.tick(NOW_MS);

        expect(h.positionService.transition).not.toHaveBeenCalled();
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalled();
    });

    it('MANUAL_ADOPTED_UNMANAGED source: SKIPS (no transition, no finalize, no reconcileClose) + emits IPositionAdoptionVanishedEvent', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED, correlationMode: null });
        const h = buildReconHarness({ positions: [row], exchangePositions: [] });

        await h.service.tick(NOW_MS);

        expect(h.positionService.transition).not.toHaveBeenCalled();
        expect(h.positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
        expect(h.riskGate.reconcileClose).not.toHaveBeenCalled();
        expect(h.monitor.disarm).not.toHaveBeenCalled();

        const vanishedEvents = h.emitSpy.mock.calls.filter(([n]) => n === POSITION_ADOPTION_VANISHED_EVENT);
        expect(vanishedEvents).toHaveLength(1);
        const payload = vanishedEvents[0][1] as IPositionAdoptionVanishedEvent;
        expect(payload.positionId).toBe(42);
        expect(payload.symbol).toBe('BTCUSDT');
        expect(payload.side).toBe(PositionSideEnum.LONG);
        expect(payload.detectedAtMs).toBe(NOW_MS);
    });
});

// ─── R1.1.3 — flatten emits FLATTENED outcome ──────────────────────────────

describe('M6 R1.1.3 — case-(a) flatten emits ReconciliationOutcomeEnum.FLATTENED', () => {
    it('with foreignPolicy=flatten, the resolved event carries outcome=FLATTENED (not RECONCILED_MISSING)', async () => {
        const exchangePosition: IPositionSnapshot = {
            symbol: 'ETHUSDT',
            side: 'long',
            qty: '0.5',
            entryPrice: '2000',
            markPrice: '2010',
            liquidationPrice: null,
            marginType: null,
            leverage: '5',
            timestampMs: NOW_MS,
        };

        // Foreign symbol with NO matching DB row → case-(a) handler fires; adopt then flatten.
        const adoptedRow = buildPositionRow({ id: 999, symbol: 'ETHUSDT', state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED });
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([exchangePosition]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        } as unknown as IExchangeClient;
        const positions = {
            findOpen: jest.fn().mockResolvedValue([]),
            findNonTerminal: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(adoptedRow),
            createOpen: jest.fn().mockResolvedValue(adoptedRow),
            save: jest.fn(),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;
        const positionService = { transition: jest.fn(), adjustQty: jest.fn(), recordFunding: jest.fn(), finalizeRealizedPnl: jest.fn() };
        const riskGate = {
            expireStaleReservations: jest.fn(),
            listActiveReservationSlots: jest.fn().mockReturnValue([]),
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn(),
            evaluate: jest.fn().mockResolvedValue({ outcome: RiskOutcomeEnum.APPROVED, rejectReason: null, reservationId: null }),
            isRecoveryReady: jest.fn().mockReturnValue(true),
        };
        const monitor = { arm: jest.fn(), disarm: jest.fn() };
        const retainer = new SubscriptionRetainer();
        const haltFlag = new HaltFlagService();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');

        const service = new ReconciliationService(
            exchangeClient as never,
            exchangeClient as never,
            { exchangeEnv: 'testnet' } as never,
            positions,
            { findByClientOrderId: jest.fn(), findLatestFundingByPosition: jest.fn().mockResolvedValue(null) } as never,
            positionService as never,
            riskGate as never,
            monitor as never,
            retainer,
            { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) } as never,
            haltFlag,
            { setLiquidationPrice: jest.fn() } as never,
            { writeNow: jest.fn().mockResolvedValue(null) } as never,
            events,
            new SharedCloseCoordinator(),
        );
        service.setForeignPositionPolicy('flatten');

        await service.tick(NOW_MS);

        const resolvedEvents = emitSpy.mock.calls.filter(([n]) => n === RECONCILIATION_RESOLVED_EVENT).map((c) => c[1] as IReconciliationResolvedEvent);
        const flattenResolved = resolvedEvents.find((e) => e.driftCase === DriftCaseEnum.EXCHANGE_NOT_IN_DB);
        expect(flattenResolved).toBeDefined();
        expect(flattenResolved!.outcome).toBe(ReconciliationOutcomeEnum.FLATTENED);
    });
});

// ─── R1.1.4 — reconcileClose releases live residual notional ───────────────

describe('M6 R1.1.4 — RiskGateService.reconcileClose releases qty * entryPrice (live residual)', () => {
    function buildGateHarness(position: PositionEntity, openExposure: string) {
        const ledger = new ReservationLedger();
        const positions = { findById: jest.fn().mockResolvedValue(position) } as unknown as PositionRepository;
        const riskState = {
            findByDate: jest.fn().mockResolvedValue({
                date: UTC_DATE,
                realizedPnlDay: new Money(0),
                openExposure: new Money(openExposure),
                tradesCount: 0,
                isHalted: false,
                haltReason: null,
            }),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        };
        const events = { emit: jest.fn() };
        const gate = new RiskGateService(
            ledger,
            new SlotManager(),
            new StressHaltEvaluator(),
            positions,
            riskState as never,
            events as never,
            { marketStressAutoResumeEnabled: false } as never,
        );
        gate.markRecoveryComplete();

        return { gate, ledger, positions, riskState };
    }

    it('partially-reduced position: release equals qty * entryPrice, not entry_notional', async () => {
        // Position originally opened at entry_notional=600 (qty=0.02 * 30000).
        // After a partial reduce to qty=0.01, residual notional = 0.01 * 30000 = 300.
        // Pre-R1.1.4 the release used entry_notional (600) → would have double-decremented.
        const row = buildPositionRow({
            qty: new Money('0.01'),
            entryPrice: new Money('30000'),
            entryNotional: new Money('600'), // historical gross from open + add
        });
        const h = buildGateHarness(row, '500');

        await h.gate.reconcileClose(42, NOW_MS);

        const upsertArg = h.riskState.upsertDay.mock.calls[0][0] as { openExposure: MoneyValue };
        // open_exposure 500 - residual 300 = 200 (clamped at zero, but 200 ≥ 0).
        expect(upsertArg.openExposure.toFixed()).toBe('200');
    });

    it('full-size position: release equals qty * entryPrice (= entry_notional when no adds/reduces)', async () => {
        const row = buildPositionRow({ qty: new Money('0.01'), entryPrice: new Money('30000'), entryNotional: new Money('300') });
        const h = buildGateHarness(row, '500');

        await h.gate.reconcileClose(42, NOW_MS);

        const upsertArg = h.riskState.upsertDay.mock.calls[0][0] as { openExposure: MoneyValue };
        expect(upsertArg.openExposure.toFixed()).toBe('200'); // 500 - 300
    });
});

// ─── R1.1.5 — reservation matcher tightened to (eventId, slot) ─────────────

describe('M6 R1.1.5 — RiskGateService matcher disambiguates two reservations on same (symbol, slot)', () => {
    function buildLedgerAndGate() {
        const ledger = new ReservationLedger();
        const positions = { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository;
        const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn() };
        const events = { emit: jest.fn() };
        const gate = new RiskGateService(
            ledger,
            new SlotManager(),
            new StressHaltEvaluator(),
            positions,
            riskState as never,
            events as never,
            { marketStressAutoResumeEnabled: false } as never,
        );
        gate.markRecoveryComplete();

        return { gate, ledger };
    }

    it('with eventId provided: only the matching reservation is released', () => {
        const h = buildLedgerAndGate();

        // Two reservations on the same (symbol=BTCUSDT, slot=A) differing only in eventId.
        h.ledger.reserve({
            reservationId: 'evt-1:A',
            symbol: 'BTCUSDT',
            slot: PositionSlotEnum.A,
            tradeSide: PositionSideEnum.LONG,
            notional: new Money('100'),
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            createdAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
            state: ReservationStateEnum.PENDING,
        });
        h.ledger.reserve({
            reservationId: 'evt-2:A',
            symbol: 'BTCUSDT',
            slot: PositionSlotEnum.A,
            tradeSide: PositionSideEnum.LONG,
            notional: new Money('200'),
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            createdAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
            state: ReservationStateEnum.PENDING,
        });

        expect(h.ledger.listActive()).toHaveLength(2);

        // Reach in via the private method using `unknown as` cast — the precise
        // (eventId, slot) match path is exercised by callers that know the eventId.
        const released = (
            h.gate as unknown as {
                releaseInFlightReservationFor: (symbol: string, slot: PositionSlotEnum, eventId?: string) => string | null;
            }
        ).releaseInFlightReservationFor('BTCUSDT', PositionSlotEnum.A, 'evt-2');

        expect(released).toBe('evt-2:A');

        // evt-1:A is still active; evt-2:A is released.
        const remainingIds = h.ledger.listActive().map((r) => r.reservationId);
        expect(remainingIds).toEqual(['evt-1:A']);
    });

    it('without eventId: falls back to (symbol, slot) match — first hit released (backward compat)', () => {
        const h = buildLedgerAndGate();
        h.ledger.reserve({
            reservationId: 'evt-1:A',
            symbol: 'BTCUSDT',
            slot: PositionSlotEnum.A,
            tradeSide: PositionSideEnum.LONG,
            notional: new Money('100'),
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            createdAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
            state: ReservationStateEnum.PENDING,
        });

        const released = (
            h.gate as unknown as {
                releaseInFlightReservationFor: (symbol: string, slot: PositionSlotEnum, eventId?: string) => string | null;
            }
        ).releaseInFlightReservationFor('BTCUSDT', PositionSlotEnum.A);

        expect(released).toBe('evt-1:A');
        expect(h.ledger.listActive()).toHaveLength(0);
    });

    it('with eventId provided but no matching reservation: returns null (no false release)', () => {
        const h = buildLedgerAndGate();
        h.ledger.reserve({
            reservationId: 'evt-1:A',
            symbol: 'BTCUSDT',
            slot: PositionSlotEnum.A,
            tradeSide: PositionSideEnum.LONG,
            notional: new Money('100'),
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            createdAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
            state: ReservationStateEnum.PENDING,
        });

        const released = (
            h.gate as unknown as {
                releaseInFlightReservationFor: (symbol: string, slot: PositionSlotEnum, eventId?: string) => string | null;
            }
        ).releaseInFlightReservationFor('BTCUSDT', PositionSlotEnum.A, 'evt-NONEXISTENT');

        expect(released).toBeNull();
        expect(h.ledger.listActive()).toHaveLength(1); // untouched
    });
});

// Silence unused-import lint
void RetainReasonEnum;
void OrderIntentActionEnum;
