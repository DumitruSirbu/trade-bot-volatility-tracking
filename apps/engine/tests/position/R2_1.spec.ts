/**
 * R2.1 paired tests — fail-before / pass-after.
 *
 * Coverage:
 *   - R2.1.1 (boot-guard regression): a position armed during phase 4c that
 *     breaches before phase 9 fires exactly one CLOSE intent through the gate.
 *     Pre-fix the W8.5 guard short-circuited every tick pre-recovery; post-fix
 *     the monitor remains the last line of defense throughout boot.
 *   - R2.1 / 2.M.1 (halt breach leak): halt → breach → expired-halted → halt
 *     clears → next price tick re-evaluates and re-fires. Pre-fix
 *     `breachInFlight` stayed set forever; post-fix the expired-halted listener
 *     clears it so the position regains protection once halt lifts.
 *   - R2.1.3 (case-(f) reachability): `ORDER_INTENT_UNKNOWN_EVENT` with a
 *     `positionId` transitions the row to RECONCILING. Pre-fix no production
 *     consumer existed; post-fix the periodic case-(f) tick has live input.
 *   - R2.1.4 (vanished alert loop): MANUAL_ADOPTED_UNMANAGED-vanished detected
 *     at tick 1 emits IPositionAdoptionVanishedEvent; tick 2 (same process)
 *     does NOT re-emit. A fresh ReconciliationService instance (simulating
 *     process restart) re-emits exactly once.
 */

import {
    DriftCaseEnum,
    ExitReasonEnum,
    IPositionAdoptionVanishedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { IOrderIntentUnknownEvent } from '../../src/common/interface';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { SubmitStateEnum } from '../../src/execution/enum';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { POSITION_ADOPTION_VANISHED_EVENT } from '../../src/position/const';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { IOrderIntentApprovedEvent } from '../../src/risk/interface';
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
        ...overrides,
    } as PositionEntity;
}

function getEvents<T>(emitSpy: jest.SpyInstance, eventName: string): T[] {
    return emitSpy.mock.calls.filter(([name]) => name === eventName).map(([, payload]) => payload as T);
}

// ─── R2.1.1 / R2.1 halt-leak — LocalProtectiveMonitor harness ──────────────

interface IMonitorHarness {
    monitor: LocalProtectiveMonitor;
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
    evaluateSpy: jest.Mock;
    isRecoveryReadySpy: jest.Mock;
}

function buildMonitorHarness(opts: { isRecoveryReady?: boolean } = {}): IMonitorHarness {
    const row = buildPositionRow();
    const repository = { findById: jest.fn().mockResolvedValue(row) } as unknown as PositionRepository;
    const evaluateSpy = jest.fn().mockResolvedValue({
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: null,
        clampedExit: null,
        reservationId: null,
    });
    const isRecoveryReadySpy = jest.fn().mockReturnValue(opts.isRecoveryReady ?? true);
    const gate = { evaluate: evaluateSpy, isRecoveryReady: isRecoveryReadySpy } as unknown as RiskGateService;
    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');
    const monitor = new LocalProtectiveMonitor(repository, gate, events, new SharedCloseCoordinator());

    return { monitor, events, emitSpy, evaluateSpy, isRecoveryReadySpy };
}

describe('R2.1.1 — LocalProtectiveMonitor: breach fires during boot recovery (no W8.5 guard)', () => {
    it('phase 4c arm + pre-phase-9 price tick past SL → exactly one CLOSE intent emitted through the gate', async () => {
        // Mid-recovery: arm happens at phase 4c; the price tape (phase 6) starts
        // flowing before phase 9. The gate is recovery-not-ready but R1.1.1
        // narrowed its block to OPEN/ADD only — de-risking passes.
        const h = buildMonitorHarness({ isRecoveryReady: false });
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });

        // The gate was called exactly once with the synthesised CLOSE intent.
        expect(h.evaluateSpy).toHaveBeenCalledTimes(1);
        const approved = getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT);
        expect(approved).toHaveLength(1);
        expect(approved[0].intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(approved[0].intent.exitReason).toBe(ExitReasonEnum.STOP_LOSS);
    });
});

describe('R2.1 / security 2.M.1 — halt-flag breach leak: monitor recovers after halt clears', () => {
    it('halt → breach → expired-halted → halt clears → next price tick re-emits a fresh CLOSE intent', async () => {
        const h = buildMonitorHarness({ isRecoveryReady: true });
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        // Tick 1: breach under halt.
        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });

        const approvedAfterTick1 = getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT);
        expect(approvedAfterTick1).toHaveLength(1);

        // Simulate ExecutionService's halt short-circuit: it releases the
        // reservation and emits ORDER_INTENT_EXPIRED_EVENT with reason='halted'
        // carrying the breach intent's eventId. We call the listener directly
        // rather than via events.emit() — the @OnEvent decorator wiring is set
        // up by the Nest framework at module init, not by a plain `new`
        // constructor call in unit tests (matches the existing pattern for
        // onPositionStateTransitioned in evalLoop.spec.ts).
        const breachEventId = approvedAfterTick1[0].intent.eventId; // local-monitor-breach-42-stop_loss
        h.monitor.onOrderIntentExpired({ eventId: breachEventId, reservationId: null, reason: 'halted' });

        // Tick 2: halt has cleared, price still breached. Pre-fix this was a
        // silent no-op because `breachInFlight` was permanently set; post-fix
        // the expired-halted listener cleared it, so we re-evaluate and re-fire.
        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });

        const approvedAfterTick2 = getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT);
        expect(approvedAfterTick2).toHaveLength(2);
        expect(h.evaluateSpy).toHaveBeenCalledTimes(2);
    });

    it('expired-halted for a non-breach intent (different eventId) does NOT clear in-flight flag', async () => {
        const h = buildMonitorHarness({ isRecoveryReady: true });
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });
        expect(getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT)).toHaveLength(1);

        // Strategy-originated CLOSE expired under halt — different eventId.
        // Must not clear our breach in-flight flag (would re-fire spuriously).
        h.monitor.onOrderIntentExpired({ eventId: 'BTCUSDT:1700000000000', reservationId: null, reason: 'halted' });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });
        // Still exactly one — the in-flight guard for our breach is intact.
        expect(getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT)).toHaveLength(1);
    });

    it('expired with reason=dry_run releases the shared close slot (M33 Fix 1b release table)', async () => {
        const h = buildMonitorHarness({ isRecoveryReady: true });
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });
        const breachEventId = getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT)[0].intent.eventId;

        h.monitor.onOrderIntentExpired({ eventId: breachEventId, reservationId: null, reason: 'dry_run' });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });
        // M33 Fix 1b release table: a dry_run expiry rests no live order, so the shared close
        // slot is released and the next still-breached tick re-emits (exactly-one is enforced
        // by the slot, not by suppressing legitimate re-fires after a no-op terminal).
        expect(getEvents<IOrderIntentApprovedEvent>(h.emitSpy, ORDER_INTENT_APPROVED_EVENT)).toHaveLength(2);
    });
});

// ─── R2.1.3 + R2.1.4 — ReconciliationService harness ─────────────────────────

interface IReconHarness {
    service: ReconciliationService;
    positions: {
        findById: jest.Mock;
        findOpen: jest.Mock;
        findNonTerminal: jest.Mock;
        createOpen: jest.Mock;
        save: jest.Mock;
        findLastClosedBySymbol: jest.Mock;
        updateProtectiveOrderTypeIfState: jest.Mock;
    };
    positionService: { transition: jest.Mock; finalizeRealizedPnl: jest.Mock; recordFunding: jest.Mock; adjustQty: jest.Mock };
    riskGate: { expireStaleReservations: jest.Mock; reconcileClose: jest.Mock };
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
}

function buildReconHarness(opts: { dbPositions?: PositionEntity[]; exchangePositions?: IPositionSnapshot[] } = {}): IReconHarness {
    const dbPositions = opts.dbPositions ?? [];
    const exchangePositions = opts.exchangePositions ?? [];
    const exchangeClient = {
        fetchPositions: jest.fn().mockResolvedValue(exchangePositions),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    };

    const positions = {
        findById: jest.fn().mockImplementation(async (id: number) => dbPositions.find((p) => p.id === id) ?? null),
        findOpen: jest.fn().mockResolvedValue(dbPositions),
        findNonTerminal: jest.fn().mockResolvedValue(dbPositions),
        createOpen: jest.fn(),
        save: jest.fn().mockImplementation(async (e: PositionEntity) => e),
        findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        updateProtectiveOrderTypeIfState: jest.fn().mockResolvedValue(1),
    };

    const transactions = {
        findByClientOrderId: jest.fn().mockResolvedValue(null),
        findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        findLatestByPositionId: jest.fn().mockResolvedValue(null),
    };

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(undefined),
        recordFunding: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockResolvedValue(undefined),
    };

    const riskGate = {
        expireStaleReservations: jest.fn(),
        listActiveReservationSlots: jest.fn().mockReturnValue([]),
        reconcileClose: jest.fn().mockResolvedValue(undefined),
    };

    const monitor = { arm: jest.fn(), disarm: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const strategyVersions = {
        findByNameAndVersion: jest.fn().mockResolvedValue({ id: 7, name: 'manual_adopted', version: 0 }),
    };

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');
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
        new SharedCloseCoordinator(),
    );

    return { service, positions, positionService, riskGate, events, emitSpy };
}

describe('R2.1.3 — ReconciliationService consumes ORDER_INTENT_UNKNOWN_EVENT (case-(f) reachability)', () => {
    it('transitions the row to RECONCILING with eventClass=intent.unknown', async () => {
        const row = buildPositionRow({ id: 42, state: PositionStateEnum.OPEN });
        const h = buildReconHarness({ dbPositions: [row] });

        const payload: IOrderIntentUnknownEvent = {
            eventId: 'BTCUSDT:1700000000000',
            reservationId: 'BTCUSDT:1700000000000:A',
            state: SubmitStateEnum.RECONCILE_REQUIRED,
            reason: 'drift',
            positionId: 42,
        };

        await h.service.onOrderIntentUnknown(payload);

        expect(h.positionService.transition).toHaveBeenCalledTimes(1);
        const [pid, toState, ctx] = h.positionService.transition.mock.calls[0];
        expect(pid).toBe(42);
        expect(toState).toBe(PositionStateEnum.RECONCILING);
        expect(ctx.eventClass).toBe('intent.unknown');
    });

    it('null positionId (OPEN/ADD escalation or missing-position) skips the transition (reservation TTL handles cleanup)', async () => {
        const h = buildReconHarness();

        await h.service.onOrderIntentUnknown({
            eventId: 'BTCUSDT:1700000000000',
            reservationId: 'BTCUSDT:1700000000000:A',
            state: SubmitStateEnum.RECONCILE_REQUIRED,
            positionId: null,
        });

        expect(h.positionService.transition).not.toHaveBeenCalled();
    });

    it('idempotent: row already in RECONCILING is skipped (no double-transition)', async () => {
        const row = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const h = buildReconHarness({ dbPositions: [row] });

        await h.service.onOrderIntentUnknown({
            eventId: 'BTCUSDT:1700000000000',
            reservationId: null,
            state: SubmitStateEnum.RECONCILE_REQUIRED,
            positionId: 42,
        });

        expect(h.positionService.transition).not.toHaveBeenCalled();
    });

    it('row already CLOSED is skipped (no IllegalStateTransitionException, no error log)', async () => {
        const row = buildPositionRow({ id: 42, state: PositionStateEnum.CLOSED });
        const h = buildReconHarness({ dbPositions: [row] });

        await h.service.onOrderIntentUnknown({
            eventId: 'BTCUSDT:1700000000000',
            reservationId: null,
            state: SubmitStateEnum.RECONCILE_REQUIRED,
            positionId: 42,
        });

        expect(h.positionService.transition).not.toHaveBeenCalled();
    });
});

describe('R2.1.4 — adoption-vanished alert dedup (per-process)', () => {
    function buildVanishedHarness(): IReconHarness {
        // DB row says MANUAL_ADOPTED_UNMANAGED on BTCUSDT/long; exchange returns
        // nothing → case-(b) MANUAL_ADOPTED_UNMANAGED-vanished path.
        const row = buildPositionRow({
            id: 42,
            state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED,
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        });

        return buildReconHarness({ dbPositions: [row], exchangePositions: [] });
    }

    it('tick 1 emits IPositionAdoptionVanishedEvent exactly once', async () => {
        const h = buildVanishedHarness();

        const pass = await h.service.forceTick(NOW_MS);

        const vanished = getEvents<IPositionAdoptionVanishedEvent>(h.emitSpy, POSITION_ADOPTION_VANISHED_EVENT);
        expect(vanished).toHaveLength(1);
        expect(vanished[0].positionId).toBe(42);
        expect(pass.driftsByCase[DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE]).toBe(1);
    });

    it('tick 2 in the SAME process does NOT re-emit (per-process dedup)', async () => {
        const h = buildVanishedHarness();

        await h.service.forceTick(NOW_MS);
        await h.service.forceTick(NOW_MS + 30_000);

        const vanished = getEvents<IPositionAdoptionVanishedEvent>(h.emitSpy, POSITION_ADOPTION_VANISHED_EVENT);
        expect(vanished).toHaveLength(1);
    });

    it('a fresh ReconciliationService instance (simulated process restart) re-emits exactly once', async () => {
        const h1 = buildVanishedHarness();
        await h1.service.forceTick(NOW_MS);
        expect(getEvents<IPositionAdoptionVanishedEvent>(h1.emitSpy, POSITION_ADOPTION_VANISHED_EVENT)).toHaveLength(1);

        // Restart: build a brand-new service. The in-memory dedup set was lost
        // with the process; operators get a fresh alert per process (acceptable
        // per the R2.1.4 dispatch's option (c)).
        const h2 = buildVanishedHarness();
        await h2.service.forceTick(NOW_MS + 60_000);
        expect(getEvents<IPositionAdoptionVanishedEvent>(h2.emitSpy, POSITION_ADOPTION_VANISHED_EVENT)).toHaveLength(1);
    });
});
