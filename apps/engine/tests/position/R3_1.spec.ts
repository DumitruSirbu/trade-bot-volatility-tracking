/**
 * R3.1 paired tests — fail-before / pass-after.
 *
 * Coverage:
 *   - 3.1.1 (case-(f) terminal transitions): exchange qty > 0 → RECONCILING → OPEN;
 *     exchange qty == 0 (or no exchange match) → RECONCILING → CLOSED via
 *     finalizeRealizedPnl(RECONCILED_MISSING). Pre-fix the handler only emitted
 *     INTENT_TERMINAL and left the row in RECONCILING forever (slot stuck).
 *   - 3.2.1 (onOrderIntentUnknown idempotency): MANUAL_ADOPTED_UNMANAGED row
 *     does not throw IllegalStateTransitionException.
 *   - 3.2.2 (breach eventId parser): split-from-the-right tolerates a future
 *     ExitReason value with an embedded dash (`time-stop` exemplifies the
 *     class).
 */

import {
    DriftCaseEnum,
    ExitReasonEnum,
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
import { IOpenOrderSnapshot, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
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
        state: PositionStateEnum.RECONCILING,
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
    positions: { findById: jest.Mock };
    positionService: { transition: jest.Mock; finalizeRealizedPnl: jest.Mock };
    riskGate: { reconcileClose: jest.Mock };
    monitor: { arm: jest.Mock; disarm: jest.Mock };
    exchangeClient: { fetchPositions: jest.Mock; fetchOpenOrders: jest.Mock; fetchOrderByClientId: jest.Mock };
    transactions: { findLatestByPositionId: jest.Mock };
}

function buildReconHarness(opts: {
    dbPositions?: PositionEntity[];
    exchangePositions?: IPositionSnapshot[];
    openOrders?: IOpenOrderSnapshot[];
    orderStatus?: string | null;
    clientOrderId?: string | null;
}): IReconHarness {
    const dbPositions = opts.dbPositions ?? [];
    const exchangePositions = opts.exchangePositions ?? [];
    const openOrders = opts.openOrders ?? [];
    const clientOrderId = opts.clientOrderId === null ? null : (opts.clientOrderId ?? 'tbvt-stuck-intent');
    const orderStatus = opts.orderStatus === null ? null : (opts.orderStatus ?? 'filled');

    const exchangeClient = {
        fetchPositions: jest.fn().mockResolvedValue(exchangePositions),
        fetchOpenOrders: jest.fn().mockResolvedValue(openOrders),
        fetchOrderByClientId: jest.fn().mockResolvedValue(orderStatus === null ? null : { status: orderStatus, clientOrderId }),
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
        findLatestByPositionId: jest.fn().mockResolvedValue(clientOrderId === null ? null : { clientOrderId, createdAt: new Date(NOW_MS - 30_000) }),
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

    return { service, positions, positionService, riskGate, monitor, exchangeClient, transactions };
}

describe('R3.1.1 — ReconciliationService case-(f) terminal transitions OUT of RECONCILING (ADR-0010 §1f step 3)', () => {
    it('terminal exchange status + qty > 0 → transitions RECONCILING → OPEN (position survived)', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const exchangePos = buildExchangeSnapshot('0.01'); // exchange still shows the position
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [exchangePos],
            orderStatus: 'filled',
            clientOrderId: 'tbvt-stuck',
        });

        const pass = await h.service.forceTick(NOW_MS);

        // case-(f) counter incremented exactly once.
        expect(pass.driftsByCase[DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]).toBe(1);

        // The position MUST be transitioned out of RECONCILING — the load-bearing
        // assertion. Pre-fix the handler only emitted INTENT_TERMINAL and left
        // the row stuck forever (the blocker).
        expect(h.positionService.transition).toHaveBeenCalledTimes(1);
        const [pid, toState, ctx] = h.positionService.transition.mock.calls[0];
        expect(pid).toBe(42);
        expect(toState).toBe(PositionStateEnum.OPEN);
        expect(ctx.eventClass).toBe('reconciliation.f.intent_terminal.open');

        // Survived path does NOT finalize or release.
        expect(h.positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
        expect(h.riskGate.reconcileClose).not.toHaveBeenCalled();
    });

    it('terminal exchange status + qty == 0 → finalizes RECONCILING → CLOSED with RECONCILED_MISSING', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const exchangePos = buildExchangeSnapshot('0'); // exchange shows zero qty — closed externally
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [exchangePos],
            orderStatus: 'filled',
            clientOrderId: 'tbvt-stuck',
        });

        const pass = await h.service.forceTick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]).toBe(1);

        // Goes through finalizeRealizedPnl → CLOSED in one shot (ADR-0009 §6.1).
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);
        const [pid, exitReason, ctx] = h.positionService.finalizeRealizedPnl.mock.calls[0];
        expect(pid).toBe(42);
        expect(exitReason).toBe(ExitReasonEnum.RECONCILED_MISSING);
        expect(ctx.eventClass).toBe('reconciliation.f.intent_terminal.closed');

        // Symmetric with case-(b) vanish path: disarm monitor + release reservation.
        expect(h.monitor.disarm).toHaveBeenCalledWith(42);
        expect(h.riskGate.reconcileClose).toHaveBeenCalledWith(42, NOW_MS);
    });

    it('vanished-on-exchange (no match at all) is OWNED by case-(b), not case-(f): case-(f) skips to avoid double-finalize', async () => {
        // A RECONCILING row with no exchange match is already covered by
        // case-(b) DB_OPEN_NOT_ON_EXCHANGE, which transitions through
        // finalizeRealizedPnl(RECONCILED_MISSING). Case-(f) must skip to avoid
        // a double-finalize race within a single tick.
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [], // no match at all → case-(b) owns
            orderStatus: 'filled', // would qualify for case-(f) action, but case-(b) ran first
            clientOrderId: 'tbvt-stuck',
        });

        await h.service.forceTick(NOW_MS);

        // Case-(b) fired exactly once — finalize was called once total.
        expect(h.positionService.finalizeRealizedPnl).toHaveBeenCalledTimes(1);
        const [, exitReason, ctx] = h.positionService.finalizeRealizedPnl.mock.calls[0];
        expect(exitReason).toBe(ExitReasonEnum.RECONCILED_MISSING);
        // Case-(b)'s eventClass, NOT case-(f)'s.
        expect(ctx.eventClass).toBe('reconciliation.b.reconciled_missing');

        // No case-(f) `fetchOrderByClientId` round-trip wasted — we skipped
        // before reaching the per-position recheck.
        expect(h.exchangeClient.fetchOrderByClientId).not.toHaveBeenCalled();
    });

    it('anti-loop: a SECOND tick with the same DB+exchange state does not re-fire case-(f) (after-fix transition is permanent)', async () => {
        // First tick: case-(f) fires + transitions row to OPEN.
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const exchangePos = buildExchangeSnapshot('0.01');
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [exchangePos],
            orderStatus: 'filled',
            clientOrderId: 'tbvt-stuck',
        });
        await h.service.forceTick(NOW_MS);
        expect(h.positionService.transition).toHaveBeenCalledTimes(1);

        // Simulate the post-transition DB state: row is now OPEN — case-(f) loop
        // skips it (the `state !== RECONCILING` guard).
        dbRow.state = PositionStateEnum.OPEN;
        await h.service.forceTick(NOW_MS + 30_000);

        // No additional case-(f) transition. (Other handlers — qty-mismatch /
        // protective-drift — may run; that's their normal lane, not the
        // case-(f) loop we just exited.)
        const fTransitions = h.positionService.transition.mock.calls.filter(([, , ctx]) =>
            ((ctx as { eventClass: string }).eventClass ?? '').startsWith('reconciliation.f.intent_terminal'),
        );
        expect(fTransitions).toHaveLength(1);
    });

    it('non-terminal order status still no-ops the transition (the row stays in RECONCILING awaiting resolution)', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.RECONCILING });
        const h = buildReconHarness({
            dbPositions: [dbRow],
            exchangePositions: [buildExchangeSnapshot('0.01')],
            orderStatus: 'open', // still working on the exchange
            clientOrderId: 'tbvt-stuck',
        });

        await h.service.forceTick(NOW_MS);

        // Non-terminal: no transition this tick.
        const fTransitions = h.positionService.transition.mock.calls.filter(([, , ctx]) =>
            ((ctx as { eventClass: string }).eventClass ?? '').startsWith('reconciliation.f.intent_terminal'),
        );
        expect(fTransitions).toHaveLength(0);
        expect(h.positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
    });
});

describe('R3.2.1 — onOrderIntentUnknown is idempotent for MANUAL_ADOPTED_UNMANAGED (no IllegalStateTransitionException)', () => {
    it('MANUAL_ADOPTED_UNMANAGED row → skip without throw; no transition attempted', async () => {
        const dbRow = buildPositionRow({ id: 42, state: PositionStateEnum.MANUAL_ADOPTED_UNMANAGED });
        const h = buildReconHarness({ dbPositions: [dbRow] });

        const payload: IOrderIntentUnknownEvent = {
            eventId: 'BTCUSDT:1700000000000',
            reservationId: 'BTCUSDT:1700000000000:A',
            state: SubmitStateEnum.RECONCILE_REQUIRED,
            reason: 'drift',
            positionId: 42,
        };

        // Must not throw — and must not attempt the §3-illegal transition
        // MANUAL_ADOPTED_UNMANAGED → RECONCILING.
        await expect(h.service.onOrderIntentUnknown(payload)).resolves.toBeUndefined();
        expect(h.positionService.transition).not.toHaveBeenCalled();
    });
});

// ─── R3.2.2 — LocalProtectiveMonitor breach-eventId parser ──────────────────

describe('R3.2.2 — LocalProtectiveMonitor.extractPositionIdFromBreachEventId tolerates dashes in the exitReason suffix', () => {
    // The parser is private. We exercise it via the public surface: arm a
    // breach, capture the deterministic eventId, then call onOrderIntentExpired
    // and observe the in-flight clear (the load-bearing post-clear behaviour).
    // For the dash-tolerance assertion we feed a synthesised expired-halted
    // event whose eventId mimics a future enum value with a dash in it.

    function buildMonitorHarness() {
        const row = buildPositionRow({ state: PositionStateEnum.OPEN });
        const repository = { findById: jest.fn().mockResolvedValue(row) } as unknown as PositionRepository;
        const evaluateSpy = jest.fn().mockResolvedValue({
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            approvedSlot: PositionSlotEnum.A,
            approvedSizing: null,
            clampedExit: null,
            reservationId: null,
        });
        const gate = { evaluate: evaluateSpy, isRecoveryReady: jest.fn().mockReturnValue(true) } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const emitSpy = jest.spyOn(events, 'emit');
        const monitor = new LocalProtectiveMonitor(repository, gate, events, new SharedCloseCoordinator());

        return { monitor, evaluateSpy, emitSpy };
    }

    function getApproved(emitSpy: jest.SpyInstance): IOrderIntentApprovedEvent[] {
        return emitSpy.mock.calls.filter(([n]) => n === ORDER_INTENT_APPROVED_EVENT).map(([, p]) => p as IOrderIntentApprovedEvent);
    }

    it('today: real breach eventId `local-monitor-breach-42-stop_loss` still resolves to positionId=42 after the lastIndexOf switch', async () => {
        const h = buildMonitorHarness();
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });
        const breach1 = getApproved(h.emitSpy);
        expect(breach1).toHaveLength(1);
        expect(breach1[0].intent.eventId).toBe('local-monitor-breach-42-stop_loss');

        // expired-halted with this exact eventId must clear the in-flight flag
        // so a subsequent tick re-evaluates. Same regression coverage as R2.1,
        // re-asserted under the new parser to prove no behaviour regression.
        h.monitor.onOrderIntentExpired({ eventId: breach1[0].intent.eventId, reservationId: null, reason: 'halted' });

        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });
        expect(getApproved(h.emitSpy)).toHaveLength(2);
    });

    it('future-proof: a synthesised breach eventId with a dash in the suffix (e.g. `local-monitor-breach-12-time-stop`) parses positionId=12', async () => {
        const h = buildMonitorHarness();
        // Manually arm position 12 + set in-flight by walking the public path so
        // the eventId becomes `local-monitor-breach-12-stop_loss` first. Then we
        // exercise the parser with a synthesised id mimicking the future
        // dash-containing enum: the listener clears OUR (positionId=12) in-flight.
        h.monitor.arm({
            positionId: 12,
            symbol: 'ETHUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('2000'),
            takeProfitPrice: new Money('2200'),
        });
        await h.monitor.onPriceUpdate({ symbol: 'ETHUSDT', price: '1900', timestampMs: NOW_MS });
        const fired = getApproved(h.emitSpy);
        expect(fired).toHaveLength(1);

        // Pre-R3.2.2 (first-dash) this synthesised id would parse positionId="12"
        // out of "12-time" → NaN → null → no clear → in-flight stuck.
        // Post-R3.2.2 (last-dash) it parses positionId=12 correctly.
        h.monitor.onOrderIntentExpired({ eventId: 'local-monitor-breach-12-time-stop', reservationId: null, reason: 'halted' });

        // The clear took effect: a subsequent breach tick re-fires.
        await h.monitor.onPriceUpdate({ symbol: 'ETHUSDT', price: '1900', timestampMs: NOW_MS + 1_000 });
        expect(getApproved(h.emitSpy)).toHaveLength(2);
    });

    it('malformed eventId without a dash in the suffix (`local-monitor-breach-42`) is ignored (no crash, no clear)', async () => {
        const h = buildMonitorHarness();
        h.monitor.arm({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            stopLossPrice: new Money('29500'),
            takeProfitPrice: new Money('31000'),
        });
        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS });
        expect(getApproved(h.emitSpy)).toHaveLength(1);

        // Bad id format — parser returns null and the listener no-ops.
        h.monitor.onOrderIntentExpired({ eventId: 'local-monitor-breach-42', reservationId: null, reason: 'halted' });

        // In-flight not cleared → next tick still suppressed by the idempotency
        // guard. Exactly one breach event total.
        await h.monitor.onPriceUpdate({ symbol: 'BTCUSDT', price: '29400', timestampMs: NOW_MS + 1_000 });
        expect(getApproved(h.emitSpy)).toHaveLength(1);
    });
});

// Silence unused-import noise — OrderIntentActionEnum is used implicitly via the
// breach intent's tradeSide/intentAction. Reference here keeps the import.
void OrderIntentActionEnum;
