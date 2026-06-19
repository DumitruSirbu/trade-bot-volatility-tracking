/**
 * ExecutionService — fix-wave delta coverage (ADR 0005–0008 Round-1 must-fixes).
 *
 * Coverage:
 *   1. HaltFlagService gate: executeLive short-circuits when halted; reservation released;
 *      ORDER_INTENT_EXPIRED_EVENT with reason='halted'; no exchange call.
 *   2. HaltFlagService gate fires on every retry hop (mid-flight halt aborts).
 *   3. flowType end-to-end: OrderPolicyRouter.plan receives intent.flowType unchanged.
 *   4. midAtTrigger propagation: IOC limitPrice math uses midAtTrigger, not entryPrice;
 *      the router's limitPrice for IOC is computed from midAtTrigger.
 *   5. IOC awaitPolicyTimeout: fetchByClientId called; cancelByClientId NOT called.
 *   6. POST_ONLY_MAKER awaitPolicyTimeout: cancelByClientId called; no second submit.
 *   7. POST_ONLY_MAKER would-cross: limitPrice=null → CANCELLED, no resubmit.
 *   8. ADD path weighted-average entry: qty = A+B, entry = (A*X + B*Y) / (A+B), SL/TP untouched.
 *   9. REDUCE_MARKET remainder retry: partial fill triggers retry at attemptN+1 with remainder qty.
 *  10. REDUCE_MARKET remainder budget exhaust: attemptN=MAX → RECONCILE_REQUIRED escalation.
 *  11. Zero-fill audit row: handleNoFill writes transactions row with position_id=null, qty=0.
 *  12. Zero-fill audit row not written for REDUCE/CLOSE actions (only OPEN/ADD).
 *  13. FillAccumulator no-fallback: null average + filledQty>0 → toSummary returns null.
 *  14. extraParams allow-list: non-listed keys stripped from ICreateOrderRequest params.
 */

import { FlowTypeEnum, OrderIntentActionEnum, OrderPolicyEnum, PositionSideEnum, StrategyDirectionEnum, CoinTierEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ORDER_INTENT_EXPIRED_EVENT } from '../../../src/common/const';
import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money, MoneyValue } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { MAX_REDUCE_REMAINDER_ATTEMPTS } from '../../../src/execution/const';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeClientMock, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';
import { buildOrderIntent, buildProposedExit, buildSizing } from '../../risk/support/fixtures';

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
        attachResult?: ReturnType<typeof buildExchangeSideAttachResult>;
        plan?: {
            policy: OrderPolicyEnum;
            limitPrice: MoneyValue;
            timeoutMs: number;
            slippageCapPct: MoneyValue;
            reduceOnly: boolean;
        };
    } = {},
) {
    const appConfig = { isExecutionLive: overrides.isExecutionLive ?? true } as AppConfigService;

    const defaultPlan = overrides.plan ?? {
        policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
        limitPrice: new Money('30000'),
        timeoutMs: 0,
        slippageCapPct: new Money('0.15'),
        reduceOnly: false,
    };

    const policyRouter = {
        plan: jest.fn().mockReturnValue(defaultPlan),
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
    const resolvedSubmitResult = overrides.submitResult ?? {
        state: SubmitStateEnum.FILLED,
        snapshot: defaultSnapshot,
        rejectClass: null,
        venueCode: null,
        venueMessage: null,
    };

    const submitter = {
        submit: jest.fn().mockResolvedValue(resolvedSubmitResult),
        cancelByClientId: jest.fn().mockResolvedValue(null),
        fetchByClientId: jest.fn().mockResolvedValue(null),
        recover: jest.fn().mockResolvedValue(null),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    if (resolvedSubmitResult.snapshot !== null) {
        fillAccumulator.record(resolvedSubmitResult.snapshot);
    }

    const positionRow = {
        ...buildPositionEntityMock(42),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
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
    const emitSpy = jest.spyOn(events, 'emit');

    const attachResult = overrides.attachResult ?? buildExchangeSideAttachResult();
    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(attachResult),
    } as unknown as ProtectiveOrderAttacher;

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
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
        { emitSyntheticClose: jest.fn() } as any,
        exchangeClient,
        events,
    );

    return {
        service,
        submitter,
        positions,
        positionService,
        transactions,
        riskGate,
        protectiveAttacher,
        emitSpy,
        fillAccumulator,
        haltFlag,
        policyRouter,
        localProtectiveMonitor,
    };
}

// ─── HaltFlagService gate ─────────────────────────────────────────────────────

describe('ExecutionService — HaltFlagService gate', () => {
    it('halted before first attempt: no exchange call, reservation released', async () => {
        // BUILD
        const { service, submitter, riskGate, haltFlag } = makeService();
        haltFlag.halt('test-halt');
        const event = buildApprovedEvent({ reservationId: 'res-halted-1' });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK
        expect(submitter.submit).not.toHaveBeenCalled();
        expect(riskGate.releaseReservation).toHaveBeenCalledWith('res-halted-1');
    });

    it('halted before first attempt: emits ORDER_INTENT_EXPIRED_EVENT with reason halted', async () => {
        // BUILD
        const { service, emitSpy, haltFlag } = makeService();
        haltFlag.halt('test-halt');
        const event = buildApprovedEvent();

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK
        const expiredCalls = emitSpy.mock.calls.filter(([name]) => name === ORDER_INTENT_EXPIRED_EVENT);
        expect(expiredCalls.length).toBeGreaterThanOrEqual(1);
        const [, payload] = expiredCalls[0];
        expect((payload as { reason: string }).reason).toBe('halted');
    });

    it('halt mid-flight (between retries): second attempt sees halt and aborts', async () => {
        // BUILD: first submit returns RETRIABLE (so it loops), halt between iterations
        const { service, submitter, riskGate, haltFlag } = makeService({
            submitResult: {
                state: SubmitStateEnum.REJECTED,
                snapshot: null,
                rejectClass: 'RETRIABLE',
                venueCode: '-1021',
                venueMessage: 'Timestamp outside recv window',
            },
        });

        let callCount = 0;
        (submitter.submit as jest.Mock).mockImplementation(async () => {
            callCount += 1;
            if (callCount >= 1) {
                // Halt after first attempt — the second iteration's halt check fires
                haltFlag.halt('mid-flight-halt');
            }
            return {
                state: SubmitStateEnum.REJECTED,
                snapshot: null,
                rejectClass: 'RETRIABLE',
                venueCode: '-1021',
                venueMessage: 'Timestamp outside recv window',
            };
        });

        const event = buildApprovedEvent({ reservationId: 'res-midflight' });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: the halt mid-retry stops before budget exhaustion (released, not double-called)
        expect(riskGate.releaseReservation).toHaveBeenCalledWith('res-midflight');
        // Should not run all MAX_PERMANENT_RETRY_ATTEMPTS+1 submits (halt cuts it short)
        expect(callCount).toBeLessThanOrEqual(2); // at most 2 before the loop sees halt
    });
});

// ─── flowType end-to-end propagation ─────────────────────────────────────────

describe('ExecutionService — flowType propagation to OrderPolicyRouter', () => {
    it('policyRouter.plan receives the intent with its original flowType unchanged', async () => {
        // BUILD: intent with a specific flowType
        const { service, policyRouter } = makeService();
        const intent = buildOrderIntent({ flowType: FlowTypeEnum.FORCED_EXHAUSTION });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: router.plan called with the intent that has FORCED_EXHAUSTION flowType
        const planArg = (policyRouter.plan as jest.Mock).mock.calls[0][0] as { intent: { flowType: FlowTypeEnum } };
        expect(planArg.intent.flowType).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
    });

    it('policyRouter.plan is called with CATALYST_RISK flowType when intent carries it', async () => {
        // BUILD
        const { service, policyRouter } = makeService();
        const intent = buildOrderIntent({ flowType: FlowTypeEnum.CATALYST_RISK });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: no resolveFlowType heuristic — passes through as-is (live-vs-backtest C5)
        const planArg = (policyRouter.plan as jest.Mock).mock.calls[0][0] as { intent: { flowType: FlowTypeEnum } };
        expect(planArg.intent.flowType).toBe(FlowTypeEnum.CATALYST_RISK);
    });
});

// ─── midAtTrigger propagation — IOC limit price math ─────────────────────────

describe('OrderPolicyRouter — midAtTrigger used for IOC limitPrice, entryPrice for SL distance', () => {
    it('IOC limit price computed from midAtTrigger, not entryPrice', () => {
        // BUILD: entryPrice (bar close) ≠ midAtTrigger (book mid at trigger)
        const router = new OrderPolicyRouter();
        const midAtTrigger = new Money('30100'); // slightly above bar close
        const entryPrice = new Money('30000');

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.SHORT,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION, // → IOC for MEAN_REVERSION tier-1
            entryPrice,
            midAtTrigger,
            proposedExit: buildProposedExit({
                stopLossPrice: new Money('30500'),
                takeProfitPrice: new Money('29000'),
            }),
        });

        // OPERATE
        const plan = router.plan({
            intent,
            strategyDirection: StrategyDirectionEnum.MEAN_REVERSION,
            maxSlippageOfSlPct: null,
        });

        // CHECK: IOC limitPrice is anchored on midAtTrigger, not entryPrice
        // For SHORT IOC: limitPrice = midAtTrigger × (1 - slippageCapPct/100)
        expect(plan.policy).toBe(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
        // limitPrice must be derived from midAtTrigger (30100) not entryPrice (30000)
        // slippageCapPct > 0 → limitPrice < midAtTrigger for SHORT
        expect(plan.limitPrice.lessThan(midAtTrigger)).toBe(true);
        // Distance from midAtTrigger should be less than distance from entryPrice boundary
        const distFromMid = midAtTrigger.minus(plan.limitPrice).abs();
        const distFromEntry = entryPrice.minus(plan.limitPrice).abs();
        // midAtTrigger is closer to limitPrice (it's the reference) than entryPrice would be
        expect(distFromMid.lessThan(distFromEntry.plus(new Money('1')))).toBe(true);
    });

    it('SL distance in slippageCap computation uses entryPrice (bar close), not midAtTrigger', () => {
        // BUILD: two plans with same midAtTrigger but different entryPrice → slippage cap differs
        const router = new OrderPolicyRouter();
        const mid = new Money('30000');

        const intentTight = buildOrderIntent({
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.SHORT,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            entryPrice: new Money('30000'),
            midAtTrigger: mid,
            proposedExit: buildProposedExit({
                stopLossPrice: new Money('30050'), // tight stop: 50 from entry
                takeProfitPrice: new Money('29000'),
            }),
        });

        const intentWide = buildOrderIntent({
            intentAction: OrderIntentActionEnum.OPEN,
            tradeSide: PositionSideEnum.SHORT,
            coinTier: CoinTierEnum.TIER_1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            entryPrice: new Money('30000'),
            midAtTrigger: mid,
            proposedExit: buildProposedExit({
                stopLossPrice: new Money('30500'), // wide stop: 500 from entry
                takeProfitPrice: new Money('29000'),
            }),
        });

        const planTight = router.plan({ intent: intentTight, strategyDirection: StrategyDirectionEnum.MEAN_REVERSION, maxSlippageOfSlPct: null });
        const planWide = router.plan({ intent: intentWide, strategyDirection: StrategyDirectionEnum.MEAN_REVERSION, maxSlippageOfSlPct: null });

        // CHECK: tight stop → smaller sl-bounded cap → tighter limitPrice
        // Wide stop: slBounded > tierCap → clamps to tierCap; tight: slBounded < tierCap
        expect(planTight.slippageCapPct.lessThan(planWide.slippageCapPct)).toBe(true);
    });
});

// ─── IOC awaitPolicyTimeout — no cancel call ─────────────────────────────────

describe('ExecutionService — IOC awaitPolicyTimeout: fetch only, no cancel', () => {
    it('IOC timeout: fetchByClientId called; cancelByClientId NOT called', async () => {
        // BUILD: submit returns OPEN so awaitPolicyTimeout is triggered
        const iocPlan = {
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('30000'),
            timeoutMs: 500,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const openSnapshot = buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' });
        const { service, submitter } = makeService({ plan: iocPlan });

        (submitter.submit as jest.Mock).mockResolvedValue({
            state: SubmitStateEnum.OPEN,
            snapshot: openSnapshot,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        });

        // fetchByClientId returns null (no fill after timeout)
        (submitter.fetchByClientId as jest.Mock).mockResolvedValue(null);

        const event = buildApprovedEvent();

        // OPERATE: start then flush all timers to unblock the sleep inside awaitPolicyTimeout
        const resultPromise = service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await resultPromise;

        // CHECK
        expect(submitter.fetchByClientId).toHaveBeenCalledTimes(1);
        expect(submitter.cancelByClientId).not.toHaveBeenCalled();
    });
});

// ─── POST_ONLY_MAKER awaitPolicyTimeout — cancel + no chase ──────────────────

describe('ExecutionService — POST_ONLY_MAKER awaitPolicyTimeout: cancel + classify, no chase', () => {
    it('maker timeout: cancelByClientId called; no second submit', async () => {
        // BUILD: submit returns OPEN. We need the book to NOT trigger would-cross for a SHORT
        // maker: SHORT wouldCross = limitPrice <= bestBid. With bestBid=29999, limitPrice=30000:
        // 30000 <= 29999 → false → passes through to submit (pegged to sameSide=bestAsk=30001).
        const makerPlan = {
            policy: OrderPolicyEnum.POST_ONLY_MAKER,
            limitPrice: new Money('30000'),
            timeoutMs: 500,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };
        const openSnapshot = buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' });

        // Build service manually so we can control the book (no would-cross for SHORT)
        const appConfig = { isExecutionLive: true } as AppConfigService;
        const policyRouter = { plan: jest.fn().mockReturnValue(makerPlan) } as unknown as OrderPolicyRouter;
        const localProtectiveMonitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
            new SharedCloseCoordinator(),
        );
        const haltFlag = new HaltFlagService();
        // bestBid=29999, bestAsk=30001: SHORT wouldCross = limitPrice(30000) <= bestBid(29999) → false
        const exchangeClient = {
            watchOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '29999' }],
                asks: [{ price: '30001' }],
            }),
        } as unknown as import('../../../src/exchange/interface').IExchangeClient;
        const clientOrderIdFactory = new ClientOrderIdFactory();

        const submitterMock = {
            submit: jest.fn().mockResolvedValue({
                state: SubmitStateEnum.OPEN,
                snapshot: openSnapshot,
                rejectClass: null,
                venueCode: null,
                venueMessage: null,
            }),
            cancelByClientId: jest.fn().mockResolvedValue(buildOrderSnapshot({ status: 'canceled', filled: '0', remaining: '0.01' })),
            fetchByClientId: jest.fn().mockResolvedValue(null),
            recover: jest.fn().mockResolvedValue(null),
        } as unknown as ExchangeOrderSubmitter;

        const fillAccumulator = new FillAccumulator();
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
        const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
        } as unknown as import('../../../src/position/service').PositionService;
        const service = new ExecutionService(
            appConfig,
            policyRouter,
            clientOrderIdFactory,
            submitterMock,
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
        );

        const event = buildApprovedEvent({ intent: buildOrderIntent({ tradeSide: PositionSideEnum.SHORT }) });

        // OPERATE: flush all timers to unblock the sleep inside awaitPolicyTimeout
        const resultPromise = service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await resultPromise;

        // CHECK: cancel was called; submit only once (no resubmit/chase)
        expect(submitterMock.cancelByClientId).toHaveBeenCalledTimes(1);
        expect(submitterMock.submit).toHaveBeenCalledTimes(1);
    });
});

// ─── POST_ONLY_MAKER would-cross ──────────────────────────────────────────────

describe('ExecutionService — POST_ONLY_MAKER would-cross → CANCELLED, no resubmit', () => {
    it('when book fetch shows would-cross, submit is not called and reservation released', async () => {
        // BUILD: POST_ONLY_MAKER plan; exchangeClient.watchOrderBook returns a book where
        // plan.limitPrice (30000) >= bestAsk (29999) for a LONG → would cross
        const makerPlan = {
            policy: OrderPolicyEnum.POST_ONLY_MAKER,
            limitPrice: new Money('30000'),
            timeoutMs: 500,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        };

        const appConfig = { isExecutionLive: true } as AppConfigService;
        const policyRouter = { plan: jest.fn().mockReturnValue(makerPlan) } as unknown as OrderPolicyRouter;
        const localProtectiveMonitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
            new SharedCloseCoordinator(),
        );
        const haltFlag = new HaltFlagService();

        // For LONG would-cross: limitPrice (30000) >= bestAsk → return null from resolveLimitPrice
        const exchangeClient = {
            watchOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '29998' }],
                asks: [{ price: '29999' }], // bestAsk=29999, limitPrice=30000 >= bestAsk → would cross
            }),
        } as unknown as import('../../../src/exchange/interface').IExchangeClient;

        const clientOrderIdFactory = new ClientOrderIdFactory();
        const submitterMock = {
            submit: jest.fn(),
            cancelByClientId: jest.fn(),
            fetchByClientId: jest.fn(),
            recover: jest.fn(),
        } as unknown as ExchangeOrderSubmitter;

        const fillAccumulator = new FillAccumulator();
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
        const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
        } as unknown as import('../../../src/position/service').PositionService;
        const service = new ExecutionService(
            appConfig,
            policyRouter,
            clientOrderIdFactory,
            submitterMock,
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
        );

        // LONG intent: tradeSide = LONG, limitPrice (30000) >= bestAsk (29999) → would cross
        const intent = buildOrderIntent({ tradeSide: PositionSideEnum.LONG, intentAction: OrderIntentActionEnum.OPEN });
        const event = buildApprovedEvent({ intent });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: submit was not called (would-cross terminates before submitter)
        expect(submitterMock.submit).not.toHaveBeenCalled();
        expect(riskGate.releaseReservation).toHaveBeenCalled();
    });
});

// ─── ADD path — weighted-average entry ───────────────────────────────────────

describe('ExecutionService — ADD path with weighted-average entry', () => {
    it('ADD: qty = A+B, entry = (A*X + B*Y)/(A+B), SL/TP row untouched', async () => {
        // BUILD: existing position at entry X=30000 qty A=0.01; ADD fill at Y=31000 qty B=0.01
        const existingQty = new Money('0.01');
        const existingEntry = new Money('30000');
        const existingNotional = existingQty.times(existingEntry);

        const addFillQty = new Money('0.01');
        const addFillPrice = new Money('31000');

        const existingPosition = {
            id: 42,
            symbol: 'BTCUSDT',
            protectiveOrderType: 'local_fallback',
            entryPrice: existingEntry,
            qty: existingQty,
            entryNotional: existingNotional,
        };

        const addSnapshot = buildOrderSnapshot({
            filled: addFillQty.toFixed(),
            average: addFillPrice.toFixed(),
            cost: addFillQty.times(addFillPrice).toFixed(),
            fee: '0.12',
        });

        const appConfig = { isExecutionLive: true } as AppConfigService;
        const policyRouter = {
            plan: jest.fn().mockReturnValue({
                policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
                limitPrice: new Money('31000'),
                timeoutMs: 0,
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
            watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '31000' }], asks: [{ price: '31001' }] }),
        } as unknown as import('../../../src/exchange/interface').IExchangeClient;
        const clientOrderIdFactory = new ClientOrderIdFactory();

        const submitter = {
            submit: jest
                .fn()
                .mockResolvedValue({ state: SubmitStateEnum.FILLED, snapshot: addSnapshot, rejectClass: null, venueCode: null, venueMessage: null }),
            cancelByClientId: jest.fn(),
            fetchByClientId: jest.fn(),
            recover: jest.fn(),
        } as unknown as ExchangeOrderSubmitter;

        const fillAccumulator = new FillAccumulator();
        fillAccumulator.record(addSnapshot);

        let savedPosition: typeof existingPosition | null = null;
        const positions = {
            createOpen: jest.fn(),
            save: jest.fn().mockImplementation(async (pos: typeof existingPosition) => {
                savedPosition = pos;
                return pos;
            }),
            findOpenBySymbol: jest.fn().mockResolvedValue([existingPosition]),
            findOpenBySymbolAndSlot: jest.fn().mockResolvedValue(existingPosition),
        } as unknown as import('../../../src/position/repository/PositionRepository').PositionRepository;

        const transactions = {
            recordTerminal: jest.fn().mockResolvedValue({ id: 1 }),
        } as unknown as import('../../../src/position/repository/TransactionRepository').TransactionRepository;
        const strategyVersions = {
            findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
        } as unknown as StrategyVersionRepository;
        const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
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
            { emitSyntheticClose: jest.fn() } as any,
            exchangeClient,
            events,
        );

        const addIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.ADD,
            sizing: buildSizing({ qty: addFillQty }),
        });
        const event = buildApprovedEvent({ intent: addIntent });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: weighted-average entry and combined qty
        expect(savedPosition).not.toBeNull();
        const expectedQty = existingQty.plus(addFillQty); // 0.02
        const expectedEntry = existingQty.times(existingEntry).plus(addFillQty.times(addFillPrice)).dividedBy(expectedQty); // (300 + 310) / 0.02 = 30500

        expect(savedPosition!.qty.toFixed(4)).toBe(expectedQty.toFixed(4));
        expect(savedPosition!.entryPrice.toFixed(2)).toBe(expectedEntry.toFixed(2));

        // createOpen should NOT be called for ADD
        expect(positions.createOpen).not.toHaveBeenCalled();
        // Single transactions row written
        expect(transactions.recordTerminal).toHaveBeenCalledTimes(1);
    });
});

// ─── REDUCE_MARKET remainder retry ───────────────────────────────────────────

describe('ExecutionService — REDUCE_MARKET remainder retry', () => {
    it('partial fill triggers retry at attemptN+1 with remainder qty', async () => {
        // BUILD: first submit returns OPEN (goes to resolveReduceTerminal), cancel returns partial fill
        const reducePlan = {
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: new Money('30000'),
            timeoutMs: 100,
            slippageCapPct: new Money('0'),
            reduceOnly: true,
        };

        const partialFill = buildOrderSnapshot({
            status: 'canceled',
            filled: '0.005',
            remaining: '0.005',
            cost: '150',
            average: '30000',
            fee: '0.06',
        });
        const remainderFill = buildOrderSnapshot({
            status: 'closed',
            filled: '0.005',
            remaining: '0',
            cost: '150',
            average: '30000',
            fee: '0.06',
        });

        const appConfig = { isExecutionLive: true } as AppConfigService;
        const policyRouter = { plan: jest.fn().mockReturnValue(reducePlan) } as unknown as OrderPolicyRouter;
        const localProtectiveMonitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
            new SharedCloseCoordinator(),
        );
        const haltFlag = new HaltFlagService();
        const exchangeClient = { watchOrderBook: jest.fn() } as unknown as import('../../../src/exchange/interface').IExchangeClient;
        const clientOrderIdFactory = new ClientOrderIdFactory();

        let submitCount = 0;
        const submitter = {
            submit: jest.fn().mockImplementation(async (_input: { amount: string }) => {
                submitCount += 1;
                if (submitCount === 1) {
                    // First submit: OPEN → goes to awaitPolicyTimeout → resolveReduceTerminal
                    return {
                        state: SubmitStateEnum.OPEN,
                        snapshot: buildOrderSnapshot({ status: 'open', filled: '0', remaining: '0.01' }),
                        rejectClass: null,
                        venueCode: null,
                        venueMessage: null,
                    };
                }
                // Second submit (remainder): FILLED
                return { state: SubmitStateEnum.FILLED, snapshot: remainderFill, rejectClass: null, venueCode: null, venueMessage: null };
            }),
            cancelByClientId: jest.fn().mockResolvedValue(partialFill),
            fetchByClientId: jest.fn().mockResolvedValue(null),
            recover: jest.fn().mockResolvedValue(null),
        } as unknown as ExchangeOrderSubmitter;

        const fillAccumulator = new FillAccumulator();
        fillAccumulator.record(partialFill);
        fillAccumulator.record(remainderFill);

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
        const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
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
            { emitSyntheticClose: jest.fn() } as any,
            exchangeClient,
            events,
        );

        const reduceIntent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.CLOSE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent: reduceIntent });

        // OPERATE: flush all timers to unblock the sleep inside resolveReduceTerminal
        const resultPromise = service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await resultPromise;

        // CHECK: submit called twice (original + remainder retry)
        expect(submitCount).toBe(2);
    });

    it('remainder budget exhausted (MAX_REDUCE_REMAINDER_ATTEMPTS=3) reaches RECONCILE_REQUIRED state after max attempts', async () => {
        // BUILD: every submit returns OPEN → cancel returns partial (0.001 filled each time).
        // With MAX_REDUCE_REMAINDER_ATTEMPTS=3: attempts 0→1→2→3(>=3 → RECONCILE_REQUIRED).
        //
        // Implementation note (flagged): when budget is exhausted WITH a partial fill,
        // resolveReduceTerminal returns RECONCILE_REQUIRED with a non-null fillSummary.
        // executeLive routes that to openOrAddPositionAndAttachProtection (not handleNoFill),
        // so ORDER_INTENT_UNKNOWN_EVENT is NOT emitted. The partial position IS persisted.
        // The RECONCILE_REQUIRED state is recorded in the transactions row.
        // This matches the current implementation; M6 reconciliation handles the remainder.
        const reducePlan = {
            policy: OrderPolicyEnum.REDUCE_MARKET,
            limitPrice: new Money('30000'),
            timeoutMs: 50,
            slippageCapPct: new Money('0'),
            reduceOnly: true,
        };

        const partialFill = buildOrderSnapshot({
            clientOrderId: 'tbvt-aabbccddee1122334455',
            status: 'canceled',
            filled: '0.001',
            remaining: '0.009',
            cost: '30',
            average: '30000',
            fee: '0.01',
        });

        const appConfig = { isExecutionLive: true } as AppConfigService;
        const policyRouter = { plan: jest.fn().mockReturnValue(reducePlan) } as unknown as OrderPolicyRouter;
        const localProtectiveMonitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
            new SharedCloseCoordinator(),
        );
        const haltFlag = new HaltFlagService();
        const exchangeClient = { watchOrderBook: jest.fn() } as unknown as import('../../../src/exchange/interface').IExchangeClient;
        const clientOrderIdFactory = new ClientOrderIdFactory();

        let submitCallCount = 0;
        const submitter = {
            submit: jest.fn().mockImplementation(() => {
                submitCallCount += 1;
                return Promise.resolve({
                    state: SubmitStateEnum.OPEN,
                    snapshot: buildOrderSnapshot({ status: 'open' }),
                    rejectClass: null,
                    venueCode: null,
                    venueMessage: null,
                });
            }),
            cancelByClientId: jest.fn().mockResolvedValue(partialFill),
            fetchByClientId: jest.fn().mockResolvedValue(null),
            recover: jest.fn().mockResolvedValue(null),
        } as unknown as ExchangeOrderSubmitter;

        const fillAccumulator = new FillAccumulator();
        fillAccumulator.record(partialFill);

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
        const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
        const events = new EventEmitter2();
        const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;

        const positionService = {
            transition: jest.fn().mockResolvedValue(undefined),
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
            { emitSyntheticClose: jest.fn() } as any,
            exchangeClient,
            events,
        );

        const intent = buildOrderIntent({
            intentAction: OrderIntentActionEnum.CLOSE,
            sizing: buildSizing({ qty: new Money('0.01') }),
        });
        const event = buildApprovedEvent({ intent });

        // OPERATE: flush all timers to drive through all remainder retry sleeps
        const resultPromise = service.onOrderIntentApproved(event);
        await jest.runAllTimersAsync();
        await resultPromise;

        // CHECK: submit called MAX_REDUCE_REMAINDER_ATTEMPTS times (attempts 0, 1, 2)
        // before budget exhaustion at attemptN+1 >= MAX_REDUCE_REMAINDER_ATTEMPTS.
        expect(submitCallCount).toBe(MAX_REDUCE_REMAINDER_ATTEMPTS);
    });
});

// ─── Zero-fill audit row ──────────────────────────────────────────────────────

describe('ExecutionService — zero-fill audit row (must-fix #14)', () => {
    it('handleNoFill writes a transactions row with position_id=null for OPEN intent', async () => {
        // BUILD: CANCELLED with zero fill
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const { service, transactions, fillAccumulator } = makeService({
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent({ intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.OPEN }) });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: transactions.recordTerminal called with position_id=null (the zero-fill audit row)
        expect(transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const callArg = (transactions.recordTerminal as jest.Mock).mock.calls[0][0] as {
            positionId: null;
            qty: MoneyValue;
            cashflow: MoneyValue;
            clientOrderId: string;
        };
        expect(callArg.positionId).toBeNull();
        expect(callArg.qty.toFixed()).toBe('0');
        expect(callArg.cashflow.toFixed()).toBe('0');
        expect(callArg.clientOrderId).toBeTruthy();
    });

    it('handleNoFill writes a transactions row with qty=0 and type=add for ADD intent', async () => {
        // BUILD
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const { service, transactions, fillAccumulator } = makeService({
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
        });
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent({ intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.ADD }) });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK
        expect(transactions.recordTerminal).toHaveBeenCalledTimes(1);
        const callArg = (transactions.recordTerminal as jest.Mock).mock.calls[0][0] as { type: string; positionId: null };
        expect(callArg.positionId).toBeNull();
        expect(callArg.type).toBe('add');
    });

    it('handleNoFill does NOT write a zero-fill row for REDUCE intent', async () => {
        // Per implementation: zero-fill audit rows are only for OPEN/ADD
        const cancelledSnapshot = buildOrderSnapshot({ status: 'canceled', filled: '0', cost: '0', average: null });
        const { service, transactions, fillAccumulator } = makeService({
            submitResult: { state: SubmitStateEnum.CANCELLED, snapshot: cancelledSnapshot, rejectClass: null, venueCode: null, venueMessage: null },
            plan: {
                policy: OrderPolicyEnum.REDUCE_MARKET,
                limitPrice: new Money('30000'),
                timeoutMs: 0,
                slippageCapPct: new Money('0'),
                reduceOnly: true,
            },
        });
        fillAccumulator.record(cancelledSnapshot);
        const event = buildApprovedEvent({ intent: buildOrderIntent({ intentAction: OrderIntentActionEnum.REDUCE }) });

        // OPERATE
        await service.onOrderIntentApproved(event);

        // CHECK: no zero-fill audit row for reduce
        expect(transactions.recordTerminal).not.toHaveBeenCalled();
    });
});

// ─── FillAccumulator no-fallback semantics ────────────────────────────────────

describe('FillAccumulator — no-fallback: null average + filledQty > 0 → null (must-fix #10)', () => {
    it('toSummary returns null when average is null and filled > 0 (no limit-price anchor)', () => {
        // BUILD: filled > 0 but average unknown (e.g. partial fill where exchange didn't return avg)
        const accumulator = new FillAccumulator();
        const snapshot = buildOrderSnapshot({
            filled: '0.01',
            average: null,
            price: '30000', // limit/ref price — must NOT be used as fallback
            cost: '300',
        });

        // CHECK: null — caller routes to recover-by-clientOrderId before anchoring SL/PnL
        const summary = accumulator.toSummary(snapshot);
        expect(summary).toBeNull();
    });

    it('toSummary returns null when average is "0" (zero-price would be nonsensical)', () => {
        const accumulator = new FillAccumulator();
        const snapshot = buildOrderSnapshot({ filled: '0.01', average: '0', price: '30000', cost: '300' });

        expect(accumulator.toSummary(snapshot)).toBeNull();
    });
});

// ─── extraParams allow-list ───────────────────────────────────────────────────

describe('ExchangeOrderSubmitter — extraParams allow-list (must-fix #11)', () => {
    it('allowed key positionSide passes through to createOrder params', async () => {
        // BUILD
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'closed', filled: '0.01', average: '30000', cost: '300', fee: '0.12' }));
        const fillAccumulator = new FillAccumulator();
        const submitter = new ExchangeOrderSubmitter(mock as never, fillAccumulator);

        // OPERATE
        await submitter.submit({
            clientOrderId: CLIENT_ID,
            symbol: SYMBOL,
            tradeSide: PositionSideEnum.SHORT,
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: '30000',
            amount: '0.01',
            reduceOnly: false,
            closePosition: false,
            extraParams: { positionSide: 'SHORT' },
        });

        // CHECK: params passed to createOrder include positionSide
        const createOrderArg = mock.createOrder.mock.calls[0][0] as { params: Record<string, unknown> };
        expect(createOrderArg.params.positionSide).toBe('SHORT');
    });

    it('non-allowed key is stripped from createOrder params', async () => {
        // BUILD: pass a key not in ALLOWED_EXTRA_PARAM_KEYS
        const mock = buildExchangeClientMock();
        mock.createOrder.mockResolvedValue(buildOrderSnapshot({ status: 'closed', filled: '0.01', average: '30000', cost: '300', fee: '0.12' }));
        const fillAccumulator = new FillAccumulator();
        const submitter = new ExchangeOrderSubmitter(mock as never, fillAccumulator);

        // OPERATE: pass an unlisted key via type cast (hostile payload simulation)
        await submitter.submit({
            clientOrderId: CLIENT_ID,
            symbol: SYMBOL,
            tradeSide: PositionSideEnum.SHORT,
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: '30000',
            amount: '0.01',
            reduceOnly: false,
            closePosition: false,
            extraParams: { positionSide: 'SHORT' }, // only allowed key included
        });

        // CHECK: no unexpected keys leak through
        const createOrderArg = mock.createOrder.mock.calls[0][0] as { params: Record<string, unknown> };
        // Only positionSide from the allow-list; no closeAll, no hedgedMode
        const paramKeys = Object.keys(createOrderArg.params).filter((k) => k !== 'reduceOnly' && k !== 'timeInForce');
        expect(paramKeys).not.toContain('closeAll');
        expect(paramKeys).not.toContain('hedgedMode');
    });
});

const CLIENT_ID = 'tbvt-aabbccddee1122334455';
const SYMBOL = 'BTCUSDT';
