/**
 * ExecutionService — persist SL/TP at insert (M33 Task 5 / Fix 2 restart, GBT H3).
 *
 * The clamped exits must land on the initial PENDING_OPEN row at createOpen time — not only at
 * applyProtectiveAttachResult — so a crash between row-insert and protective attach still leaves
 * re-armable exits for phase 4c boot re-arm.
 *
 *   D-PP-9: createOpen persists stop_loss_price and take_profit_price on the initial PENDING_OPEN row.
 */

import { ExchangeEnvironmentEnum, PositionStateEnum, StrategyDirectionEnum } from '@bot/shared';
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
        exchangeClient,
        events,
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
