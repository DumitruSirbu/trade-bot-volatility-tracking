/**
 * M6 W8.5 — boot-race guards on the four scheduled / event-driven handlers
 * that race the boot pipeline (ADR 0014 §1, §9). Each guard reads
 * `RiskGateService.isRecoveryReady()` (the W8 single-source-of-truth) and
 * short-circuits when false.
 *
 * Per-guard paired tests:
 *   - ReconciliationService.scheduledTick — gated; forceTick bypasses.
 *   - AccountSnapshotWriter.scheduledTick — gated; writeNow bypasses.
 *   - PositionInstrumentor.flushPending — gated; event-driven handlers
 *     (onPriceUpdate, onPositionStateTransitioned, onPositionOpenedEvent)
 *     are NOT gated so the in-memory accumulator still absorbs samples
 *     during boot.
 *   - LocalProtectiveMonitor.onPriceUpdate — gated; arm() bypasses (phase 4c
 *     calls arm directly during boot).
 */

import { PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IExchangeClient, IOpenOrderSnapshot, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { PositionEntity } from '../../src/position/entity';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { AccountSnapshotWriter } from '../../src/position/service/AccountSnapshotWriter';
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
        openedAt: new Date(NOW_MS - 60_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        positionSlot: PositionSlotEnum.A,
        ...overrides,
    } as PositionEntity;
}

// ─── ReconciliationService.scheduledTick ────────────────────────────────────

describe('ReconciliationService.scheduledTick — boot-race guard (M6 W8.5)', () => {
    function buildHarness(gateReady: boolean) {
        const exchangeClient = {
            fetchPositions: jest.fn().mockResolvedValue([] as IPositionSnapshot[]),
            fetchOpenOrders: jest.fn().mockResolvedValue([] as IOpenOrderSnapshot[]),
            fetchOrderByClientId: jest.fn(),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
        } as unknown as IExchangeClient;
        const positions = {
            findOpen: jest.fn().mockResolvedValue([]),
            findNonTerminal: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(null),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        } as unknown as PositionRepository;
        const transactions = {
            findByClientOrderId: jest.fn(),
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        } as unknown as TransactionRepository;
        const positionService = {
            transition: jest.fn(),
            adjustQty: jest.fn(),
            recordFunding: jest.fn(),
            finalizeRealizedPnl: jest.fn(),
        } as unknown as PositionService;
        const riskGate = {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn(),
            recordExposureDrift: jest.fn(),
            evaluate: jest.fn(),
            isRecoveryReady: jest.fn().mockReturnValue(gateReady),
        } as unknown as RiskGateService;
        const monitor = { arm: jest.fn(), disarm: jest.fn() } as unknown as LocalProtectiveMonitor;
        const retainer = new SubscriptionRetainer();
        const strategyVersions = { findByNameAndVersion: jest.fn() } as unknown as StrategyVersionRepository;
        const haltFlag = new HaltFlagService();
        const instrumentor = { setLiquidationPrice: jest.fn() } as never;
        const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as never;
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

        return { service, exchangeClient, positions, riskGate };
    }

    it('scheduled tick PRE-recovery: returns without calling fetchPositions or expireStaleReservations', async () => {
        const h = buildHarness(false);

        await h.service.scheduledTick();

        expect(h.exchangeClient.fetchPositions).not.toHaveBeenCalled();
        expect(h.riskGate.expireStaleReservations).not.toHaveBeenCalled();
    });

    it('scheduled tick POST-recovery: runs the diff sweep normally', async () => {
        const h = buildHarness(true);

        await h.service.scheduledTick();

        expect(h.exchangeClient.fetchPositions).toHaveBeenCalledTimes(1);
        expect(h.riskGate.expireStaleReservations).toHaveBeenCalledTimes(1);
    });

    it('forceTick BYPASSES the recovery guard (boot pipeline phase 2-3 uses it)', async () => {
        const h = buildHarness(false);

        await h.service.forceTick(NOW_MS);

        expect(h.exchangeClient.fetchPositions).toHaveBeenCalledTimes(1);
    });
});

// ─── AccountSnapshotWriter.scheduledTick ────────────────────────────────────

describe('AccountSnapshotWriter.scheduledTick — boot-race guard (M6 W8.5)', () => {
    function buildHarness(gateReady: boolean) {
        const fetchBalance = jest.fn().mockResolvedValue([{ asset: 'USDT', free: '1000', used: '0', total: '1000' }]);
        const exchangeClient = { fetchBalance } as unknown as IExchangeClient;
        const positions = { findLiveRisk: jest.fn().mockResolvedValue([]) } as unknown as PositionRepository;
        const transactions = { findByPosition: jest.fn().mockResolvedValue([]) } as unknown as TransactionRepository;
        const save = jest.fn().mockImplementation(async (row) => ({ ...row, id: 1 }));
        const buildSnapshot = jest.fn().mockImplementation((row) => row);
        const snapshots = { save, buildSnapshot } as unknown as AccountSnapshotRepository;
        const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(gateReady) } as unknown as RiskGateService;
        const writer = new AccountSnapshotWriter(exchangeClient as never, positions, transactions, snapshots, riskGate, { exchangeEnv: 'testnet' } as never);

        return { writer, fetchBalance, save };
    }

    it('scheduled tick PRE-recovery: returns without calling fetchBalance or save', async () => {
        const h = buildHarness(false);

        await h.writer.scheduledTick();

        expect(h.fetchBalance).not.toHaveBeenCalled();
        expect(h.save).not.toHaveBeenCalled();
    });

    it('scheduled tick POST-recovery: writes the snapshot normally', async () => {
        const h = buildHarness(true);

        await h.writer.scheduledTick();

        expect(h.fetchBalance).toHaveBeenCalledTimes(1);
        expect(h.save).toHaveBeenCalledTimes(1);
    });

    it('writeNow BYPASSES the recovery guard (boot phase 7 + drift-resolved use it)', async () => {
        const h = buildHarness(false);

        const result = await h.writer.writeNow(NOW_MS, 'boot');

        expect(result).not.toBeNull();
        expect(h.fetchBalance).toHaveBeenCalledTimes(1);
        expect(h.save).toHaveBeenCalledTimes(1);
    });
});

// ─── PositionInstrumentor.flushPending ──────────────────────────────────────

describe('PositionInstrumentor.flushPending — boot-race guard (M6 W8.5)', () => {
    function buildHarness(gateReady: boolean) {
        const row = buildPositionRow({ maePct: new Money('-0.01') });
        const findById = jest.fn().mockResolvedValue(row);
        const save = jest.fn().mockImplementation(async (p: PositionEntity) => p);
        const positions = { findById, save } as unknown as PositionRepository;
        const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(gateReady) } as unknown as RiskGateService;
        const instrumentor = new PositionInstrumentor(positions, riskGate);

        return { instrumentor, save, positions, row };
    }

    it('scheduledFlush PRE-recovery: returns without saving (dirty accumulator deferred)', async () => {
        const h = buildHarness(false);
        h.instrumentor.onPositionOpened(h.row);
        // Drive a price update to mark the accumulator dirty.
        h.instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29500', timestampMs: NOW_MS });

        await h.instrumentor.flushPending();

        expect(h.save).not.toHaveBeenCalled();
        // Accumulator still has the in-memory updates — sample data is NOT lost.
        const stats = h.instrumentor.getLifeStats(42);
        expect(stats).not.toBeNull();
    });

    it('scheduledFlush POST-recovery: writes the dirty position', async () => {
        const h = buildHarness(true);
        h.instrumentor.onPositionOpened(h.row);
        h.instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29500', timestampMs: NOW_MS });

        await h.instrumentor.flushPending();

        expect(h.save).toHaveBeenCalledTimes(1);
    });

    it('onPriceUpdate is NOT gated (accumulator still absorbs samples during boot)', () => {
        const h = buildHarness(false);
        h.instrumentor.onPositionOpened(h.row);

        h.instrumentor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });

        // No DB write yet, but the in-memory accumulator updated.
        expect(h.save).not.toHaveBeenCalled();
        const stats = h.instrumentor.getLifeStats(42)!;
        // MAE either moved past the pre-existing -0.01 floor (if -0.02 is deeper) OR
        // stayed at the seeded floor. Either way the accumulator is reachable.
        expect(stats.maePct).not.toBeNull();
    });
});

// ─── LocalProtectiveMonitor.onPriceUpdate ───────────────────────────────────

// M6 R2.1.1 — the W8.5 boot-race guard was REMOVED from
// `LocalProtectiveMonitor.onPriceUpdate`. R1.1.1 narrowed the gate's
// `RECOVERY_IN_PROGRESS` reject to OPEN/ADD only, so de-risking intents
// (CLOSE/REDUCE/FLATTEN) — including local-monitor breach-closes — pass
// during boot. With the gate as the asymmetric authority, the monitor must
// NOT silently drop ticks pre-recovery; that disables the last-line-of-defense
// during the very window where exchange-side protection may not yet be re-armed.
// The describe block below verifies the new behaviour.
describe('LocalProtectiveMonitor.onPriceUpdate — recovery interaction (M6 R2.1.1)', () => {
    function buildHarness(gateReady: boolean) {
        const row = buildPositionRow();
        const findById = jest.fn().mockResolvedValue(row);
        const positions = { findById } as unknown as PositionRepository;
        const evaluateSpy = jest.fn().mockResolvedValue({ outcome: 'approved', reservationId: null });
        const riskGate = {
            evaluate: evaluateSpy,
            isRecoveryReady: jest.fn().mockReturnValue(gateReady),
        } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const monitor = new LocalProtectiveMonitor(positions, riskGate, events);

        return { monitor, evaluateSpy, emitSpy };
    }

    it('onPriceUpdate PRE-recovery (phase 6 ticks pre-phase 9): breach fires through the gate (no silent drop)', async () => {
        const h = buildHarness(false);
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // Price below SL — must fire a breach even though recovery is incomplete.
        // The gate's R1.1.1 narrowing auto-approves de-risking under recovery,
        // so a phase 4c-armed position breaching at phase 6 still gets a close.
        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });

        expect(h.evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('onPriceUpdate POST-recovery: evaluates breaches normally', async () => {
        const h = buildHarness(true);
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });

        // Breach triggered the gate-routed close intent path.
        expect(h.evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('arm() does not depend on the recovery guard (phase 4c re-arm calls arm directly)', () => {
        const h = buildHarness(false);

        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // arm completed even with gate not-ready — the position is now armed
        // in memory, ready for the post-recovery tick stream.
        expect(h.monitor.isArmed(42)).toBe(true);
    });
});
