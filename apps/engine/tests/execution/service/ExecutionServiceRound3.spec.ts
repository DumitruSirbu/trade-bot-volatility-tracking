/**
 * ExecutionService / TransactionRepository / PositionRepository / LocalProtectiveMonitor
 * — round-3 coverage (ADR 0006 §4 extended taxonomy + ADR 0007 §4 reduce-family routing
 *   + ADR 0008 §2 arm ordering + transient repository fixes).
 *
 * Coverage:
 *   1. REDUCE_MARKET budget-exhaust → RECONCILE_REQUIRED with non-null fillSummary:
 *      position qty decremented, one REDUCE transaction row written,
 *      ORDER_INTENT_UNKNOWN_EVENT emitted, reservation released.
 *   2. REDUCE_MARKET full miss (CANCELLED + null fillSummary) → ORDER_INTENT_UNKNOWN_EVENT
 *      (not EXPIRED) regardless of submit state.
 *   3. CLOSE partial exhaust → same escalation as #1.
 *   4. FLATTEN partial exhaust → same escalation as #1.
 *   5. LocalProtectiveMonitor.arm ordering: createOpen returns → arm → recordTerminal
 *      awaited → attach awaited (no await between createOpen and arm).
 *   6. Halt mid-resolveReduceTerminal: recursion stops, returns CANCELLED + current
 *      fillSummary, executeLive routes to ORDER_INTENT_UNKNOWN_EVENT (via handleReduceTerminal).
 *   7. TransactionRepository.isUniqueViolation SQLSTATE:
 *      driverError.code '23505' → true; message substring only → false.
 *   8. findOpenBySymbolAndSlot: two slots same symbol — applyAddToExistingPosition
 *      finds the slot the gate approved, not the first open row.
 *   9. ORDER_AUDIT_PERSIST_FAILED_EVENT in live mode: recordZeroFillAuditRow throws →
 *      event emitted; in dry-run only warn-level, no event.
 *  10. Extended reject taxonomy: -4045, -4060, -4061, -4400 classified TERMINAL;
 *      runSubmitStateMachine short-circuits to ABORTED without retry.
 */

import { OrderIntentActionEnum, OrderPolicyEnum, PositionSideEnum, PositionSlotEnum, StrategyDirectionEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QueryFailedError } from 'typeorm';

import { ORDER_AUDIT_PERSIST_FAILED_EVENT, ORDER_INTENT_EXPIRED_EVENT, ORDER_INTENT_FAILED_EVENT, ORDER_INTENT_UNKNOWN_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { BINANCE_REJECT_CLASSIFICATION, MAX_REDUCE_REMAINDER_ATTEMPTS } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { TransactionRepository } from '../../../src/position/repository/TransactionRepository';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildOrderIntent, buildSizing } from '../../risk/support/fixtures';
import { buildApprovedEvent, buildExchangeClientMock, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';

jest.useFakeTimers();

// ─── service factory ──────────────────────────────────────────────────────────

interface IServiceDeps {
    appConfig: AppConfigService;
    policyRouter: OrderPolicyRouter;
    clientOrderIdFactory: ClientOrderIdFactory;
    submitter: ExchangeOrderSubmitter;
    fillAccumulator: FillAccumulator;
    protectiveAttacher: ProtectiveOrderAttacher;
    localProtectiveMonitor: LocalProtectiveMonitor;
    positions: jest.Mocked<{
        createOpen: jest.Mock;
        save: jest.Mock;
        findOpenBySymbol: jest.Mock;
        findOpenBySymbolAndSlot: jest.Mock;
    }>;
    positionService: { transition: jest.Mock; adjustQty: jest.Mock };
    transactions: jest.Mocked<{ recordTerminal: jest.Mock }>;
    strategyVersions: StrategyVersionRepository;
    riskGate: jest.Mocked<{ releaseReservation: jest.Mock; confirmReservation: jest.Mock }>;
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
    haltFlag: HaltFlagService;
    service: ExecutionService;
}

function buildReducePlan(overrides: Partial<{ timeoutMs: number }> = {}) {
    return {
        policy: OrderPolicyEnum.REDUCE_MARKET,
        limitPrice: new Money('30000'),
        timeoutMs: overrides.timeoutMs ?? 100,
        slippageCapPct: new Money('0'),
        reduceOnly: true,
    };
}

function makeService(
    overrides: {
        isExecutionLive?: boolean;
        plan?: ReturnType<typeof buildReducePlan>;
        positionRow?: ReturnType<typeof buildPositionEntityMock> & { qty?: MoneyValue; entryPrice?: MoneyValue; entryNotional?: MoneyValue };
        findOpenBySymbolAndSlotResult?: ReturnType<typeof buildPositionEntityMock> | null;
        recordTerminalFn?: jest.Mock;
    } = {},
): IServiceDeps {
    const appConfig = { isExecutionLive: overrides.isExecutionLive ?? true } as AppConfigService;

    const plan = overrides.plan ?? buildReducePlan();
    const policyRouter = { plan: jest.fn().mockReturnValue(plan) } as unknown as OrderPolicyRouter;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
    );
    const haltFlag = new HaltFlagService();

    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();

    const submitter = {
        submit: jest
            .fn()
            .mockResolvedValue({ state: SubmitStateEnum.FILLED, snapshot: buildOrderSnapshot(), rejectClass: null, venueCode: null, venueMessage: null }),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();

    const defaultPositionRow = {
        ...buildPositionEntityMock(99),
        qty: new Money('0.01'),
        entryPrice: new Money('30000'),
        entryNotional: new Money('300'),
    };
    const positionRow = overrides.positionRow ?? defaultPositionRow;

    const findSlotResult = overrides.findOpenBySymbolAndSlotResult !== undefined ? overrides.findOpenBySymbolAndSlotResult : { ...positionRow };

    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
        findOpenBySymbol: jest.fn().mockResolvedValue([positionRow]),
        findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(findSlotResult),
    } as unknown as IServiceDeps['positions'];

    const recordTerminalFn = overrides.recordTerminalFn ?? jest.fn().mockResolvedValue({ id: 1 });
    const transactions = { recordTerminal: recordTerminalFn } as unknown as IServiceDeps['transactions'];

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

    // W4b: applyReduceFillToPosition's partial-reduce path now routes through
    // PositionService.adjustQty instead of mutating the row inline + saving.
    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        adjustQty: jest.fn().mockImplementation(async (_positionId: number, newQty: import('../../../src/common/utils/money').MoneyValue) => {
            if (findSlotResult !== null) {
                (findSlotResult as { qty?: import('../../../src/common/utils/money').MoneyValue }).qty = newQty;
            }

            return findSlotResult;
        }),
    } as unknown as import('../../../src/position/service').PositionService;
    const service = new ExecutionService(
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter,
        fillAccumulator,
        protectiveAttacher,
        localProtectiveMonitor,
        positions as never,
        positionService as never,
        transactions as never,
        strategyVersions,
        riskGate as never,
        haltFlag,
        exchangeClient,
        events,
    );

    return {
        appConfig,
        policyRouter,
        clientOrderIdFactory,
        submitter,
        fillAccumulator,
        protectiveAttacher,
        localProtectiveMonitor,
        positions,
        positionService: positionService as never,
        transactions,
        strategyVersions,
        riskGate,
        events,
        emitSpy,
        haltFlag,
        service,
    };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Wire submit to OPEN on first call, then cancelByClientId returns a partial snapshot. */
function wirePartialAndExhaust(deps: IServiceDeps, partialFilledQty: string = '0.003'): void {
    const partial = buildOrderSnapshot({
        status: 'canceled',
        filled: partialFilledQty,
        remaining: String(0.01 - Number(partialFilledQty)),
        cost: String(Number(partialFilledQty) * 30000),
        average: '30000',
        fee: '0.01',
    });

    deps.fillAccumulator.record(partial);

    (deps.submitter.submit as jest.Mock).mockResolvedValue({
        state: SubmitStateEnum.OPEN,
        snapshot: buildOrderSnapshot({ status: 'open' }),
        rejectClass: null,
        venueCode: null,
        venueMessage: null,
    });

    (deps.submitter.cancelByClientId as jest.Mock).mockResolvedValue(partial);
}

// ─── 1. REDUCE budget-exhaust → RECONCILE_REQUIRED escalation ────────────────

describe('ExecutionService — REDUCE budget-exhaust escalates to ORDER_INTENT_UNKNOWN_EVENT', () => {
    it('partial fill then budget exhausted: qty decremented by filled amount, one transaction row, UNKNOWN event, reservation released', async () => {
        // BUILD
        const deps = makeService({ plan: buildReducePlan({ timeoutMs: 50 }) });
        wirePartialAndExhaust(deps, '0.003');

        const reduceIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent: reduceIntent, reservationId: 'res-exhaust-1' });

        // OPERATE
        const promise = deps.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: position qty decremented via PositionService.adjustQty (W4b — partial-reduce
        // now routes through the service, not a direct positions.save).
        const adjustQtyMock = deps.positionService.adjustQty as jest.Mock;
        expect(adjustQtyMock).toHaveBeenCalled();
        const adjustedQty = adjustQtyMock.mock.calls[0][1] as MoneyValue;
        expect(adjustedQty.toFixed(3)).toBe('0.007'); // 0.01 - 0.003

        // One REDUCE transaction row written
        expect(deps.transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const txArg = (deps.transactions.recordTerminal as jest.Mock).mock.calls[0][0] as { qty: MoneyValue; type: string };
        expect(txArg.qty.toFixed(3)).toBe('0.003');
        expect(txArg.type).toBe('reduce');

        // ORDER_INTENT_UNKNOWN_EVENT emitted
        const unknownCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);

        // Reservation released
        expect(deps.riskGate.releaseReservation).toHaveBeenCalledWith('res-exhaust-1');
    });

    it('budget-exhaust result has non-null fillSummary (partial fill present)', async () => {
        // BUILD: test that RECONCILE_REQUIRED state carries the partial fill through
        const deps = makeService({ plan: buildReducePlan({ timeoutMs: 50 }) });
        wirePartialAndExhaust(deps, '0.005');

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-partial-1' });

        // OPERATE
        const promise = deps.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: transaction recorded (proves non-null fillSummary was applied)
        const txArg = (deps.transactions.recordTerminal as jest.Mock).mock.calls[0][0] as { qty: MoneyValue };
        expect(txArg.qty.greaterThan(0)).toBe(true);
    });
});

// ─── 2. REDUCE full miss (null fillSummary) → ORDER_INTENT_UNKNOWN_EVENT ──────

describe('ExecutionService — REDUCE full-miss routes to ORDER_INTENT_UNKNOWN_EVENT', () => {
    it('CANCELLED + null fillSummary for REDUCE intent → ORDER_INTENT_UNKNOWN_EVENT (not EXPIRED)', async () => {
        // BUILD: submit immediately returns CANCELLED with zero fill
        const cancelledZero = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const deps = makeService();
        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.CANCELLED,
            snapshot: cancelledZero,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });
        deps.fillAccumulator.record(cancelledZero);

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-miss-1' });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: UNKNOWN (not EXPIRED) because not-exiting is the worst outcome
        const unknownCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        const expiredCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_EXPIRED_EVENT);
        expect(unknownCalls.length).toBe(1);
        expect(expiredCalls.length).toBe(0);
    });

    it('no transaction row written when REDUCE has zero fill', async () => {
        // BUILD
        const cancelledZero = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const deps = makeService();
        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.CANCELLED,
            snapshot: cancelledZero,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });
        deps.fillAccumulator.record(cancelledZero);

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: no transaction row (null fillSummary → applyReduceFillToPosition not called)
        expect(deps.transactions.recordTerminal).not.toHaveBeenCalled();
    });
});

// ─── 3. CLOSE partial exhaust → same escalation ───────────────────────────────

describe('ExecutionService — CLOSE partial-exhaust escalates identically to REDUCE', () => {
    it('CLOSE budget-exhausted: ORDER_INTENT_UNKNOWN_EVENT emitted, reservation released', async () => {
        // BUILD: use a tiny fill (0.001) so remainder never reaches <=0 before budget exhaustion
        // (3 attempts × 0.001 fill = 0.003 total, well below the 0.01 intent qty)
        const deps = makeService({ plan: buildReducePlan({ timeoutMs: 50 }) });
        wirePartialAndExhaust(deps, '0.001');

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.CLOSE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-close-exhaust' });

        // OPERATE
        const promise = deps.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: escalated to UNKNOWN
        const unknownCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);
        expect(deps.riskGate.releaseReservation).toHaveBeenCalledWith('res-close-exhaust');
    });
});

// ─── 4. FLATTEN partial exhaust → same escalation ────────────────────────────

describe('ExecutionService — FLATTEN partial-exhaust escalates identically to REDUCE', () => {
    it('FLATTEN budget-exhausted: ORDER_INTENT_UNKNOWN_EVENT emitted, reservation released', async () => {
        // BUILD
        const deps = makeService({ plan: buildReducePlan({ timeoutMs: 50 }) });
        wirePartialAndExhaust(deps, '0.002');

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.FLATTEN,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-flatten-exhaust' });

        // OPERATE
        const promise = deps.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK
        const unknownCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);
        expect(deps.riskGate.releaseReservation).toHaveBeenCalledWith('res-flatten-exhaust');
    });
});

// ─── 5. LocalProtectiveMonitor.arm ordering (ADR 0008 §2) ────────────────────

describe('ExecutionService — LocalProtectiveMonitor.arm ordering (ADR 0008 §2)', () => {
    it('arm is called after createOpen returns and before recordTerminal and attach are awaited', async () => {
        // BUILD: track the sequence of operations using a call log
        const callLog: string[] = [];

        const deps = makeService({
            isExecutionLive: true,
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });

        const positionRow = { ...buildPositionEntityMock(55), qty: new Money('0.01'), entryPrice: new Money('30000'), entryNotional: new Money('300') };

        (deps.positions.createOpen as jest.Mock).mockImplementation(async () => {
            callLog.push('createOpen');
            return positionRow;
        });

        // Spy on arm BEFORE the service call to track it
        const armSpy = jest.spyOn(deps.localProtectiveMonitor, 'arm').mockImplementation((...args) => {
            callLog.push('arm');
            // Call through to real implementation
            return LocalProtectiveMonitor.prototype.arm.call(deps.localProtectiveMonitor, ...args);
        });

        (deps.transactions.recordTerminal as jest.Mock).mockImplementation(async () => {
            callLog.push('recordTerminal');
            return { id: 1 };
        });

        (deps.protectiveAttacher.attach as jest.Mock).mockImplementation(async () => {
            callLog.push('attach');
            return buildExchangeSideAttachResult();
        });

        const filledSnapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
        deps.fillAccumulator.record(filledSnapshot);
        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: filledSnapshot,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        const event = buildApprovedEvent({ intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN }) });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: createOpen → arm → recordTerminal → attach
        expect(callLog).toEqual(['createOpen', 'arm', 'recordTerminal', 'attach']);
        armSpy.mockRestore();
    });
});

// ─── 6. Halt mid-resolveReduceTerminal recursion ──────────────────────────────

describe('ExecutionService — halt mid-reduce-remainder recursion', () => {
    it('halt during remainder recursion: stops at next hop, emits ORDER_INTENT_UNKNOWN_EVENT', async () => {
        // BUILD: first submit OPEN → resolveReduceTerminal → cancel returns partial → would recurse,
        // but halt fires between hops so the second hop detects halt at the top of resolveReduceTerminal.
        const deps = makeService({ plan: buildReducePlan({ timeoutMs: 50 }) });

        const partial = buildOrderSnapshot({
            status: 'canceled',
            filled: '0.005',
            remaining: '0.005',
            cost: '150',
            average: '30000',
            fee: '0.01',
        });
        deps.fillAccumulator.record(partial);

        let submitCount = 0;
        (deps.submitter.submit as jest.Mock).mockImplementation(async () => {
            submitCount += 1;
            if (submitCount === 1) {
                // Trigger halt so the NEXT resolveReduceTerminal recursion sees it
                deps.haltFlag.halt('mid-reduce-halt');
            }
            return { state: SubmitStateEnum.OPEN, snapshot: buildOrderSnapshot({ status: 'open' }), rejectClass: null, venueCode: null, venueMessage: null };
        });

        (deps.submitter.cancelByClientId as jest.Mock).mockResolvedValue(partial);
        // fetchByClientId returns the partial when the halt path probes for current state
        (deps.submitter.fetchByClientId as jest.Mock).mockResolvedValue(partial);

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.REDUCE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent, reservationId: 'res-halt-reduce' });

        // OPERATE
        const promise = deps.service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await promise;

        // CHECK: ORDER_INTENT_UNKNOWN_EVENT emitted (halt stops after partial → not clean fill)
        const unknownCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_UNKNOWN_EVENT);
        expect(unknownCalls.length).toBe(1);

        // Recursion stopped — submit was called only once (halt detected before second hop submits)
        expect(submitCount).toBe(1);
    });
});

// ─── 7. TransactionRepository.isUniqueViolation SQLSTATE ─────────────────────

describe('TransactionRepository — isUniqueViolation SQLSTATE-only check', () => {
    it('QueryFailedError with driverError.code 23505 → treated as unique violation (idempotent no-op)', async () => {
        // BUILD: construct a real TransactionRepository with a mock inner repository
        // that throws a QueryFailedError with SQLSTATE 23505 on save.
        const existingRow = { id: 1, clientOrderId: 'tbvt-existing' };
        const duplicateError = new QueryFailedError('INSERT', [], new Error('unique constraint'));
        const driverErrWith23505 = Object.assign(new Error('unique constraint'), { code: '23505' });
        (duplicateError as QueryFailedError & { driverError: unknown }).driverError = driverErrWith23505;

        const mockInnerRepo = {
            create: jest.fn().mockReturnValue({ id: undefined, clientOrderId: 'tbvt-existing' }),
            save: jest.fn().mockRejectedValue(duplicateError),
            find: jest.fn(),
            findOne: jest.fn().mockResolvedValue(existingRow),
            count: jest.fn(),
            metadata: { name: 'TransactionEntity' },
        };

        const repo = new TransactionRepository(mockInnerRepo as never);

        // OPERATE
        const result = await repo.recordTerminal({ clientOrderId: 'tbvt-existing' });

        // CHECK: no throw — idempotent; returns the existing row
        expect(result).toEqual(existingRow);
        expect(mockInnerRepo.findOne).toHaveBeenCalled();
    });

    it('QueryFailedError with message substring "duplicate key" but no SQLSTATE code → re-thrown (no substring fallback)', async () => {
        // BUILD: the error carries no driverError.code — only a message containing "duplicate key"
        const messageOnlyError = new QueryFailedError('INSERT', [], new Error('duplicate key value violates unique constraint'));
        // driverError present but code absent
        const driverErrMessageOnly = Object.assign(new Error('duplicate key value'), {});
        (messageOnlyError as QueryFailedError & { driverError: unknown }).driverError = driverErrMessageOnly;

        const mockInnerRepo = {
            create: jest.fn().mockReturnValue({}),
            save: jest.fn().mockRejectedValue(messageOnlyError),
            find: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
            metadata: { name: 'TransactionEntity' },
        };

        const repo = new TransactionRepository(mockInnerRepo as never);

        // OPERATE + CHECK: error is NOT swallowed; re-thrown because no SQLSTATE match
        await expect(repo.recordTerminal({ clientOrderId: 'tbvt-new' })).rejects.toThrow();
        // findOne never called (error was not caught as unique violation)
        expect(mockInnerRepo.findOne).not.toHaveBeenCalled();
    });

    it('non-QueryFailedError → re-thrown immediately without touching findOne', async () => {
        // BUILD
        const otherError = new Error('connection timeout');
        const mockInnerRepo = {
            create: jest.fn().mockReturnValue({}),
            save: jest.fn().mockRejectedValue(otherError),
            find: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
            metadata: { name: 'TransactionEntity' },
        };

        const repo = new TransactionRepository(mockInnerRepo as never);

        // OPERATE + CHECK
        await expect(repo.recordTerminal({ clientOrderId: 'tbvt-other' })).rejects.toThrow('connection timeout');
        expect(mockInnerRepo.findOne).not.toHaveBeenCalled();
    });
});

// ─── 8. findOpenBySymbolAndSlot — correct slot under two concurrent slots ─────

describe('ExecutionService — applyAddToExistingPosition uses slot-scoped lookup', () => {
    it('ADD: when two slots hold the same symbol, findOpenBySymbolAndSlot returns the approved-slot row', async () => {
        // BUILD: two position rows for BTCUSDT — one on slot A, one on slot B
        const slotARow = {
            id: 10,
            symbol: 'BTCUSDT',
            positionSlot: PositionSlotEnum.A,
            protectiveOrderType: 'local_fallback',
            qty: new Money('0.01'),
            entryPrice: new Money('30000'),
            entryNotional: new Money('300'),
        };
        const slotBRow = {
            id: 11,
            symbol: 'BTCUSDT',
            positionSlot: PositionSlotEnum.B,
            protectiveOrderType: 'local_fallback',
            qty: new Money('0.02'),
            entryPrice: new Money('29000'),
            entryNotional: new Money('580'),
        };

        // findOpenBySymbolAndSlot returns slotB when called with slot B (gate approved slot B)
        const deps = makeService({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('29500'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
            findOpenBySymbolAndSlotResult: slotBRow as never,
        });

        let savedRow: typeof slotBRow | null = null;
        (deps.positions.save as jest.Mock).mockImplementation(async (row: typeof slotBRow) => {
            savedRow = row;
            return row;
        });

        const addFill = buildOrderSnapshot({ filled: '0.01', average: '29500', cost: '295', fee: '0.1' });
        deps.fillAccumulator.record(addFill);
        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: addFill,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        const addIntent = buildOrderIntent({
            symbol: 'BTCUSDT',
            intentAction: OrderIntentActionEnum.ADD,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({
            intent: addIntent,
            approvedSlot: PositionSlotEnum.B, // gate approved slot B
        });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: findOpenBySymbolAndSlot was called with slot B (not A)
        expect(deps.positions.findOpenBySymbolAndSlot).toHaveBeenCalledWith('BTCUSDT', PositionSlotEnum.B);

        // The saved row must be slot B (id=11), not slot A (id=10)
        expect(savedRow).not.toBeNull();
        expect((savedRow as unknown as { id: number }).id).toBe(11);
    });
});

// ─── 9. ORDER_AUDIT_PERSIST_FAILED_EVENT — live vs dry-run ───────────────────

describe('ExecutionService — ORDER_AUDIT_PERSIST_FAILED_EVENT (recordZeroFillAuditRow failure)', () => {
    it('live mode: recordTerminal throws → ORDER_AUDIT_PERSIST_FAILED_EVENT emitted', async () => {
        // BUILD: zero-fill OPEN intent in live mode; recordTerminal throws on audit insert
        const insertError = new Error('db connection lost');
        const failingRecordTerminal = jest.fn().mockRejectedValue(insertError);

        const deps = makeService({
            isExecutionLive: true,
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
            recordTerminalFn: failingRecordTerminal,
        });

        // Submit returns CANCELLED with zero fill
        const zeroSnap = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        deps.fillAccumulator.record(zeroSnap);
        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.CANCELLED,
            snapshot: zeroSnap,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        const event = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN }),
            reservationId: 'res-audit-live',
        });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: audit-failed event emitted in live mode
        const auditFailedCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_AUDIT_PERSIST_FAILED_EVENT);
        expect(auditFailedCalls.length).toBe(1);
        const [, payload] = auditFailedCalls[0];
        expect((payload as { symbol: string }).symbol).toBe('BTCUSDT');
    });

    it('dry-run mode: recordTerminal throws → NO ORDER_AUDIT_PERSIST_FAILED_EVENT emitted', async () => {
        // BUILD: dry-run mode; recordTerminal throws
        const insertError = new Error('db connection lost');
        const failingRecordTerminal = jest.fn().mockRejectedValue(insertError);

        const deps = makeService({
            isExecutionLive: false,
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
            recordTerminalFn: failingRecordTerminal,
        });

        const event = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN }),
            reservationId: 'res-audit-dry',
        });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: NO audit-failed event in dry-run — only warn-level
        const auditFailedCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_AUDIT_PERSIST_FAILED_EVENT);
        expect(auditFailedCalls.length).toBe(0);
    });
});

// ─── 10. Extended reject taxonomy: -4045, -4060, -4061, -4400 → TERMINAL ─────

describe('BINANCE_REJECT_CLASSIFICATION — extended terminal codes', () => {
    it('-4045 (Insufficient liquidity for IOC) is classified TERMINAL', () => {
        expect(BINANCE_REJECT_CLASSIFICATION['-4045']).toBe('TERMINAL');
    });

    it('-4060 (Margin mode reject) is classified TERMINAL', () => {
        expect(BINANCE_REJECT_CLASSIFICATION['-4060']).toBe('TERMINAL');
    });

    it('-4061 (Position-side reject) is classified TERMINAL', () => {
        expect(BINANCE_REJECT_CLASSIFICATION['-4061']).toBe('TERMINAL');
    });

    it('-4400 (PRICE_FILTER violation) is classified TERMINAL', () => {
        expect(BINANCE_REJECT_CLASSIFICATION['-4400']).toBe('TERMINAL');
    });
});

describe('ExecutionService — TERMINAL reject codes short-circuit to ABORTED without retry', () => {
    const terminalCodes = ['-4045', '-4060', '-4061', '-4400'] as const;

    it.each(terminalCodes)('venue code %s → no second submit attempt, reservation released', async (venueCode) => {
        // BUILD: submit returns REJECTED with TERMINAL class
        const deps = makeService({
            plan: {
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0.15'),
                reduceOnly: false,
            },
        });

        (deps.submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.REJECTED,
            snapshot: null,
            rejectClass: 'TERMINAL',
            venueCode,
            venueMessage: `binance ${venueCode} rejected`,
        });

        const event = buildApprovedEvent({
            intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN }),
            reservationId: `res-terminal-${venueCode}`,
        });

        // OPERATE
        await deps.service.onOrderIntentApproved(event);

        // CHECK: submit called exactly once (no retry on TERMINAL)
        expect(deps.submitter.submit).toHaveBeenCalledTimes(1);

        // ORDER_INTENT_FAILED_EVENT emitted (ABORTED path)
        const failedCalls = deps.emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_FAILED_EVENT);
        expect(failedCalls.length).toBe(1);

        // Reservation released
        expect(deps.riskGate.releaseReservation).toHaveBeenCalledWith(`res-terminal-${venueCode}`);
    });
});
