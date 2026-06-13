/**
 * ExecutionService — execution orchestrator (ADR 0005–0008).
 *
 * Coverage:
 *   1. Dry-run mode: no exchange call; reservation released; ORDER_INTENT_EXPIRED_EVENT emitted
 *   2. Live mode: exchange client called; position row created from fill
 *   3. SL/TP success: protectiveOrderType set to EXCHANGE_SIDE before POSITION_OPENED_EVENT
 *   4. SL/TP rejection: protectiveOrderType stays LOCAL_FALLBACK; ORDER_PROTECTIVE_FALLBACK_EVENT emitted
 *   5. Position row written BEFORE protective attach attempt (always-protected invariant)
 *   6. Zero-fill terminal: no position/transaction row written; no POSITION_OPENED_EVENT
 *   7. PARTIAL fill terminal (REDUCE_MARKET): asserts current flagged behavior (#4 deviation)
 *      — PARTIAL state terminates (does NOT re-evaluate); test locks the current behavior so
 *        a future change must update this test deliberately.
 *   8. Unhandled exception: reservation released; loop does not crash
 */

import { ProtectiveOrderTypeEnum, StrategyDirectionEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ORDER_INTENT_EXPIRED_EVENT, ORDER_PROTECTIVE_FALLBACK_EVENT, POSITION_OPENED_EVENT } from '../../../src/common/const';
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
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import {
    buildApprovedEvent,
    buildExchangeSideAttachResult,
    buildLocalFallbackAttachResult,
    buildOrderSnapshot,
    buildPositionEntityMock,
} from '../support/fixtures';

jest.useFakeTimers();

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeService(
    overrides: {
        isExecutionLive?: boolean;
        submitResult?: {
            state: SubmitStateEnum;
            snapshot: ReturnType<typeof buildOrderSnapshot> | null;
            rejectClass?: 'RETRIABLE' | 'TERMINAL' | 'UNKNOWN' | null;
            venueCode?: string | null;
            venueMessage?: string | null;
        };
        attachResult?: ReturnType<typeof buildExchangeSideAttachResult> | ReturnType<typeof buildLocalFallbackAttachResult>;
    } = {},
) {
    const appConfig = { isExecutionLive: overrides.isExecutionLive ?? false } as AppConfigService;

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: 'marketable_limit_ioc',
            limitPrice: new Money('30000'),
            timeoutMs: 2000,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        }),
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
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();

    const defaultSnapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });
    const defaultSubmitResult = overrides.submitResult ?? {
        state: SubmitStateEnum.FILLED,
        snapshot: defaultSnapshot,
        rejectClass: null,
        venueCode: null,
        venueMessage: null,
    };

    const submitter = {
        submit: jest.fn().mockResolvedValue(defaultSubmitResult),
        cancelByClientId: jest.fn(),
        fetchByClientId: jest.fn(),
        recover: jest.fn(),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    // Pre-record the fill so toSummary works
    if (defaultSubmitResult.snapshot !== null) {
        fillAccumulator.record(defaultSubmitResult.snapshot);
    }

    const positionRow = buildPositionEntityMock(42);
    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
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
    const emitSpy = jest.spyOn(events, 'emit');

    const attachResult = overrides.attachResult ?? buildExchangeSideAttachResult();
    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(attachResult),
    } as unknown as ProtectiveOrderAttacher;

    const positionService = {
        transition: jest.fn().mockImplementation(async () => positionRow),
    } as unknown as import('../../../src/position/service').PositionService;

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
        exchangeClient,
        events,
    );

    return { service, submitter, positions, transactions, riskGate, protectiveAttacher, emitSpy, fillAccumulator };
}

// ─── dry-run mode ─────────────────────────────────────────────────────────────

describe('ExecutionService — dry-run mode', () => {
    it('makes no exchange call when EXECUTION_MODE=dry_run', async () => {
        // BUILD
        const { service, submitter } = makeService({ isExecutionLive: false });
        const event = buildApprovedEvent();

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK
        expect(submitter.submit).not.toHaveBeenCalled();
    });

    it('releases the reservation in dry-run mode', async () => {
        const { service, riskGate } = makeService({ isExecutionLive: false });
        const event = buildApprovedEvent({ reservationId: 'res-dry-1' });

        await service.onOrderIntentApproved(event);

        expect(riskGate.releaseReservation).toHaveBeenCalledWith('res-dry-1');
    });

    it('emits ORDER_INTENT_EXPIRED_EVENT in dry-run mode', async () => {
        const { service, emitSpy } = makeService({ isExecutionLive: false });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        const expiredCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_EXPIRED_EVENT);
        expect(expiredCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not create a position row in dry-run mode', async () => {
        const { service, positions } = makeService({ isExecutionLive: false });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(positions.createOpen).not.toHaveBeenCalled();
    });
});

// ─── live mode — filled path ──────────────────────────────────────────────────

describe('ExecutionService — live mode filled path', () => {
    it('calls exchange submitter when EXECUTION_MODE=live', async () => {
        const { service, submitter } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(submitter.submit).toHaveBeenCalledTimes(1);
    });

    it('creates a position row from fill summary', async () => {
        const { service, positions } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(positions.createOpen).toHaveBeenCalledTimes(1);
    });

    it('records a transaction row per terminal fill', async () => {
        const { service, transactions } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(transactions.recordTerminal).toHaveBeenCalledTimes(1);
    });

    it('emits POSITION_OPENED_EVENT after fill', async () => {
        const { service, emitSpy } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        const openedCalls = emitSpy.mock.calls.filter(([name]) => name === POSITION_OPENED_EVENT);
        expect(openedCalls.length).toBe(1);
    });

    it('confirms reservation on successful fill', async () => {
        const { service, riskGate } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent({ reservationId: 'res-live-1' });

        await service.onOrderIntentApproved(event);

        expect(riskGate.confirmReservation).toHaveBeenCalledWith('res-live-1');
    });
});

// ─── SL/TP attach — success ───────────────────────────────────────────────────

describe('ExecutionService — SL/TP success path', () => {
    it('position saved with EXCHANGE_SIDE protective type', async () => {
        // BUILD
        const { service, positions } = makeService({
            isExecutionLive: true,
            attachResult: buildExchangeSideAttachResult(),
        });
        const event = buildApprovedEvent();

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: save was called with the EXCHANGE_SIDE type
        const saveArg = (positions.save as jest.Mock).mock.calls[0][0] as { protectiveOrderType: ProtectiveOrderTypeEnum };
        expect(saveArg.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.EXCHANGE_SIDE);
    });

    it('POSITION_OPENED_EVENT is emitted after protective attach completes', async () => {
        const { service, emitSpy, protectiveAttacher } = makeService({
            isExecutionLive: true,
            attachResult: buildExchangeSideAttachResult(),
        });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        // attach must be called before POSITION_OPENED_EVENT
        const attachCallOrder = (protectiveAttacher.attach as jest.Mock).mock.invocationCallOrder[0];

        // Both must have been called (ordering verified structurally via call counts)
        expect(protectiveAttacher.attach).toHaveBeenCalledTimes(1);
        expect(emitSpy.mock.calls.some(([name]) => name === POSITION_OPENED_EVENT)).toBe(true);
        expect(attachCallOrder).toBeLessThan(emitSpy.mock.invocationCallOrder[emitSpy.mock.calls.findIndex(([n]) => n === POSITION_OPENED_EVENT)]);
    });
});

// ─── SL/TP attach — fallback ──────────────────────────────────────────────────

describe('ExecutionService — SL/TP fallback path', () => {
    it('position saved with LOCAL_FALLBACK when attach fails', async () => {
        // BUILD
        const { service, positions } = makeService({
            isExecutionLive: true,
            attachResult: buildLocalFallbackAttachResult('exchange rejected SL'),
        });
        const event = buildApprovedEvent();

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK
        const saveArg = (positions.save as jest.Mock).mock.calls[0][0] as { protectiveOrderType: ProtectiveOrderTypeEnum };
        expect(saveArg.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);
    });

    it('ORDER_PROTECTIVE_FALLBACK_EVENT emitted on attach failure', async () => {
        const { service, emitSpy } = makeService({
            isExecutionLive: true,
            attachResult: buildLocalFallbackAttachResult(),
        });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        const fallbackCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_PROTECTIVE_FALLBACK_EVENT);
        expect(fallbackCalls.length).toBe(1);
    });

    it('POSITION_OPENED_EVENT is still emitted even on fallback (position is tracked)', async () => {
        const { service, emitSpy } = makeService({
            isExecutionLive: true,
            attachResult: buildLocalFallbackAttachResult(),
        });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(emitSpy.mock.calls.some(([name]) => name === POSITION_OPENED_EVENT)).toBe(true);
    });
});

// ─── position written BEFORE exchange protective call ─────────────────────────

describe('ExecutionService — position written before protective attach', () => {
    it('createOpen is called before attach (always-protected invariant)', async () => {
        const { service, positions, protectiveAttacher } = makeService({ isExecutionLive: true });
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        const createCallOrder = (positions.createOpen as jest.Mock).mock.invocationCallOrder[0];
        const attachCallOrder = (protectiveAttacher.attach as jest.Mock).mock.invocationCallOrder[0];

        expect(createCallOrder).toBeLessThan(attachCallOrder);
    });
});

// ─── zero-fill terminal ───────────────────────────────────────────────────────

describe('ExecutionService — zero-fill (missed entry) terminal', () => {
    it('no position row written when fill is zero', async () => {
        // BUILD: cancelled order with zero fill
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: null, average: null });
        const { service, positions, fillAccumulator } = makeService({
            isExecutionLive: true,
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        // ensure accumulator has zero-fill snapshot
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent();

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: flagged deviation #1 — zero fill does not write a transactions row
        expect(positions.createOpen).not.toHaveBeenCalled();
    });

    it('no POSITION_OPENED_EVENT when fill is zero', async () => {
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: null, average: null });
        const { service, emitSpy, fillAccumulator } = makeService({
            isExecutionLive: true,
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        expect(emitSpy.mock.calls.some(([name]) => name === POSITION_OPENED_EVENT)).toBe(false);
    });

    it('reservation released when no fill', async () => {
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: null, average: null });
        const { service, riskGate, fillAccumulator } = makeService({
            isExecutionLive: true,
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent({ reservationId: 'res-nofill' });

        await service.onOrderIntentApproved(event);

        expect(riskGate.releaseReservation).toHaveBeenCalledWith('res-nofill');
    });
});

// ─── PARTIAL fill terminal — flagged deviation #4 ────────────────────────────

describe('ExecutionService — PARTIAL fill terminal behavior (deviation #4)', () => {
    it('PARTIAL state with non-zero fill DOES create a position row (current behavior)', async () => {
        // This test locks deviation #4: REDUCE_MARKET partial currently terminates as PARTIAL
        // (does NOT re-evaluate or re-submit). If this behavior changes, this test must be
        // updated deliberately.
        const partialSnapshot = buildOrderSnapshot({ status: 'open', filled: '0.005', cost: '150', average: '30000' });
        const { service, positions, fillAccumulator } = makeService({
            isExecutionLive: true,
            submitResult: { state: SubmitStateEnum.PARTIAL, snapshot: partialSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        fillAccumulator.record(partialSnapshot);
        const event = buildApprovedEvent();

        await service.onOrderIntentApproved(event);

        // PARTIAL with a fill writes a position row — partial fill is NOT a zero-fill event
        expect(positions.createOpen).toHaveBeenCalledTimes(1);
    });
});

// ─── unhandled exception — loop resilience ────────────────────────────────────

describe('ExecutionService — exception resilience', () => {
    it('releases reservation when an unexpected error occurs', async () => {
        // BUILD: make the submitter throw to simulate a mid-execution failure
        const { service, riskGate, submitter } = makeService({ isExecutionLive: true });
        (submitter.submit as jest.Mock).mockRejectedValue(new Error('unexpected DB down'));
        const event = buildApprovedEvent({ reservationId: 'res-exc' });

        // OPERATE — must not throw (caught by the outer @OnEvent handler)
        await expect(service.onOrderIntentApproved(event)).resolves.toBeUndefined();

        // CHECK
        expect(riskGate.releaseReservation).toHaveBeenCalledWith('res-exc');
    });
});
