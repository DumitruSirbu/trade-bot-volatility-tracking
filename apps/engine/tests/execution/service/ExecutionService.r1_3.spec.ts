/**
 * ExecutionService — R1.3.1c cleanup wave.
 *
 * Coverage (paired-per-fix, fail-before / pass-after):
 *   - `createPositionFromFill` used to stamp `openedAt: new Date()`. The fix
 *     captures `nowMs = Date.now()` ONCE at the `handleApproved` event-handler
 *     boundary and threads it down to `createPositionFromFill`, so the row's
 *     `openedAt` is deterministic across the submit-state-machine lifetime of
 *     one intent.
 *
 * We assert the determinism: two identical onOrderIntentApproved runs under a
 * frozen wall clock that advances between Date.now() calls within the SAME
 * intent still produce a single, stable `openedAt` for that intent (matches the
 * one-time boundary capture, not a per-call `new Date()`).
 */

import { PositionStateEnum, StrategyDirectionEnum } from '@bot/shared';
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
import { SharedCloseCoordinator } from '../../../src/execution/service/SharedCloseCoordinator';
import { OrderPolicyRouter } from '../../../src/execution/service/OrderPolicyRouter';
import { ProtectiveOrderAttacher } from '../../../src/execution/service/ProtectiveOrderAttacher';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../../src/position/repository/TransactionRepository';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot, buildPositionEntityMock } from '../support/fixtures';

const FROZEN_NOW_MS = 1_700_000_000_000;

function makeWiredService() {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: 'marketable_limit_ioc',
            limitPrice: new Money('30000'),
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
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: '30000' }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

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
        cancelByClientId: jest.fn(),
        fetchByClientId: jest.fn(),
        recover: jest.fn(),
    } as unknown as ExchangeOrderSubmitter;

    const fillAccumulator = new FillAccumulator();
    fillAccumulator.record(snapshot);

    const positionRow = buildPositionEntityMock(42);
    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
    } as unknown as PositionRepository;

    const transactions = { recordTerminal: jest.fn().mockResolvedValue({ id: 1 }) } as unknown as TransactionRepository;
    const strategyVersions = {
        findById: jest.fn().mockResolvedValue({ id: 1, direction: StrategyDirectionEnum.MEAN_REVERSION }),
    } as unknown as StrategyVersionRepository;

    const riskGate = { releaseReservation: jest.fn(), confirmReservation: jest.fn() } as unknown as RiskGateService;
    const events = new EventEmitter2();

    const protectiveAttacher = {
        attach: jest.fn().mockResolvedValue(buildExchangeSideAttachResult()),
    } as unknown as ProtectiveOrderAttacher;

    const positionService = {
        transition: jest.fn().mockImplementation(async () => positionRow),
    } as unknown as PositionService;

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

    return { service, positions };
}

describe('ExecutionService — R1.3.1c determinism (createPositionFromFill openedAt)', () => {
    it('stamps openedAt from the captured boundary nowMs, NOT from a per-call new Date() inside the row builder', async () => {
        const dateNowSpy = jest.spyOn(Date, 'now');

        // Boundary capture happens at handleApproved entry. We pin the value once,
        // then advance the wall clock arbitrarily before the inner row builder
        // runs. The fix asserts that openedAt reflects the BOUNDARY value, not
        // any later wall-clock reading.
        let callIndex = 0;
        dateNowSpy.mockImplementation(() => {
            callIndex++;
            // First call (handleApproved boundary) returns FROZEN_NOW_MS;
            // every subsequent call returns a far-future value. Pre-fix
            // `new Date()` would be used by createPositionFromFill and would
            // observe a different timestamp than the desired boundary; post-fix
            // the row's openedAt is the FROZEN_NOW_MS that handleApproved captured.
            return callIndex === 1 ? FROZEN_NOW_MS : FROZEN_NOW_MS + 9_999_999;
        });

        const { service, positions } = makeWiredService();

        await service.onOrderIntentApproved(buildApprovedEvent());

        dateNowSpy.mockRestore();

        expect(positions.createOpen).toHaveBeenCalledTimes(1);
        const insertedRow = (positions.createOpen as jest.Mock).mock.calls[0][0] as { state?: PositionStateEnum; openedAt: Date };
        expect(insertedRow.state).toBe(PositionStateEnum.PENDING_OPEN);

        // The load-bearing assertion: openedAt embeds the FIRST Date.now()
        // reading (boundary capture), not any later reading.
        expect(insertedRow.openedAt.getTime()).toBe(FROZEN_NOW_MS);
    });
});
