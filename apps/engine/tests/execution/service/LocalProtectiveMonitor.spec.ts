/**
 * LocalProtectiveMonitor — arm/disarm seam (ADR 0008 §2 / Round-1 must-fix #13).
 *
 * Coverage:
 *   1. arm inserts into internal map; isArmed returns true
 *   2. disarm removes from map; isArmed returns false
 *   3. disarm on an unknown positionId is a no-op (does not throw)
 *   4. listArmed reflects armed positions and empties after disarm
 *   5. Multiple positions are tracked independently
 *   6. Arming the same positionId twice overwrites (latest wins)
 *   7. Via ExecutionService: arm fires BEFORE protectiveAttacher.attach (ordering invariant)
 *   8. Via ExecutionService: exchange-side success disarms the monitor
 *   9. Via ExecutionService: attach failure leaves monitor ARMED (local fallback stays watching)
 */

import { PositionSideEnum, StrategyDirectionEnum } from '@bot/shared';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { Money } from '../../../src/common/utils/money';
import { AppConfigService } from '../../../src/config/service';
import { SubmitStateEnum } from '../../../src/execution/enum';
import { ClientOrderIdFactory } from '../../../src/execution/service/ClientOrderIdFactory';
import { ExecutionService } from '../../../src/execution/service/ExecutionService';
import { ExchangeOrderSubmitter } from '../../../src/execution/service/ExchangeOrderSubmitter';
import { FillAccumulator } from '../../../src/execution/service/FillAccumulator';
import { LocalProtectiveMonitor } from '../../../src/execution/service/LocalProtectiveMonitor';
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

// ─── Unit tests — LocalProtectiveMonitor standalone ──────────────────────────

describe('LocalProtectiveMonitor — arm', () => {
    it('arm inserts a position; isArmed returns true', () => {
        // BUILD
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );

        // OPERATE
        monitor.arm({ positionId: 1, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('29500'), takeProfitPrice: new Money('31000') });

        // CHECK
        expect(monitor.isArmed(1)).toBe(true);
    });

    it('isArmed returns false for a positionId that was never armed', () => {
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );

        expect(monitor.isArmed(999)).toBe(false);
    });

    it('arming the same positionId twice overwrites the entry (latest wins)', () => {
        // BUILD
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );

        // OPERATE
        monitor.arm({ positionId: 5, symbol: 'ETHUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('1900'), takeProfitPrice: new Money('2100') });
        monitor.arm({ positionId: 5, symbol: 'ETHUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('1850'), takeProfitPrice: new Money('2200') });

        // CHECK: still armed, one entry (overwrite, not duplicate)
        expect(monitor.isArmed(5)).toBe(true);
        const armed = monitor.listArmed();
        expect(armed.filter((p) => p.positionId === 5).length).toBe(1);
        expect(armed.find((p) => p.positionId === 5)?.stopLossPrice?.toFixed()).toBe('1850');
    });
});

describe('LocalProtectiveMonitor — disarm', () => {
    it('disarm removes the position; isArmed returns false', () => {
        // BUILD
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );
        monitor.arm({ positionId: 2, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('29500'), takeProfitPrice: new Money('31000') });

        // OPERATE
        monitor.disarm(2);

        // CHECK
        expect(monitor.isArmed(2)).toBe(false);
    });

    it('disarm on unknown positionId is a no-op and does not throw', () => {
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );

        // CHECK: must not throw
        expect(() => monitor.disarm(9999)).not.toThrow();
    });
});

describe('LocalProtectiveMonitor — listArmed', () => {
    it('listArmed returns all armed positions', () => {
        // BUILD
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );
        monitor.arm({ positionId: 10, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('29000'), takeProfitPrice: new Money('31000') });
        monitor.arm({ positionId: 11, symbol: 'ETHUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('1900'), takeProfitPrice: new Money('2100') });

        // CHECK
        const list = monitor.listArmed();
        expect(list.length).toBe(2);
    });

    it('listArmed is empty after all positions are disarmed', () => {
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );
        monitor.arm({ positionId: 20, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('29000'), takeProfitPrice: new Money('31000') });
        monitor.disarm(20);

        expect(monitor.listArmed().length).toBe(0);
    });

    it('two positions tracked independently — disarming one does not affect the other', () => {
        const monitor = new LocalProtectiveMonitor(
            { findById: jest.fn().mockResolvedValue(null) } as never,
            { evaluate: jest.fn() } as never,
            new EventEmitter2(),
        );
        monitor.arm({ positionId: 30, symbol: 'BTCUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('29000'), takeProfitPrice: new Money('31000') });
        monitor.arm({ positionId: 31, symbol: 'ETHUSDT', side: PositionSideEnum.LONG, stopLossPrice: new Money('1900'), takeProfitPrice: new Money('2100') });

        monitor.disarm(30);

        expect(monitor.isArmed(30)).toBe(false);
        expect(monitor.isArmed(31)).toBe(true);
    });
});

// ─── Integration tests — ExecutionService arm/disarm ordering ────────────────

function makeExecutionService(
    overrides: {
        attachResult?: ReturnType<typeof buildExchangeSideAttachResult> | ReturnType<typeof buildLocalFallbackAttachResult>;
    } = {},
) {
    const appConfig = { isExecutionLive: true } as AppConfigService;
    const localProtectiveMonitor = new LocalProtectiveMonitor(
        { findById: jest.fn().mockResolvedValue(null) } as never,
        { evaluate: jest.fn() } as never,
        new EventEmitter2(),
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
        submit: jest.fn().mockResolvedValue({
            state: SubmitStateEnum.FILLED,
            snapshot: filledSnapshot,
            rejectClass: null,
            venueCode: null,
            venueMessage: null,
        }),
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
    const attachResult = overrides.attachResult ?? buildExchangeSideAttachResult();

    const protectiveAttacher = {
        attach: jest.fn().mockImplementation(async () => {
            return attachResult;
        }),
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
        exchangeClient,
        events,
    );

    return { service, localProtectiveMonitor, protectiveAttacher, positions };
}

describe('ExecutionService — LocalProtectiveMonitor arm fires BEFORE attach', () => {
    it('monitor is armed when protectiveAttacher.attach is called', async () => {
        // BUILD: capture monitor state at the moment attach is called
        const { service, localProtectiveMonitor, protectiveAttacher } = makeExecutionService();
        let isArmedAtAttach = false;

        (protectiveAttacher.attach as jest.Mock).mockImplementation(async () => {
            isArmedAtAttach = localProtectiveMonitor.isArmed(42);
            return buildExchangeSideAttachResult();
        });

        // OPERATE
        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: arm was called synchronously before attach
        expect(isArmedAtAttach).toBe(true);
    });
});

describe('ExecutionService — exchange-side success disarms the monitor', () => {
    it('monitor is disarmed after a successful exchange-side attach', async () => {
        const { service, localProtectiveMonitor } = makeExecutionService({
            attachResult: buildExchangeSideAttachResult(),
        });

        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: exchange-side success → disarm called
        expect(localProtectiveMonitor.isArmed(42)).toBe(false);
    });
});

describe('ExecutionService — attach failure leaves monitor ARMED', () => {
    it('monitor stays armed when attach returns LOCAL_FALLBACK (position stays protected locally)', async () => {
        const { service, localProtectiveMonitor } = makeExecutionService({
            attachResult: buildLocalFallbackAttachResult('exchange rejected SL'),
        });

        await service.onOrderIntentApproved(buildApprovedEvent());

        // CHECK: attach failure → monitor must remain armed (protective type = LOCAL_FALLBACK)
        expect(localProtectiveMonitor.isArmed(42)).toBe(true);
        // position protective_order_type is LOCAL_FALLBACK
        expect(localProtectiveMonitor.listArmed().some((p) => p.positionId === 42)).toBe(true);
    });
});
