/**
 * ExecutionService.applyProtectiveAttachResult — M33 Task 2 / Fix 2 (ADR 0008 §7).
 *
 * In paper mode there is no exchange matching engine to fire the STOP_MARKET / TAKE_PROFIT_MARKET
 * orders, so an `exchange_side` attach success must NOT disarm the local monitor — it stays the
 * SL/TP enforcer. In LIVE/TESTNET the disarm is unchanged (the exchange holds protection).
 *
 *   D-PP-1: paper mode keeps LocalProtectiveMonitor armed after exchange_side attach success.
 *   D-PP-2: live mode disarms after exchange_side attach success (unchanged).
 */

import { ExchangeEnvironmentEnum, StrategyDirectionEnum } from '@bot/shared';
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

function makeService(exchangeEnv: ExchangeEnvironmentEnum) {
    const appConfig = { isExecutionLive: true, exchangeEnv } as unknown as AppConfigService;

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
    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
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

    return { service, localProtectiveMonitor };
}

describe('ExecutionService.applyProtectiveAttachResult', () => {
    it('paper mode keeps LocalProtectiveMonitor armed after exchange_side attach success', async () => {
        // BUILD
        const { service, localProtectiveMonitor } = makeService(ExchangeEnvironmentEnum.PAPER);

        // OPERATE
        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: paper keeps the monitor armed — it is the SL/TP enforcer in paper (ADR 0008 §7).
        expect(localProtectiveMonitor.isArmed(42)).toBe(true);
    });

    it('live mode disarms after exchange_side attach success (unchanged)', async () => {
        // BUILD
        const { service, localProtectiveMonitor } = makeService(ExchangeEnvironmentEnum.LIVE);

        // OPERATE
        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: live disarms — the exchange holds protection (ADR 0008 §2).
        expect(localProtectiveMonitor.isArmed(42)).toBe(false);
    });
});
