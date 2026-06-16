/**
 * ExecutionService entry fill path — arm/record ordering adversarial QA (Wave 3).
 *
 *   D-CF-2-adv (no scope creep — ordering invariant): assert that localProtectiveMonitor.arm
 *   is invoked BEFORE recordEntryTransaction in the entry fill path (ADR 0008 §2 arm-before-record
 *   ordering must not have been accidentally changed by the M33 cashflow fix).
 *
 * Why this matters: if arm moved AFTER the transaction INSERT, a crash between the INSERT and
 * the arm leaves a PENDING_OPEN row with no in-memory protection and no persisted SL/TP arm
 * — the guaranteed-close invariant is violated for that window. The comment in ExecutionService
 * explicitly guards this ordering; this test pins it so a future refactor cannot silently move it.
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

import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../../src/position/repository/TransactionRepository';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';

describe('ExecutionService entry fill path — arm/record ordering invariant', () => {
    it('D-CF-2-adv: localProtectiveMonitor.arm is invoked BEFORE recordEntryTransaction (ADR 0008 §2)', async () => {
        // BUILD: track global call order across arm and recordTerminal.
        const callOrder: string[] = [];

        const positionRow = { ...buildPositionEntityMock(42), entryPrice: new Money('30000'), qty: new Money('0.01'), entryNotional: new Money('300') };

        // arm spy — logs its call in the sequence.
        const armSpy = jest.fn().mockImplementation((..._args) => {
            callOrder.push('arm');
        });

        const localProtectiveMonitor = {
            arm: armSpy,
            isArmed: jest.fn().mockReturnValue(true),
            disarm: jest.fn(),
        } as unknown as LocalProtectiveMonitor;

        // recordTerminal spy — logs its call in the sequence.
        const recordTerminalSpy = jest.fn().mockImplementation(async (..._args) => {
            callOrder.push('recordTerminal');
            return { id: 1 };
        });

        const transactions = { recordTerminal: recordTerminalSpy } as unknown as TransactionRepository;

        const appConfig = { isExecutionLive: true, exchangeEnv: ExchangeEnvironmentEnum.LIVE } as unknown as AppConfigService;
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

        const positions = {
            createOpen: jest.fn().mockResolvedValue(positionRow),
            save: jest.fn().mockResolvedValue(positionRow),
            findOpenBySymbol: jest.fn().mockResolvedValue([]),
        } as unknown as PositionRepository;

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
        );

        // OPERATE: an open fill triggers the entry fill path.
        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: arm was called before recordTerminal.
        expect(armSpy).toHaveBeenCalledTimes(1);
        expect(recordTerminalSpy).toHaveBeenCalledTimes(1);

        const armIndex = callOrder.indexOf('arm');
        const recordIndex = callOrder.indexOf('recordTerminal');

        expect(armIndex).toBeGreaterThanOrEqual(0); // arm was called
        expect(recordIndex).toBeGreaterThanOrEqual(0); // recordTerminal was called
        expect(armIndex).toBeLessThan(recordIndex); // arm BEFORE record (ADR 0008 §2)
    });
});
