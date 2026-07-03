/**
 * ExecutionService — persist SL/TP at insert (M33 Task 5 / Fix 2 restart, GBT H3).
 *
 * The clamped exits must land on the initial PENDING_OPEN row at createOpen time — not only at
 * applyProtectiveAttachResult — so a crash between row-insert and protective attach still leaves
 * re-armable exits for phase 4c boot re-arm.
 *
 *   D-PP-9: createOpen persists stop_loss_price and take_profit_price on the initial PENDING_OPEN row.
 */

import { ExchangeEnvironmentEnum, PositionStateEnum, RebalanceTriggerSourceEnum, StrategyDirectionEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../../src/common/service/HaltFlagService';
import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../../src/position/repository/TransactionRepository';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';
import { buildOrderIntent } from '../../risk/support/fixtures';

function makeService() {
    const appConfig = { isExecutionLive: true, exchangeEnv: ExchangeEnvironmentEnum.PAPER } as unknown as AppConfigService;

    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
        new SharedCloseCoordinator(),
    );

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: 'marketable_limit_ioc',
            limitPrice: new Money('30000'),
            timeoutMs: 0,
            slippageCapPct: new Money('0.15'),
            reduceOnly: false,
        }),
    } as unknown as OrderPolicyRouter;

    const haltFlag = new HaltFlagService();
    const exchangeClient = {
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();
    const filledSnapshot = buildOrderSnapshot({ filled: '0.01', average: '30000', cost: '300', fee: '0.12' });

    const submitter = {
        submit: jest
            .fn()
            .mockResolvedValue({ state: SubmitStateEnum.FILLED, snapshot: filledSnapshot, rejectClass: null, venueCode: null, venueMessage: null }),
        cancelByClientId: jest.fn(),
        fetchByClientId: jest.fn(),
        recover: jest.fn(),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    fillAccumulator.record(filledSnapshot);

    const positionRow = { ...buildPositionEntityMock(42), entryPrice: new Money('30000'), qty: new Money('0.01'), entryNotional: new Money('300') };
    const createOpenSpy = jest.fn().mockResolvedValue(positionRow);
    const positions = {
        createOpen: createOpenSpy,
        save: jest.fn().mockResolvedValue(positionRow),
        findOpenBySymbol: jest.fn().mockResolvedValue([]),
    } as unknown as PositionRepository;

    const transactions = { recordTerminal: jest.fn().mockResolvedValue({ id: 1 }) } as unknown as TransactionRepository;

    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
    const events = new EventEmitter2();
    const protectiveAttacher = { attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()) } as unknown as ProtectiveOrderAttacher;
    const positionService = { transition: jest.fn().mockResolvedValue(undefined) } as unknown as PositionService;

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
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as any,
        // M47 Task 5a — instrumentor seed stub (synchronous open-path seeding).
        { onPositionOpened: jest.fn(), applyEntryTick: jest.fn() } as never,
    );

    return { service, createOpenSpy };
}

describe('ExecutionService.createOpen persists SL/TP at insert', () => {
    it('createOpen persists stop_loss_price and take_profit_price on the initial PENDING_OPEN row (D-PP-9)', async () => {
        // BUILD
        const { service, createOpenSpy } = makeService();

        // OPERATE
        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: the initial row is inserted at PENDING_OPEN with the clamped exits persisted —
        // not deferred to applyProtectiveAttachResult, so a pre-attach crash still leaves re-armable
        // prices on the row (GBT H3).
        expect(createOpenSpy).toHaveBeenCalledTimes(1);

        const insertedRow = createOpenSpy.mock.calls[0][0];

        expect(insertedRow.state).toBe(PositionStateEnum.PENDING_OPEN);
        expect(insertedRow.stopLossPrice.toFixed()).toBe(new Money('30500').toFixed());
        expect(insertedRow.takeProfitPrice.toFixed()).toBe(new Money('29000').toFixed());
    });
});

// ADR 0048 M50c — the intent's triggerSource must land on positions.trigger_source at insert so the
// analysis surfaces can fence manual rebalances out of the primary calibration aggregation.
describe('ExecutionService.createOpen persists trigger_source from the intent', () => {
    it('persists triggerSource=MANUAL when the momentum open intent carried it (M50c)', async () => {
        const { service, createOpenSpy } = makeService();
        const event = buildApprovedEvent({ intent: buildOrderIntent({ triggerSource: RebalanceTriggerSourceEnum.MANUAL }) });

        await service.onOrderIntentApproved(event);

        expect(createOpenSpy.mock.calls[0][0].triggerSource).toBe(RebalanceTriggerSourceEnum.MANUAL);
    });

    it('persists triggerSource=SCHEDULED when the momentum open intent carried it', async () => {
        const { service, createOpenSpy } = makeService();
        const event = buildApprovedEvent({ intent: buildOrderIntent({ triggerSource: RebalanceTriggerSourceEnum.SCHEDULED }) });

        await service.onOrderIntentApproved(event);

        expect(createOpenSpy.mock.calls[0][0].triggerSource).toBe(RebalanceTriggerSourceEnum.SCHEDULED);
    });

    it('persists NULL trigger_source for a VWAP-path open (intent has no triggerSource)', async () => {
        // The VWAP path (StrategyService) never sets triggerSource — that absence must persist as
        // NULL, never a fabricated 'scheduled', so NULL rows stay legitimate organic history.
        const { service, createOpenSpy } = makeService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(createOpenSpy.mock.calls[0][0].triggerSource).toBeNull();
    });

    // Close-then-reopen adversarial case: createPositionFromFill derives triggerSource ONLY from
    // the CURRENT approved event's intent — it never reads a prior/closed position row for this
    // symbol. Two consecutive OPEN approvals with DIFFERENT triggerSource values (simulating a
    // symbol closed under one provenance and reopened under another in a later rebalance) must
    // each persist their OWN intent's value — the second insert must not carry over the first.
    it('does not leak a prior open intent triggerSource into a later, differently-tagged open (close-then-reopen)', async () => {
        const { service, createOpenSpy } = makeService();

        const firstEvent = buildApprovedEvent({ intent: buildOrderIntent({ triggerSource: RebalanceTriggerSourceEnum.MANUAL }) });
        await service.onOrderIntentApproved(firstEvent);

        const secondEvent = buildApprovedEvent({ intent: buildOrderIntent({ triggerSource: RebalanceTriggerSourceEnum.SCHEDULED }) });
        await service.onOrderIntentApproved(secondEvent);

        expect(createOpenSpy).toHaveBeenCalledTimes(2);
        expect(createOpenSpy.mock.calls[0][0].triggerSource).toBe(RebalanceTriggerSourceEnum.MANUAL);
        expect(createOpenSpy.mock.calls[1][0].triggerSource).toBe(RebalanceTriggerSourceEnum.SCHEDULED);
    });
});

// M52 D3 (ADR 0051 §6) — a D2 retry entry must persist positions.is_retry_entry=true so the paper-soak
// adverse-selection analysis can separate retry entries from attempt-1 entries. Every attempt-1 /
// non-retry open persists NULL (the retry set must be a strict, non-contaminated subset).
describe('ExecutionService.createOpen persists is_retry_entry from the intent', () => {
    it('persists is_retry_entry=true when the retry-rebuild intent carried it', async () => {
        const { service, createOpenSpy } = makeService();
        const event = buildApprovedEvent({ intent: buildOrderIntent({ isRetryEntry: true }) });

        await service.onOrderIntentApproved(event);

        expect(createOpenSpy.mock.calls[0][0].isRetryEntry).toBe(true);
    });

    it('persists NULL is_retry_entry for an attempt-1 open (intent has no isRetryEntry)', async () => {
        // An attempt-1 cascade leg / VWAP open never sets isRetryEntry — that absence must persist as
        // NULL, keeping the retry set separable (never a fabricated false that reads as "measured").
        const { service, createOpenSpy } = makeService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(createOpenSpy.mock.calls[0][0].isRetryEntry).toBeNull();
    });

    // Retry-then-attempt-1 adversarial: createPositionFromFill derives isRetryEntry ONLY from the
    // current approved event's intent — a retry open must not leak its true into a later attempt-1
    // open on the same symbol (a superseding cron re-selecting the coin as a fresh attempt-1).
    it('does not leak a prior retry intent isRetryEntry into a later attempt-1 open', async () => {
        const { service, createOpenSpy } = makeService();

        await service.onOrderIntentApproved(buildApprovedEvent({ intent: buildOrderIntent({ isRetryEntry: true }) }));
        await service.onOrderIntentApproved(buildApprovedEvent());

        expect(createOpenSpy).toHaveBeenCalledTimes(2);
        expect(createOpenSpy.mock.calls[0][0].isRetryEntry).toBe(true);
        expect(createOpenSpy.mock.calls[1][0].isRetryEntry).toBeNull();
    });
});
