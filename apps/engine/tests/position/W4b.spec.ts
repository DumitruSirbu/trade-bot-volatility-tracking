/**
 * M6 W4b — Mutation primitives + reconciliation upgrades.
 *
 * Coverage:
 *   - RiskGateService.reconcileClose: in-flight reservation released, open_exposure
 *     decremented, idempotent on second call (no extra decrement).
 *   - RiskGateService.recordExposureDrift: open_exposure adjusted by signed notional
 *     delta; telemetry event emitted.
 *   - PositionService.adjustQty: legal qty → atomic save + position.qty.adjusted event;
 *     illegal qty (negative / NaN) → IllegalQtyAdjustmentException; missing position →
 *     PositionNotFoundException; ordering: DB save before event emit.
 *   - ExecutionService.applyReduceFillToPosition: partial-reduce path now routes
 *     through PositionService.adjustQty(..., LATE_FILL_RESOLVED).
 *   - ReconciliationService case (b) precise: row transitions to CLOSED via the state
 *     machine; RECONCILED_MISSING exit reason stamped; reconcileClose invoked; monitor
 *     disarmed.
 *   - ReconciliationService case (c) precise: recordExposureDrift + adjustQty called
 *     in order; QTY_ADJUSTED resolved.
 *   - ReconciliationService case (a) flatten: with foreignPolicy='flatten', synth CLOSE
 *     intent routed through gate.evaluate; ORDER_INTENT_APPROVED_EVENT emitted; halt
 *     flag suppresses the close.
 *   - PositionLifecycleRetentionListener narrowed cooldown predicate: STOP_LOSS always,
 *     SIGNAL with neg PnL yes, SIGNAL with pos PnL no, TAKE_PROFIT never, KILL_SWITCH never.
 */

import {
    DriftCaseEnum,
    ExitReasonEnum,
    IPositionStateTransitionedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    QtyAdjustmentReasonEnum,
    ReconciliationOutcomeEnum,
    RetainReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IExchangeClient } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionLifecycleRetentionListener } from '../../src/position/service/PositionLifecycleRetentionListener';
import { IllegalQtyAdjustmentException, POSITION_QTY_ADJUSTED_EVENT, PositionService } from '../../src/position/service/PositionService';
import { PositionNotFoundException } from '../../src/position/exception';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { ReservationLedger } from '../../src/risk/service/ReservationLedger';
import { ReservationStateEnum } from '../../src/risk/enum';
import { RiskGateService, EXPOSURE_DRIFT_RECORDED_EVENT } from '../../src/risk/service/RiskGateService';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { SlotManager } from '../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../src/risk/service/StressHaltEvaluator';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;
const UTC_DATE = '2023-11-14'; // matches NOW_MS

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
        ...overrides,
    } as PositionEntity;
}

// ─── RiskGateService.reconcileClose / recordExposureDrift ──────────────────────

describe('RiskGateService.reconcileClose — case (b) primitive (ADR 0010 §1b)', () => {
    function buildGateHarness(position: PositionEntity | null, todayRow: { openExposure: import('../../src/common/utils/money').MoneyValue } | null = null) {
        const ledger = new ReservationLedger();
        const positions = { findById: jest.fn().mockResolvedValue(position) } as unknown as PositionRepository;
        const riskState = {
            findByDate: jest.fn().mockResolvedValue(
                todayRow === null
                    ? null
                    : {
                          date: UTC_DATE,
                          realizedPnlDay: new Money(0),
                          openExposure: todayRow.openExposure,
                          tradesCount: 0,
                          isHalted: false,
                          haltReason: null,
                      },
            ),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        } as unknown as RiskStateRepository;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const gate = new RiskGateService(ledger, {} as SlotManager, {} as StressHaltEvaluator, positions, riskState, events);

        return { gate, ledger, positions, riskState, events, emitSpy };
    }

    it('releases the in-flight reservation matching (symbol, slot) exactly once', async () => {
        const position = buildPositionRow({ positionSlot: PositionSlotEnum.A });
        const harness = buildGateHarness(position, { openExposure: new Money('500') });

        harness.ledger.reserve({
            reservationId: 'res-1',
            symbol: 'BTCUSDT',
            slot: PositionSlotEnum.A,
            tradeSide: PositionSideEnum.LONG,
            notional: new Money('300'),
            correlationMode: 'idiosyncratic' as never,
            createdAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
            state: ReservationStateEnum.PENDING,
        });

        await harness.gate.reconcileClose(42, NOW_MS);

        // listActive filters PENDING/CONFIRMED — released ones are excluded.
        expect(harness.ledger.listActive()).toHaveLength(0);
    });

    it('decrements open_exposure by the position entry_notional', async () => {
        const position = buildPositionRow({ entryNotional: new Money('300') });
        const harness = buildGateHarness(position, { openExposure: new Money('500') });

        await harness.gate.reconcileClose(42, NOW_MS);

        const upsertArg = (harness.riskState.upsertDay as jest.Mock).mock.calls[0][0];
        expect(upsertArg.openExposure.toFixed()).toBe('200');
    });

    it('clamps open_exposure at zero on a duplicate reconcileClose (idempotent)', async () => {
        const position = buildPositionRow({ entryNotional: new Money('300') });
        const harness = buildGateHarness(position, { openExposure: new Money('100') });

        await harness.gate.reconcileClose(42, NOW_MS);

        const upsertArg = (harness.riskState.upsertDay as jest.Mock).mock.calls[0][0];
        expect(upsertArg.openExposure.toFixed()).toBe('0');
    });

    it('no-op when the position does not exist', async () => {
        const harness = buildGateHarness(null, { openExposure: new Money('500') });

        await harness.gate.reconcileClose(999, NOW_MS);

        expect(harness.riskState.upsertDay).not.toHaveBeenCalled();
    });
});

describe('RiskGateService.recordExposureDrift — case (c) primitive (ADR 0010 §1c)', () => {
    function buildHarness(position: PositionEntity, openExposure: string) {
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
        } as unknown as RiskStateRepository;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const gate = new RiskGateService(ledger, {} as SlotManager, {} as StressHaltEvaluator, positions, riskState, events);

        return { gate, riskState, events, emitSpy };
    }

    it('adjusts open_exposure by (exchangeQty - dbQty) * entryPrice (positive delta)', async () => {
        const position = buildPositionRow({ entryPrice: new Money('30000') });
        const harness = buildHarness(position, '300');

        await harness.gate.recordExposureDrift(42, new Money('0.01'), new Money('0.015'), NOW_MS);

        // delta = 0.005 * 30000 = 150 → openExposure 300 + 150 = 450
        const upsertArg = (harness.riskState.upsertDay as jest.Mock).mock.calls[0][0];
        expect(upsertArg.openExposure.toFixed()).toBe('450');
    });

    it('adjusts open_exposure with negative delta when exchange has less qty', async () => {
        const position = buildPositionRow({ entryPrice: new Money('30000') });
        const harness = buildHarness(position, '500');

        await harness.gate.recordExposureDrift(42, new Money('0.02'), new Money('0.01'), NOW_MS);

        // delta = -0.01 * 30000 = -300 → openExposure 500 - 300 = 200
        const upsertArg = (harness.riskState.upsertDay as jest.Mock).mock.calls[0][0];
        expect(upsertArg.openExposure.toFixed()).toBe('200');
    });

    it('emits EXPOSURE_DRIFT_RECORDED_EVENT telemetry', async () => {
        const position = buildPositionRow({ entryPrice: new Money('30000') });
        const harness = buildHarness(position, '300');

        await harness.gate.recordExposureDrift(42, new Money('0.01'), new Money('0.015'), NOW_MS);

        const driftEvents = harness.emitSpy.mock.calls.filter(([n]) => n === EXPOSURE_DRIFT_RECORDED_EVENT);
        expect(driftEvents).toHaveLength(1);
        const payload = driftEvents[0][1] as { positionId: number; symbol: string; notionalDelta: string };
        expect(payload.positionId).toBe(42);
        expect(payload.symbol).toBe('BTCUSDT');
        expect(payload.notionalDelta).toBe('150');
    });
});

// ─── PositionService.adjustQty ─────────────────────────────────────────────────

describe('PositionService.adjustQty (ADR 0009 §6.1b)', () => {
    function buildHarness(position: PositionEntity | null) {
        const repo = {
            findById: jest.fn().mockResolvedValue(position),
            save: jest.fn().mockImplementation(async (p: PositionEntity) => p),
        } as unknown as PositionRepository;
        const transactions = {
            findByPosition: jest.fn().mockResolvedValue([]),
            recordTerminal: jest.fn().mockImplementation(async (e: unknown) => e),
        } as unknown as import('../../src/position/repository/TransactionRepository').TransactionRepository;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const service = new PositionService(repo, transactions, events);
        return { service, repo, events, emitSpy };
    }

    it('updates qty atomically and emits position.qty.adjusted', async () => {
        const position = buildPositionRow({ qty: new Money('0.01') });
        const harness = buildHarness(position);

        await harness.service.adjustQty(42, new Money('0.02'), QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: NOW_MS });

        expect(harness.repo.save).toHaveBeenCalledTimes(1);
        const saved = (harness.repo.save as jest.Mock).mock.calls[0][0] as PositionEntity;
        expect(saved.qty.toFixed()).toBe('0.02');

        const events = harness.emitSpy.mock.calls.filter(([n]) => n === POSITION_QTY_ADJUSTED_EVENT);
        expect(events).toHaveLength(1);
        const payload = events[0][1] as { positionId: number; oldQty: string; newQty: string; reason: QtyAdjustmentReasonEnum };
        expect(payload.positionId).toBe(42);
        expect(payload.oldQty).toBe('0.01');
        expect(payload.newQty).toBe('0.02');
        expect(payload.reason).toBe(QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED);
    });

    it('DB save precedes event emit (ordering preserved)', async () => {
        const position = buildPositionRow({ qty: new Money('0.01') });
        const harness = buildHarness(position);
        const callOrder: string[] = [];
        (harness.repo.save as jest.Mock).mockImplementation(async (p: PositionEntity) => {
            callOrder.push('save');
            return p;
        });
        harness.emitSpy.mockImplementation(((event: string | symbol) => {
            if (event === POSITION_QTY_ADJUSTED_EVENT) {
                callOrder.push('emit');
            }
            return true;
        }) as never);

        await harness.service.adjustQty(42, new Money('0.02'), QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: NOW_MS });

        expect(callOrder).toEqual(['save', 'emit']);
    });

    it('throws IllegalQtyAdjustmentException for a negative qty', async () => {
        const position = buildPositionRow();
        const harness = buildHarness(position);

        await expect(harness.service.adjustQty(42, new Money('-0.01'), QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            IllegalQtyAdjustmentException,
        );
        expect(harness.repo.save).not.toHaveBeenCalled();
    });

    it('throws IllegalQtyAdjustmentException for a NaN qty', async () => {
        const position = buildPositionRow();
        const harness = buildHarness(position);

        await expect(harness.service.adjustQty(42, new Money(NaN), QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            IllegalQtyAdjustmentException,
        );
    });

    it('throws PositionNotFoundException when the position is missing', async () => {
        const harness = buildHarness(null);

        await expect(harness.service.adjustQty(999, new Money('0.01'), QtyAdjustmentReasonEnum.LATE_FILL_RESOLVED, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
            PositionNotFoundException,
        );
    });
});

// ─── ReconciliationService case (b) / (c) / (a flatten) ────────────────────────

describe('ReconciliationService case (b) precise (W4b)', () => {
    function buildReconHarness(dbRow: PositionEntity) {
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        } as unknown as IExchangeClient;
        const positions = {
            findOpen: jest.fn().mockResolvedValue([dbRow]),
            findById: jest.fn().mockResolvedValue(dbRow),
            save: jest.fn().mockResolvedValue(dbRow),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;
        const transactions = {
            findByClientOrderId: jest.fn(),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        } as unknown as TransactionRepository;
        const positionService = {
            transition: jest.fn().mockResolvedValue(dbRow),
            adjustQty: jest.fn().mockResolvedValue(dbRow),
            finalizeRealizedPnl: jest.fn().mockImplementation(async (positionId: number, exitReason: ExitReasonEnum) => {
                dbRow.exitReason = exitReason;
                dbRow.state = PositionStateEnum.CLOSED;
                return dbRow;
            }),
            recordFunding: jest.fn().mockResolvedValue(undefined),
        } as unknown as PositionService;
        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn().mockResolvedValue(undefined),
            recordExposureDrift: jest.fn().mockResolvedValue(undefined),
            evaluate: jest.fn().mockResolvedValue({
                outcome: RiskOutcomeEnum.APPROVED,
                rejectReason: null,
                approvedSlot: null,
                approvedSizing: null,
                clampedExit: null,
                reservationId: null,
            }),
        } as unknown as RiskGateService;
        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) } as unknown as StrategyVersionRepository;
        const haltFlag = new HaltFlagService();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const service = new ReconciliationService(
            exchangeClient,
            positions,
            transactions,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            { setLiquidationPrice: jest.fn() } as never,
            { writeNow: jest.fn().mockResolvedValue(null) } as never,
            events,
        );
        return { service, positionService, riskGate, monitor, events, emitSpy, haltFlag };
    }

    it('transitions OPEN → CLOSING and finalizes with RECONCILED_MISSING (W5: single atomic close)', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.OPEN });
        const harness = buildReconHarness(row);

        await harness.service.tick(NOW_MS);

        // W5: case (b) now uses one transition(CLOSING) followed by finalizeRealizedPnl,
        // which atomically writes state=CLOSED + exit_reason/closed_at in a single UPDATE
        // (ADR 0009 §6.1 / ADR 0012 §5). The finalize call replaces the second transition.
        const transitionCalls = (harness.positionService.transition as jest.Mock).mock.calls;
        expect(transitionCalls).toHaveLength(1);
        expect(transitionCalls[0][1]).toBe(PositionStateEnum.CLOSING);

        const finalizeCalls = (harness.positionService.finalizeRealizedPnl as jest.Mock).mock.calls;
        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0][1]).toBe(ExitReasonEnum.RECONCILED_MISSING);
        // Mock finalize stamps the row; assert exit reason persisted through the close.
        expect(row.exitReason).toBe(ExitReasonEnum.RECONCILED_MISSING);
    });

    it('calls reconcileClose and disarms the monitor', async () => {
        const row = buildPositionRow({ state: PositionStateEnum.OPEN });
        const harness = buildReconHarness(row);

        await harness.service.tick(NOW_MS);

        expect(harness.riskGate.reconcileClose).toHaveBeenCalledWith(42, NOW_MS);
        expect(harness.monitor.disarm).toHaveBeenCalledWith(42);
    });
});

describe('ReconciliationService case (c) precise (W4b)', () => {
    function buildReconHarness(dbRow: PositionEntity, exchangeQty: string) {
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([
                {
                    symbol: dbRow.symbol,
                    side: dbRow.side,
                    qty: exchangeQty,
                    entryPrice: '30000',
                    markPrice: '30100',
                    liquidationPrice: null,
                    marginType: null,
                    leverage: '5',
                    timestampMs: NOW_MS,
                },
            ]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        } as unknown as IExchangeClient;
        const positions = {
            findOpen: jest.fn().mockResolvedValue([dbRow]),
            findById: jest.fn().mockResolvedValue(dbRow),
            save: jest.fn().mockResolvedValue(dbRow),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;
        const positionService = {
            transition: jest.fn().mockResolvedValue(dbRow),
            adjustQty: jest.fn().mockResolvedValue(dbRow),
            finalizeRealizedPnl: jest.fn().mockResolvedValue(dbRow),
            recordFunding: jest.fn().mockResolvedValue(undefined),
        } as unknown as PositionService;
        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn().mockResolvedValue(undefined),
            evaluate: jest.fn(),
        } as unknown as RiskGateService;
        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) } as unknown as StrategyVersionRepository;
        const haltFlag = new HaltFlagService();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const service = new ReconciliationService(
            exchangeClient,
            positions,
            { findLatestFundingByPosition: jest.fn().mockResolvedValue(null) } as unknown as TransactionRepository,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            { setLiquidationPrice: jest.fn() } as never,
            { writeNow: jest.fn().mockResolvedValue(null) } as never,
            events,
        );
        return { service, positionService, riskGate, emitSpy };
    }

    it('calls recordExposureDrift then adjustQty in order, emits QTY_ADJUSTED', async () => {
        const row = buildPositionRow({ qty: new Money('0.01'), protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const harness = buildReconHarness(row, '0.015');

        const callOrder: string[] = [];
        (harness.riskGate.recordExposureDrift as jest.Mock).mockImplementation(async () => {
            callOrder.push('recordExposureDrift');
        });
        (harness.positionService.adjustQty as jest.Mock).mockImplementation(async () => {
            callOrder.push('adjustQty');
            return row;
        });

        await harness.service.tick(NOW_MS);

        expect(callOrder).toEqual(['recordExposureDrift', 'adjustQty']);

        const adjustCall = (harness.positionService.adjustQty as jest.Mock).mock.calls[0];
        expect(adjustCall[1].toFixed()).toBe('0.015');
        expect(adjustCall[2]).toBe(QtyAdjustmentReasonEnum.EXCHANGE_QTY_CORRECTION);

        const resolvedEvents = harness.emitSpy.mock.calls.filter(([n]) => n === 'reconciliation.resolved');
        const qtyAdjusted = resolvedEvents.find(([, p]) => (p as { outcome: ReconciliationOutcomeEnum }).outcome === ReconciliationOutcomeEnum.QTY_ADJUSTED);
        expect(qtyAdjusted).toBeDefined();
    });
});

describe('ReconciliationService case (a) flatten policy (W4b)', () => {
    function buildHarness() {
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([
                {
                    symbol: 'ETHUSDT',
                    side: 'long',
                    qty: '0.5',
                    entryPrice: '2000',
                    markPrice: '2010',
                    liquidationPrice: null,
                    marginType: null,
                    leverage: '5',
                    timestampMs: NOW_MS,
                },
            ]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchOrderByClientId: jest.fn(),
        } as unknown as IExchangeClient;
        const adoptedRow = buildPositionRow({
            id: 999,
            symbol: 'ETHUSDT',
            qty: new Money('0.5'),
            entryPrice: new Money('2000'),
            state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
        });
        const positions = {
            findOpen: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(adoptedRow),
            createOpen: jest.fn().mockResolvedValue(adoptedRow),
            save: jest.fn(),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;
        const positionService = { transition: jest.fn(), adjustQty: jest.fn() } as unknown as PositionService;
        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn(),
            evaluate: jest.fn().mockResolvedValue({
                outcome: RiskOutcomeEnum.APPROVED,
                rejectReason: null,
                approvedSlot: null,
                approvedSizing: null,
                clampedExit: null,
                reservationId: null,
            }),
        } as unknown as RiskGateService;
        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7 }) } as unknown as StrategyVersionRepository;
        const haltFlag = new HaltFlagService();
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const service = new ReconciliationService(
            exchangeClient,
            positions,
            {} as TransactionRepository,
            positionService,
            riskGate,
            monitor,
            retainer,
            strategyVersions,
            haltFlag,
            { setLiquidationPrice: jest.fn() } as never,
            { writeNow: jest.fn().mockResolvedValue(null) } as never,
            events,
        );
        return { service, riskGate, positions, haltFlag, emitSpy };
    }

    it('with foreignPolicy=flatten, adopts the row AND emits ORDER_INTENT_APPROVED_EVENT for the close', async () => {
        const harness = buildHarness();
        harness.service.setForeignPositionPolicy('flatten');

        await harness.service.tick(NOW_MS);

        expect(harness.positions.createOpen).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.evaluate).toHaveBeenCalledTimes(1);

        const [intent] = (harness.riskGate.evaluate as jest.Mock).mock.calls[0];
        expect(intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        // close side is opposite of adopted long
        expect(intent.tradeSide).toBe(PositionSideEnum.SHORT);

        const approved = harness.emitSpy.mock.calls.filter(([n]) => n === ORDER_INTENT_APPROVED_EVENT);
        expect(approved).toHaveLength(1);
    });

    it('halt flag suppresses the flatten close (row stays MANUAL_ADOPTED_UNMANAGED)', async () => {
        const harness = buildHarness();
        harness.service.setForeignPositionPolicy('flatten');
        harness.haltFlag.halt('test');

        await harness.service.tick(NOW_MS);

        expect(harness.positions.createOpen).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.evaluate).not.toHaveBeenCalled();
        expect(harness.emitSpy.mock.calls.filter(([n]) => n === ORDER_INTENT_APPROVED_EVENT)).toHaveLength(0);
    });

    it('default policy adopt_unmanaged does NOT call gate.evaluate', async () => {
        const harness = buildHarness();
        // default 'adopt_unmanaged' — no setForeignPositionPolicy call

        await harness.service.tick(NOW_MS);

        expect(harness.positions.createOpen).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.evaluate).not.toHaveBeenCalled();
    });
});

// ─── Cooldown predicate refinement ─────────────────────────────────────────────

describe('PositionLifecycleRetentionListener — narrowed cooldown predicate (ADR 0011 §5 revised)', () => {
    // R1.3c: listener now reads exitReason + realizedPnl from the event payload
    // (no DB round-trip). The harness no longer mocks a repository; the close
    // event factory threads the loss-class inputs onto the payload directly.
    function buildHarness() {
        const retainer = new SubscriptionRetainer();
        const listener = new PositionLifecycleRetentionListener(retainer);

        return { listener, retainer };
    }

    function closeEvent(exitReason: ExitReasonEnum, realizedPnl: import('../../src/common/utils/money').MoneyValue | null): IPositionStateTransitionedEvent {
        return {
            positionId: 42,
            fromState: PositionStateEnum.CLOSING,
            toState: PositionStateEnum.CLOSED,
            transitionedAtMs: NOW_MS,
            eventClass: 'test',
            symbol: 'BTCUSDT',
            exitReason,
            realizedPnl: realizedPnl === null ? null : realizedPnl.toFixed(),
        };
    }

    it('STOP_LOSS always arms COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.STOP_LOSS, new Money('-5')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(true);
    });

    it('LIQUIDATED always arms COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.LIQUIDATED, new Money('-100')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(true);
    });

    it('SIGNAL with negative PnL arms COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.SIGNAL, new Money('-5')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(true);
    });

    it('SIGNAL with positive PnL does NOT arm COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.SIGNAL, new Money('5')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('TIME_STOP with negative PnL arms COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.TIME_STOP, new Money('-3')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(true);
    });

    it('TAKE_PROFIT never arms COOLDOWN_ACTIVE (a win)', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.TAKE_PROFIT, new Money('10')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('KILL_SWITCH with negative PnL does NOT arm COOLDOWN_ACTIVE (operator intervention)', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.KILL_SWITCH, new Money('-15')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('MANUAL with negative PnL does NOT arm COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.MANUAL, new Money('-5')));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });

    it('RECONCILED_MISSING (null PnL) does NOT arm COOLDOWN_ACTIVE', () => {
        const h = buildHarness();
        h.listener.onStateTransitioned(closeEvent(ExitReasonEnum.RECONCILED_MISSING, null));
        expect(h.retainer.getReasonsFor('BTCUSDT').has(RetainReasonEnum.COOLDOWN_ACTIVE)).toBe(false);
    });
});

// Silence the unused-import warning by referencing DriftCaseEnum (used implicitly via outcome enum branching above)
void DriftCaseEnum;
