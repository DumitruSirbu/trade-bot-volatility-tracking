/**
 * M47 Task 5a (tech-debt M7) — close the async MFE/MAE seed-timing race.
 *
 * The bug: PositionInstrumentor seeded its accumulator via an async
 * @OnEvent(POSITION_OPENED_EVENT) handler that did a DB round-trip, and that
 * event is emitted at the END of the open path (after two awaited I/O
 * round-trips). Any PRICE_UPDATE_EVENT arriving during those awaits found
 * `positionsBySymbol` not yet populated and was silently dropped — losing the
 * entry-instant peak-excursion window (the most important window for a
 * volatility-spike strategy), so mfe_pct/mae_pct read near-zero.
 *
 * The fix: ExecutionService seeds the instrumentor SYNCHRONOUSLY right after
 * createPositionFromFill returns and BEFORE the first downstream await
 * (recordEntryTransactionOrEscalate) — onPositionOpened (register the symbol)
 * + applyEntryTick (seed mfe_pct=0/mae_pct=0).
 *
 * These tests are at the ExecutionService INTEGRATION level (BLOCKER 2 / HIGH 4):
 * a PositionInstrumentor unit test that delivers ticks in a chosen order does
 * NOT reproduce the real async race (the awaits between seed-site and the
 * legacy event emit). Here we wire a REAL PositionInstrumentor and deliver a
 * tick during the first downstream await to prove it is captured, not dropped.
 */

import { PositionSideEnum, StrategyDirectionEnum } from '@bot/shared';
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
import { PositionInstrumentor } from '../../../src/position/service/PositionInstrumentor';
import { PositionService } from '../../../src/position/service';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { buildApprovedEvent, buildExchangeSideAttachResult, buildOrderSnapshot } from '../support/fixtures';

const SYMBOL = 'BTCUSDT';
const ENTRY_PRICE = '30000';
const OPENED_AT_MS = 1_716_307_200_000;

function buildPositionRow(side: PositionSideEnum) {
    return {
        id: 42,
        symbol: SYMBOL,
        side,
        entryPrice: new Money(ENTRY_PRICE),
        openedAt: new Date(OPENED_AT_MS),
        vwapAtEntry: null,
        maePct: null,
        mfePct: null,
        timeToReversionSecs: null,
        markVsLastMaxDivergencePct: null,
        minLiquidationDistancePct: null,
        protectiveOrderType: 'local_fallback',
    };
}

// Wires a REAL PositionInstrumentor into ExecutionService. `onTickDuringRecord`,
// if provided, is invoked while the first downstream await
// (recordEntryTransactionOrEscalate → transactions.recordTerminal) is in flight —
// simulating a PRICE_UPDATE_EVENT arriving in the post-seed/pre-emit window.
function makeWiredService(side: PositionSideEnum, onTickDuringRecord?: () => void) {
    const appConfig = { isExecutionLive: true } as AppConfigService;

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: 'marketable_limit_ioc',
            limitPrice: new Money(ENTRY_PRICE),
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
        watchOrderBook: jest.fn().mockResolvedValue({ bids: [{ price: ENTRY_PRICE }], asks: [{ price: '30001' }] }),
    } as unknown as import('../../../src/exchange/interface').IExchangeClient;

    const clientOrderIdFactory = new ClientOrderIdFactory();

    const snapshot = buildOrderSnapshot({ filled: '0.01', average: ENTRY_PRICE, cost: '300', fee: '0.12' });
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

    const positionRow = buildPositionRow(side);
    const positions = {
        createOpen: jest.fn().mockResolvedValue(positionRow),
        save: jest.fn().mockResolvedValue(positionRow),
        findById: jest.fn().mockResolvedValue(positionRow),
    } as unknown as import('../../../src/position/repository/PositionRepository').PositionRepository;

    // The first downstream await on the open path. Firing the simulated tick from
    // inside it proves the symbol was registered BEFORE this await (post-fix) — the
    // pre-fix code only registered after the POSITION_OPENED_EVENT emit at the end.
    const transactions = {
        recordTerminal: jest.fn().mockImplementation(async () => {
            onTickDuringRecord?.();

            return { id: 1 };
        }),
    } as unknown as import('../../../src/position/repository/TransactionRepository').TransactionRepository;

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

    // Real instrumentor. riskGate stub returns isRecoveryReady=true so the periodic
    // flush guard does not interfere; the price-tick handler is not gated anyway.
    const instrumentor = new PositionInstrumentor(positions, { isRecoveryReady: () => true } as unknown as RiskGateService);

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
        { emitSyntheticClose: jest.fn() } as never,
        exchangeClient,
        events,
        { upsertAccountingForDay: jest.fn().mockResolvedValue(undefined) } as never,
        instrumentor,
    );

    return { service, instrumentor };
}

// Delivers a single mark-price tick through the instrumentor's price-update handler.
function deliverTick(instrumentor: PositionInstrumentor, price: string, timestampMs: number): void {
    instrumentor.onPriceUpdate({ symbol: SYMBOL, price, timestampMs });
}

describe('M47 Task 5a — synchronous instrumentor seed at open (no dropped entry-window ticks)', () => {
    it('seeds the accumulator and registers the symbol BEFORE the first downstream await captures a tick', async () => {
        let lifeStatsDuringRecord: ReturnType<PositionInstrumentor['getLifeStats']> = null;

        const { service, instrumentor } = makeWiredService(PositionSideEnum.LONG, () => {
            // A favorable LONG tick arriving while recordEntryTransactionOrEscalate is awaiting.
            // Pre-fix: positionsBySymbol is empty here → dropped. Post-fix: captured.
            deliverTick(instrumentor, '30300', OPENED_AT_MS + 1_000); // +1% favorable
            lifeStatsDuringRecord = instrumentor.getLifeStats(42);
        });

        await service.onOrderIntentApproved(buildApprovedEvent());

        // The tick delivered mid-await was captured: mfe_pct moved to +0.01 (1%).
        expect(lifeStatsDuringRecord).not.toBeNull();
        expect(lifeStatsDuringRecord!.mfePct?.equals(new Money('0.01'))).toBe(true);
    });

    it('the entry-tick seed yields mfe_pct = 0 and mae_pct = 0 at open', async () => {
        const { service, instrumentor } = makeWiredService(PositionSideEnum.LONG);

        await service.onOrderIntentApproved(buildApprovedEvent());

        const stats = instrumentor.getLifeStats(42);
        expect(stats).not.toBeNull();
        expect(stats!.mfePct?.equals(new Money('0'))).toBe(true);
        expect(stats!.maePct?.equals(new Money('0'))).toBe(true);
    });

    it('LONG: favorable then adverse ticks move mfe_pct >= 0 and mae_pct <= 0 (signed convention not inverted)', async () => {
        const { service, instrumentor } = makeWiredService(PositionSideEnum.LONG);

        await service.onOrderIntentApproved(buildApprovedEvent());

        deliverTick(instrumentor, '30600', OPENED_AT_MS + 1_000); // +2% favorable
        deliverTick(instrumentor, '29400', OPENED_AT_MS + 2_000); // -2% adverse

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.mfePct?.equals(new Money('0.02'))).toBe(true); // peak favorable, >= 0
        expect(stats.maePct?.equals(new Money('-0.02'))).toBe(true); // peak adverse, <= 0
    });

    it('SHORT: favorable then adverse ticks move mfe_pct >= 0 and mae_pct <= 0 (direction-correct)', async () => {
        const { service, instrumentor } = makeWiredService(PositionSideEnum.SHORT);

        await service.onOrderIntentApproved(buildApprovedEvent());

        // For a SHORT, a price DROP is favorable, a price RISE is adverse.
        deliverTick(instrumentor, '29400', OPENED_AT_MS + 1_000); // -2% price → +2% favorable
        deliverTick(instrumentor, '30600', OPENED_AT_MS + 2_000); // +2% price → -2% adverse

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.mfePct?.equals(new Money('0.02'))).toBe(true);
        expect(stats.maePct?.equals(new Money('-0.02'))).toBe(true);
    });

    it('a flat tick stream leaves both mfe_pct and mae_pct at the seeded 0', async () => {
        const { service, instrumentor } = makeWiredService(PositionSideEnum.LONG);

        await service.onOrderIntentApproved(buildApprovedEvent());

        deliverTick(instrumentor, ENTRY_PRICE, OPENED_AT_MS + 1_000); // no move
        deliverTick(instrumentor, ENTRY_PRICE, OPENED_AT_MS + 2_000);

        const stats = instrumentor.getLifeStats(42)!;
        expect(stats.mfePct?.equals(new Money('0'))).toBe(true);
        expect(stats.maePct?.equals(new Money('0'))).toBe(true);
    });
});
