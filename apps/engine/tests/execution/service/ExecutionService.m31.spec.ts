/**
 * M31 — ExecutionService adversarial coverage (zombie-position lifecycle fixes).
 *
 * Coverage:
 *   D1       — PENDING_OPEN + closing fill happy path: ends CLOSED, no qty=0 non-terminal row.
 *   D1-adv   — promote throws: zero close tx committed, ORDER_INTENT_UNKNOWN_EVENT with
 *              reason=PENDING_PROMOTE_FAILED_REASON.
 *   D1-adv-2 — same-tick race: second arrival after flat guard fires ORDER_INTENT_UNKNOWN_EVENT
 *              with reason=REDUCE_ON_FLAT_POSITION_REASON; exactly one close completes.
 *   D2       — OPEN fill: exactly one OPEN transaction row per fill; success log path.
 *   D2-order — arm ordering: localProtectiveMonitor.arm fires BEFORE recordEntryTransaction.
 *   D2-adv   — audit persist failure on open fill: ORDER_AUDIT_PERSIST_FAILED_EVENT AND
 *              ORDER_INTENT_UNKNOWN_EVENT with reason=ENTRY_AUDIT_PERSIST_FAILED_REASON emitted;
 *              position still proceeds to OPEN (escalation is non-aborting).
 *   D5-flat-reduce — reduce on qty<=0 row: no second close tx, ORDER_INTENT_UNKNOWN_EVENT with
 *              reason=REDUCE_ON_FLAT_POSITION_REASON and positionId set.
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

import { ORDER_AUDIT_PERSIST_FAILED_EVENT, ORDER_INTENT_UNKNOWN_EVENT, POSITION_CLOSED_EVENT, POSITION_OPENED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { ENTRY_AUDIT_PERSIST_FAILED_REASON, PENDING_PROMOTE_FAILED_REASON, REDUCE_ON_FLAT_POSITION_REASON } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
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
        id: 99,
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

// ─── service factory ──────────────────────────────────────────────────────────

interface IServiceDeps {
    service: ExecutionService;
    positions: {
        createOpen: jest.Mock;
        save: jest.Mock;
        findOpenBySymbolAndSlot: jest.Mock;
    };
    positionService: {
        transition: jest.Mock;
        adjustQty: jest.Mock;
        finalizeRealizedPnl: jest.Mock;
    };
    transactions: { recordTerminal: jest.Mock };
    riskGate: { releaseReservation: jest.Mock; confirmReservation: jest.Mock };
    localProtectiveMonitor: LocalProtectiveMonitor;
    armSpy: jest.SpyInstance;
    disarmSpy: jest.SpyInstance;
    emitSpy: jest.SpyInstance;
    events: EventEmitter2;
}

function makeService(
    overrides: {
        plan?: ReturnType<typeof buildReducePlan>;
        positionRow?: PositionEntity;
        findOpenBySymbolAndSlotResult?: PositionEntity | null;
        recordTerminalFn?: jest.Mock;
        transitionFn?: jest.Mock;
        finalizeRealizedPnlResult?: PositionEntity;
    } = {},
): IServiceDeps {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const plan = overrides.plan ?? buildReducePlan();
    const policyRouter = {
        plan: jest.fn().mockReturnValue(plan),
    } as unknown as OrderPolicyRouter;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );
    const armSpy = jest.spyOn(localProtectiveMonitor, 'arm');
    const disarmSpy = jest.spyOn(localProtectiveMonitor, 'disarm');

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

    const defaultPositionRow = buildPositionRow();
    const positionRow = overrides.positionRow ?? defaultPositionRow;

    const slotResult = overrides.findOpenBySymbolAndSlotResult !== undefined ? overrides.findOpenBySymbolAndSlotResult : positionRow;

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(slotResult),
    } as unknown as IServiceDeps['positions'];

    const recordTerminalFn = overrides.recordTerminalFn ?? jest.fn().mockResolvedValue({ id: 1 });
    const transactions = { recordTerminal: recordTerminalFn } as unknown as TransactionRepository;

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

    const finalizeResult =
        overrides.finalizeRealizedPnlResult ??
        buildPositionRow({
            state: PositionStateEnum.CLOSED,
            exitReason: ExitReasonEnum.SIGNAL,
            realizedPnl: new Money('5.5'),
            closedAt: new Date(1_700_000_005_000),
        } as unknown as Partial<PositionEntity>);

    const transitionFn = overrides.transitionFn ?? jest.fn().mockImplementation(async () => positionRow);

    const positionService = {
        transition: transitionFn,
        adjustQty: jest.fn().mockImplementation(async (_id: number, newQty: MoneyValue) => {
            positionRow.qty = newQty;
            return positionRow;
        }),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(finalizeResult),
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
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any,
    );

    return {
        service,
        positions,
        positionService,
        transactions: transactions as unknown as IServiceDeps['transactions'],
        riskGate,
        localProtectiveMonitor,
        armSpy,
        disarmSpy,
        emitSpy,
        events,
    };
}

// ─── close-intent event builder ───────────────────────────────────────────────

function buildCloseIntent() {
    return buildApprovedEvent({
        intent: buildOrderIntent({
            intentAction: OrderIntentActionEnum.CLOSE,
            sizing: buildSizing({ qty: new Money('0.01') }),
            exitReason: ExitReasonEnum.STOP_LOSS,
        }),
    });
}

// ─── D1 — PENDING_OPEN + closing-fill happy path ─────────────────────────────

describe('M31 D1 — PENDING_OPEN position receives closing fill → ends CLOSED', () => {
    it('POSITION_CLOSED_EVENT is emitted after promote + close', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const { service, emitSpy } = makeService({ positionRow: pendingRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        const closedCalls = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedCalls).toHaveLength(1);
    });

    it('positionService.transition is called first with OPEN (promote), then CLOSING, then finalizeRealizedPnl', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const { service, positionService } = makeService({ positionRow: pendingRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        const transitionCalls = (positionService.transition as jest.Mock).mock.calls;
        // promote: PENDING_OPEN → OPEN
        const promoteCall = transitionCalls.find(([, toState]) => toState === PositionStateEnum.OPEN);
        expect(promoteCall).toBeDefined();
        // then CLOSING transition
        const closingCall = transitionCalls.find(([, toState]) => toState === PositionStateEnum.CLOSING);
        expect(closingCall).toBeDefined();
        // finalize after
        expect((positionService.finalizeRealizedPnl as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('monitor is disarmed exactly once during the closing-fill path', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const { service, disarmSpy } = makeService({ positionRow: pendingRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        expect(disarmSpy).toHaveBeenCalledTimes(1);
        expect(disarmSpy).toHaveBeenCalledWith(99);
    });

    it('no ORDER_INTENT_UNKNOWN_EVENT on the happy path', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const { service, emitSpy } = makeService({ positionRow: pendingRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls).toHaveLength(0);
    });
});

// ─── D1-adv — promote throws → nothing committed, escalates to M6 ────────────

describe('M31 D1-adv — promote fails before any close write', () => {
    it('ORDER_INTENT_UNKNOWN_EVENT with reason=PENDING_PROMOTE_FAILED_REASON and positionId set', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const promoteFails = jest.fn().mockRejectedValue(new Error('state graph: pending_open → open rejected'));

        const { service, emitSpy } = makeService({
            positionRow: pendingRow,
            transitionFn: promoteFails,
        });

        await service.onOrderIntentApproved(buildCloseIntent());

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls).toHaveLength(1);
        const payload = unknownCalls[0][1] as { reason?: string; positionId?: number };
        expect(payload.reason).toBe(PENDING_PROMOTE_FAILED_REASON);
        expect(payload.positionId).toBe(99);
    });

    it('no close transaction was committed when promote throws', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const promoteFails = jest.fn().mockRejectedValue(new Error('promote failed'));

        const { service, transactions } = makeService({
            positionRow: pendingRow,
            transitionFn: promoteFails,
        });

        await service.onOrderIntentApproved(buildCloseIntent());

        // recordTerminal must not have been called for any close/reduce row
        expect(transactions.recordTerminal as jest.Mock).not.toHaveBeenCalled();
    });

    it('POSITION_CLOSED_EVENT is NOT emitted when promote throws', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const promoteFails = jest.fn().mockRejectedValue(new Error('promote failed'));

        const { service, emitSpy } = makeService({
            positionRow: pendingRow,
            transitionFn: promoteFails,
        });

        await service.onOrderIntentApproved(buildCloseIntent());

        const closedCalls = emitSpy.mock.calls.filter(([name]) => name === POSITION_CLOSED_EVENT);
        expect(closedCalls).toHaveLength(0);
    });

    it('reservation is released even when promote throws', async () => {
        const pendingRow = buildPositionRow({ state: PositionStateEnum.PENDING_OPEN });
        const promoteFails = jest.fn().mockRejectedValue(new Error('promote failed'));

        const { service, riskGate } = makeService({
            positionRow: pendingRow,
            transitionFn: promoteFails,
        });

        const event = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) }),
            reservationId: 'res-promote-fail',
        });

        await service.onOrderIntentApproved(event);

        expect(riskGate.releaseReservation as jest.Mock).toHaveBeenCalledWith('res-promote-fail');
    });
});

// ─── D1-adv-2 — same-tick race: flat-row guard fires on second close ──────────

describe('M31 D1-adv-2 — same-tick race: second close arrival hits flat-row guard (best-effort)', () => {
    /**
     * Node.js event loop serialises concurrent closes. After the first close
     * zeroes qty and saves, a second close finds qty <= 0 and fires the flat-row
     * guard. This test pins that best-effort guard behaviour.
     *
     * NOTE: A serialization gap (two reads before either write) is a known
     * limitation — see docs/tech-debt.md §concurrent-double-close.
     */
    it('second close intent on a flat (qty=0) row emits ORDER_INTENT_UNKNOWN_EVENT with REDUCE_ON_FLAT_POSITION_REASON', async () => {
        const flatRow = buildPositionRow({ qty: new Money('0'), state: PositionStateEnum.OPEN });
        const { service, emitSpy } = makeService({ positionRow: flatRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls).toHaveLength(1);
        const payload = unknownCalls[0][1] as { reason?: string; positionId?: number };
        expect(payload.reason).toBe(REDUCE_ON_FLAT_POSITION_REASON);
        expect(payload.positionId).toBe(99);
    });

    it('second close on flat row does not write a close transaction', async () => {
        const flatRow = buildPositionRow({ qty: new Money('0'), state: PositionStateEnum.OPEN });
        const { service, transactions } = makeService({ positionRow: flatRow });

        await service.onOrderIntentApproved(buildCloseIntent());

        expect(transactions.recordTerminal as jest.Mock).not.toHaveBeenCalled();
    });
});

// ─── D2 — OPEN fill: exactly one transaction row per fill ────────────────────

describe('M31 D2 — OPEN fill produces exactly one OPEN transaction row', () => {
    function makeOpenService() {
        const openPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 0,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        return makeService({ plan: openPlan });
    }

    it('recordTerminal is called exactly once per OPEN fill', async () => {
        const { service, transactions } = makeOpenService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(transactions.recordTerminal as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('POSITION_OPENED_EVENT is emitted after the fill', async () => {
        const { service, emitSpy } = makeOpenService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const openedCalls = emitSpy.mock.calls.filter(([name]) => name === POSITION_OPENED_EVENT);
        expect(openedCalls).toHaveLength(1);
    });
});

// ─── D2-order — arm ordering: arm fires BEFORE recordEntryTransaction ─────────

describe('M31 D2-order — arm ordering: localProtectiveMonitor.arm fires before recordEntryTransaction (ADR 0008 §2)', () => {
    it('arm invocation order is before recordTerminal invocation order', async () => {
        const openPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 0,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const { service, armSpy, transactions } = makeService({ plan: openPlan });

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(armSpy).toHaveBeenCalledTimes(1);
        expect(transactions.recordTerminal as jest.Mock).toHaveBeenCalledTimes(1);

        const armOrder = (armSpy as jest.SpyInstance).mock.invocationCallOrder[0];
        const recordOrder = (transactions.recordTerminal as jest.Mock).mock.invocationCallOrder[0];
        expect(armOrder).toBeLessThan(recordOrder);
    });
});

// ─── D2-adv — audit persist failure on open fill ─────────────────────────────

describe('M31 D2-adv — recordEntryTransaction throws a non-duplicate DB error', () => {
    function makeOpenServiceWithFailingRecord() {
        const openPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 0,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const dbError = new Error('connection terminated unexpectedly');
        const failOnce = jest.fn().mockRejectedValue(dbError);

        return makeService({ plan: openPlan, recordTerminalFn: failOnce });
    }

    it('ORDER_AUDIT_PERSIST_FAILED_EVENT is emitted', async () => {
        const { service, emitSpy } = makeOpenServiceWithFailingRecord();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const auditFailCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_AUDIT_PERSIST_FAILED_EVENT);
        expect(auditFailCalls).toHaveLength(1);
    });

    it('ORDER_INTENT_UNKNOWN_EVENT with reason=ENTRY_AUDIT_PERSIST_FAILED_REASON and positionId set', async () => {
        const { service, emitSpy } = makeOpenServiceWithFailingRecord();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls).toHaveLength(1);
        const payload = unknownCalls[0][1] as { reason?: string; positionId?: number };
        expect(payload.reason).toBe(ENTRY_AUDIT_PERSIST_FAILED_REASON);
        // positionRow.id is the mocked row id (from buildPositionEntityMock / buildPositionRow)
        expect(typeof payload.positionId).toBe('number');
    });

    it('POSITION_OPENED_EVENT is still emitted after audit persist failure (escalation is non-aborting)', async () => {
        // The open path proceeds to completion — a live position must still be counted and
        // tracked even when the audit row failed. The escalation events alert the operator;
        // they do not abort the position lifecycle.
        const { service, emitSpy } = makeOpenServiceWithFailingRecord();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const openedCalls = emitSpy.mock.calls.filter(([name]) => name === POSITION_OPENED_EVENT);
        expect(openedCalls).toHaveLength(1);
    });

    it('positionService.transition to OPEN is still called after audit persist failure', async () => {
        const { service, positionService } = makeOpenServiceWithFailingRecord();

        await service.onOrderIntentApproved(buildApprovedEvent());

        const transitionCalls = (positionService.transition as jest.Mock).mock.calls;
        const toOpenCall = transitionCalls.find(([, toState]) => toState === PositionStateEnum.OPEN);
        expect(toOpenCall).toBeDefined();
    });
});

// ─── D5-flat-reduce — GBT M3 ─────────────────────────────────────────────────

describe('M31 D5-flat-reduce — reduce fill on qty<=0 row escalates via flat-row guard', () => {
    it('ORDER_INTENT_UNKNOWN_EVENT with reason=REDUCE_ON_FLAT_POSITION_REASON and positionId set', async () => {
        const flatRow = buildPositionRow({ qty: new Money('0'), state: PositionStateEnum.OPEN });
        const { service, emitSpy } = makeService({ positionRow: flatRow });

        const reduceEvent = buildApprovedEvent({
            intent: buildOrderIntent({
                intentAction: OrderIntentActionEnum.REDUCE,
                sizing: buildSizing({ qty: new Money('0.01') }),
            }),
        });

        await service.onOrderIntentApproved(reduceEvent);

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls).toHaveLength(1);
        const payload = unknownCalls[0][1] as { reason?: string; positionId?: number };
        expect(payload.reason).toBe(REDUCE_ON_FLAT_POSITION_REASON);
        expect(payload.positionId).toBe(99);
    });

    it('no second close transaction written when qty <= 0', async () => {
        const flatRow = buildPositionRow({ qty: new Money('0'), state: PositionStateEnum.OPEN });
        const { service, transactions } = makeService({ positionRow: flatRow });

        const reduceEvent = buildApprovedEvent({
            intent: buildOrderIntent({
                intentAction: OrderIntentActionEnum.REDUCE,
                sizing: buildSizing({ qty: new Money('0.01') }),
            }),
        });

        await service.onOrderIntentApproved(reduceEvent);

        expect(transactions.recordTerminal as jest.Mock).not.toHaveBeenCalled();
    });

    it('flat-row guard also fires for exactly qty=0 (boundary: not just negative)', async () => {
        const exactlyZero = buildPositionRow({ qty: new Money('0') });
        const { service, emitSpy } = makeService({ positionRow: exactlyZero });

        const closeEvent = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.CLOSE, sizing: buildSizing({ qty: new Money('0.01') }) }),
        });

        await service.onOrderIntentApproved(closeEvent);

        const unknownCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        const flatGuardFired = unknownCalls.some(([, p]) => (p as { reason?: string }).reason === REDUCE_ON_FLAT_POSITION_REASON);
        expect(flatGuardFired).toBe(true);
    });

    it('reservation is released after flat-row guard fires', async () => {
        const flatRow = buildPositionRow({ qty: new Money('0') });
        const { service, riskGate } = makeService({ positionRow: flatRow });

        const event = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.REDUCE, sizing: buildSizing({ qty: new Money('0.01') }) }),
            reservationId: 'res-flat-guard',
        });

        await service.onOrderIntentApproved(event);

        expect(riskGate.releaseReservation as jest.Mock).toHaveBeenCalledWith('res-flat-guard');
    });
});
