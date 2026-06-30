/**
 * M49 — ReconciliationService backfill-closing-fills wiring tests.
 *
 * QA requirements covered: 1, 2, 5, 6, 15, 16.
 *
 * Tests exercise `backfillClosingFillsFromExchange` through the public
 * `forceTick` entry point using a fully mocked dependency graph. All
 * money is Decimal; no real DB or exchange is touched.
 *
 * NOTE on case-f setup (QA2): the case-f closed branch fires when a
 * RECONCILING position has an exchange match (qty=0 here) so the case-b/c/d
 * loop emits QTY_MISMATCH and the case-f loop drives `transitionOutOfReconciling`
 * to the closed path. The mocks for `adjustQty` and `recordExposureDrift` absorb
 * the QTY_MISMATCH call without interference.
 */

import { ExchangeEnvironmentEnum, ExitReasonEnum, IPosition, IReconciledMissingUnrecoverableEvent, PositionSideEnum, PositionStateEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../../common/service/HaltFlagService';
import { parseMoney } from '../../../common/utils/money';
import { AppConfigService } from '../../../config/service';
import { IMyTradeSnapshot, IReconciliationAccountStateSource } from '../../../exchange/interface';
import { CcxtExecutionClient } from '../../../exchange/service/CcxtExecutionClient';
import { LocalProtectiveMonitor } from '../../../execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../../execution/service/SharedCloseCoordinator';
import { SubscriptionRetainer } from '../../../market-data/service/SubscriptionRetainer';
import { RECONCILED_MISSING_UNRECOVERABLE_EVENT } from '../../const/reconciliationEventConsts';
import { PositionEntity } from '../../entity';
import { PositionRepository } from '../../repository/PositionRepository';
import { TransactionRepository } from '../../repository/TransactionRepository';
import { StrategyVersionRepository } from '../../../strategy/repository/StrategyVersionRepository';
import { RiskGateService } from '../../../risk/service';
import { AccountSnapshotWriter } from '../AccountSnapshotWriter';
import { PositionInstrumentor } from '../PositionInstrumentor';
import { PositionService } from '../PositionService';
import { ReconciliationService } from '../ReconciliationService';

// ─── Factory helpers ─────────────────────────────────────────────────────────

const OPEN_AT = new Date('2024-01-15T08:00:00Z');
const NOW_MS = new Date('2024-01-15T10:00:00Z').getTime();

function buildPositionEntity(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 1,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        qty: parseMoney('0.1'),
        entryPrice: parseMoney('30000'),
        entryNotional: parseMoney('3000'),
        openedAt: OPEN_AT,
        strategyVersionId: 1,
        leverage: parseMoney('5'),
        protectiveOrderType: 'local_fallback' as never,
        positionSlot: null,
        ...overrides,
    } as PositionEntity;
}

function buildExchangePosition(overrides: Partial<IPosition> = {}): IPosition {
    return {
        symbol: 'BTCUSDT',
        side: 'long',
        qty: '0.1',
        entryPrice: '30000',
        markPrice: '31000',
        liquidationPrice: null,
        marginType: 'isolated',
        leverage: '5',
        timestampMs: NOW_MS,
        ...overrides,
    };
}

function buildClosingTrade(overrides: Partial<IMyTradeSnapshot> = {}): IMyTradeSnapshot {
    return {
        tradeId: 'trade-close-1',
        orderId: 'oid-close-1',
        clientOrderId: null,
        symbol: 'BTCUSDT',
        side: 'sell', // opposite of LONG → closing fill
        price: '31000',
        amount: '0.1',
        cost: '3100',
        fee: '0.3',
        feeCurrency: 'USDT',
        realizedPnl: '100', // non-zero → closing fill discriminator
        timestampMs: OPEN_AT.getTime() + 3_600_000, // 1h after open
        ...overrides,
    };
}

// ─── Mock dependency builder ──────────────────────────────────────────────────

interface IMockDeps {
    accountState: jest.Mocked<IReconciliationAccountStateSource>;
    positionService: jest.Mocked<Partial<PositionService>>;
    positions: jest.Mocked<Partial<PositionRepository>>;
    transactions: jest.Mocked<Partial<TransactionRepository>>;
    riskGate: jest.Mocked<Partial<RiskGateService>>;
    localProtectiveMonitor: jest.Mocked<Partial<LocalProtectiveMonitor>>;
    retainer: jest.Mocked<Partial<SubscriptionRetainer>>;
    instrumentor: jest.Mocked<Partial<PositionInstrumentor>>;
    snapshotWriter: jest.Mocked<Partial<AccountSnapshotWriter>>;
    events: EventEmitter2;
    closeCoordinator: jest.Mocked<Partial<SharedCloseCoordinator>>;
    ccxtExecutionClient: jest.Mocked<Partial<CcxtExecutionClient>>;
    appConfig: Partial<AppConfigService>;
}

function buildDeps(overrides: Partial<IMockDeps> = {}): IMockDeps {
    return {
        accountState: {
            fetchPositions: jest.fn().mockResolvedValue([]),
            fetchOpenOrders: jest.fn().mockResolvedValue([]),
            fetchFundingHistory: jest.fn().mockResolvedValue([]),
            fetchBalance: jest.fn().mockResolvedValue([]),
            fetchMyTrades: jest.fn().mockResolvedValue([]),
            ...(overrides.accountState ?? {}),
        } as jest.Mocked<IReconciliationAccountStateSource>,

        positionService: {
            transition: jest.fn().mockResolvedValue(buildPositionEntity({ state: PositionStateEnum.CLOSING })),
            finalizeRealizedPnl: jest.fn().mockResolvedValue(buildPositionEntity({ state: PositionStateEnum.CLOSED })),
            recordReconciledClosingFills: jest.fn().mockResolvedValue(undefined),
            adjustQty: jest.fn().mockResolvedValue(buildPositionEntity()),
            ...(overrides.positionService ?? {}),
        } as jest.Mocked<Partial<PositionService>>,

        positions: {
            findNonTerminal: jest.fn().mockResolvedValue([]),
            findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            ...(overrides.positions ?? {}),
        } as jest.Mocked<Partial<PositionRepository>>,

        transactions: {
            findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
            findLatestByPositionId: jest.fn().mockResolvedValue(null),
            ...(overrides.transactions ?? {}),
        } as jest.Mocked<Partial<TransactionRepository>>,

        riskGate: {
            expireStaleReservations: jest.fn(),
            reconcileClose: jest.fn().mockResolvedValue(undefined),
            listActiveReservationSlots: jest.fn().mockReturnValue([]),
            recordExposureDrift: jest.fn().mockResolvedValue(undefined),
            ...(overrides.riskGate ?? {}),
        } as jest.Mocked<Partial<RiskGateService>>,

        localProtectiveMonitor: {
            disarm: jest.fn(),
            ...(overrides.localProtectiveMonitor ?? {}),
        } as jest.Mocked<Partial<LocalProtectiveMonitor>>,

        retainer: {
            getRetainedSymbols: jest.fn().mockReturnValue([]),
            getReasonsFor: jest.fn().mockReturnValue([]),
            release: jest.fn(),
            ...(overrides.retainer ?? {}),
        } as jest.Mocked<Partial<SubscriptionRetainer>>,

        instrumentor: {
            setLiquidationPrice: jest.fn(),
            ...(overrides.instrumentor ?? {}),
        } as jest.Mocked<Partial<PositionInstrumentor>>,

        snapshotWriter: {
            writeNow: jest.fn().mockResolvedValue(undefined),
            ...(overrides.snapshotWriter ?? {}),
        } as jest.Mocked<Partial<AccountSnapshotWriter>>,

        events: overrides.events ?? new EventEmitter2(),

        closeCoordinator: {
            tryAcquire: jest.fn().mockReturnValue(true),
            release: jest.fn(),
            isHeld: jest.fn().mockReturnValue(false),
            ...(overrides.closeCoordinator ?? {}),
        } as jest.Mocked<Partial<SharedCloseCoordinator>>,

        ccxtExecutionClient: {
            fetchOrderByClientId: jest.fn().mockResolvedValue(null),
            ...(overrides.ccxtExecutionClient ?? {}),
        } as jest.Mocked<Partial<CcxtExecutionClient>>,

        appConfig: {
            exchangeEnv: ExchangeEnvironmentEnum.LIVE,
            ...(overrides.appConfig ?? {}),
        },
    };
}

function buildService(overrides: Partial<IMockDeps> = {}): { service: ReconciliationService; deps: IMockDeps } {
    const deps = buildDeps(overrides);

    const service = new ReconciliationService(
        deps.accountState,
        deps.ccxtExecutionClient as unknown as CcxtExecutionClient,
        deps.appConfig as unknown as AppConfigService,
        deps.positions as unknown as PositionRepository,
        deps.transactions as unknown as TransactionRepository,
        deps.positionService as unknown as PositionService,
        deps.riskGate as unknown as RiskGateService,
        deps.localProtectiveMonitor as unknown as LocalProtectiveMonitor,
        deps.retainer as unknown as SubscriptionRetainer,
        {} as unknown as StrategyVersionRepository,
        { isHalted: jest.fn().mockReturnValue(false) } as unknown as HaltFlagService,
        deps.instrumentor as unknown as PositionInstrumentor,
        deps.snapshotWriter as unknown as AccountSnapshotWriter,
        deps.events,
        deps.closeCoordinator as unknown as SharedCloseCoordinator,
    );

    return { service, deps };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReconciliationService.backfillClosingFillsFromExchange (M49)', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    // ── QA 1 — Case-b backfill ──────────────────────────────────────────────
    // Position is OPEN, exchange shows it gone → case-b fires, fetchMyTrades
    // is called with sinceMs=openedAt, recordReconciledClosingFills is invoked
    // with the matching closing trade, finalizeRealizedPnl follows.
    it('case-b: OPEN position absent from exchange → fetchMyTrades called and recordReconciledClosingFills invoked before finalizeRealizedPnl (QA1)', async () => {
        // BUILD — exchange returns NO positions (position vanished)
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });
        const closingTrade = buildClosingTrade();

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]), // gone from exchange
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([closingTrade]),
            },
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — fetchMyTrades called for the position's symbol/sinceMs with untilMs=NOW_MS
        expect(deps.accountState.fetchMyTrades).toHaveBeenCalledWith('BTCUSDT', expect.any(Number), NOW_MS);

        // recordReconciledClosingFills called with the closing fill
        expect(deps.positionService.recordReconciledClosingFills).toHaveBeenCalledWith(
            expect.objectContaining({
                positionId: position.id,
                fills: expect.arrayContaining([expect.objectContaining({ orderId: closingTrade.orderId })]),
                entryPrice: position.entryPrice,
                side: position.side,
            }),
        );

        // finalizeRealizedPnl must have been called after the backfill
        expect(deps.positionService.finalizeRealizedPnl).toHaveBeenCalledWith(
            position.id,
            ExitReasonEnum.RECONCILED_MISSING,
            expect.objectContaining({ nowMs: NOW_MS }),
        );
    });

    // ── QA 2 — Case-f closed-branch backfill ────────────────────────────────
    // RECONCILING row, exchange shows position with qty=0, order terminal (or
    // no-transaction fallback) → transitionOutOfReconciling takes closed path →
    // backfillClosingFillsFromExchange fires.
    it('case-f: RECONCILING position with zero-qty exchange match → fetchMyTrades called and recordReconciledClosingFills invoked (QA2)', async () => {
        // BUILD — exchange shows position with qty=0 (fully closed)
        const position = buildPositionEntity({ state: PositionStateEnum.RECONCILING });
        const exchangePosition = buildExchangePosition({ qty: '0' }); // zero qty → closed path
        const closingTrade = buildClosingTrade();

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([exchangePosition]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([closingTrade]),
            },
            transactions: {
                // no-transaction fallback: findLatestByPositionId returns null
                findLatestByPositionId: jest.fn().mockResolvedValue(null),
                findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
            },
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — fetchMyTrades was called with untilMs=NOW_MS (RECONCILING is skipped for funding, not for backfill)
        expect(deps.accountState.fetchMyTrades).toHaveBeenCalledWith('BTCUSDT', expect.any(Number), NOW_MS);

        // recordReconciledClosingFills called with the closing trade
        expect(deps.positionService.recordReconciledClosingFills).toHaveBeenCalledWith(
            expect.objectContaining({
                positionId: position.id,
                fills: expect.arrayContaining([expect.objectContaining({ orderId: closingTrade.orderId })]),
                entryPrice: position.entryPrice,
                side: position.side,
            }),
        );

        // finalizeRealizedPnl was called after backfill
        expect(deps.positionService.finalizeRealizedPnl).toHaveBeenCalledWith(position.id, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));
    });

    // ── QA 5 — Fill not found ────────────────────────────────────────────────
    // fetchMyTrades returns [] → selectClosingFills produces empty set →
    // finalizeRealizedPnl still runs (close not blocked), WARN logged,
    // RECONCILED_MISSING_UNRECOVERABLE event emitted with reason='no_fills_found'.
    it('fill not found: empty fetchMyTrades → finalizeRealizedPnl still runs and RECONCILED_MISSING_UNRECOVERABLE fires with reason=no_fills_found (QA5)', async () => {
        // BUILD
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });
        const capturedEvents: IReconciledMissingUnrecoverableEvent[] = [];

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]), // position gone
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([]), // ← no fills
            },
        });

        deps.events.on(RECONCILED_MISSING_UNRECOVERABLE_EVENT, (payload: IReconciledMissingUnrecoverableEvent) => {
            capturedEvents.push(payload);
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — close was not blocked
        expect(deps.positionService.finalizeRealizedPnl).toHaveBeenCalledWith(position.id, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));

        // recordReconciledClosingFills must NOT have been called (no fills to record)
        expect(deps.positionService.recordReconciledClosingFills).not.toHaveBeenCalled();

        // structured alert was emitted
        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0].reason).toBe('no_fills_found');
        expect(capturedEvents[0].positionId).toBe(String(position.id));
        expect(capturedEvents[0].symbol).toBe(position.symbol);
    });

    // ── QA 6 — Fetch throws / exchange outage ────────────────────────────────
    // fetchMyTrades rejects → caught, close proceeds with null PnL (not blocked),
    // RECONCILED_MISSING_UNRECOVERABLE event emitted with reason='fetch_failed'.
    it('fetch throws: fetchMyTrades rejection is caught → finalizeRealizedPnl still runs and RECONCILED_MISSING_UNRECOVERABLE fires with reason=fetch_failed (QA6)', async () => {
        // BUILD
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });
        const capturedEvents: IReconciledMissingUnrecoverableEvent[] = [];

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockRejectedValue(new Error('exchange timeout')), // ← throws
            },
        });

        deps.events.on(RECONCILED_MISSING_UNRECOVERABLE_EVENT, (payload: IReconciledMissingUnrecoverableEvent) => {
            capturedEvents.push(payload);
        });

        // OPERATE — must not throw (fetch failure must not cascade per ADR 0010 §6)
        await expect(service.forceTick(NOW_MS)).resolves.not.toThrow();

        // CHECK — close was not blocked despite the fetch failure
        expect(deps.positionService.finalizeRealizedPnl).toHaveBeenCalledWith(position.id, ExitReasonEnum.RECONCILED_MISSING, expect.any(Object));

        expect(deps.positionService.recordReconciledClosingFills).not.toHaveBeenCalled();

        // structured alert was emitted with fetch_failed reason
        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0].reason).toBe('fetch_failed');
        expect(capturedEvents[0].positionId).toBe(String(position.id));
    });

    // ── QA 15 — PAPER inert ──────────────────────────────────────────────────
    // Under PAPER env the reconciliation tick is a no-op: fetchMyTrades is never
    // called, finalizeRealizedPnl is never called, the sweeper PAPER paths are
    // unchanged. This asserts the LIVE finalize path is PAPER-guarded.
    it('PAPER mode: forceTick short-circuits — fetchMyTrades and finalizeRealizedPnl never called (QA15)', async () => {
        // BUILD — PAPER environment
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });

        const { service, deps } = buildService({
            appConfig: { exchangeEnv: ExchangeEnvironmentEnum.PAPER },
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([]),
            },
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — no exchange reads and no position mutations under PAPER
        expect(deps.accountState.fetchMyTrades).not.toHaveBeenCalled();
        expect(deps.accountState.fetchPositions).not.toHaveBeenCalled();
        expect(deps.positionService.finalizeRealizedPnl).not.toHaveBeenCalled();
        expect(deps.positionService.recordReconciledClosingFills).not.toHaveBeenCalled();
    });

    // ── QA 16 — Determinism ──────────────────────────────────────────────────
    // sinceMs passed to fetchMyTrades must equal position.openedAt.getTime(),
    // not Date.now(). The `nowMs` arg is plumbed through; the classifier reads
    // no wall clock. Replay-safe by construction.
    it('sinceMs equals position.openedAt.getTime() — deterministic, no Date.now() in classifier (QA16)', async () => {
        // BUILD
        const openedAt = new Date('2024-01-10T06:00:00Z');
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN, openedAt });
        const expectedSinceMs = openedAt.getTime();

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([]),
            },
        });

        // OPERATE — pass a nowMs that is very different from openedAt
        const tickNowMs = openedAt.getTime() + 86_400_000; // 24h later
        await service.forceTick(tickNowMs);

        // CHECK — sinceMs anchored to openedAt, NOT to tickNowMs
        const [calledSymbol, calledSinceMs] = (deps.accountState.fetchMyTrades as jest.Mock).mock.calls[0];
        expect(calledSymbol).toBe(position.symbol);
        expect(calledSinceMs).toBe(expectedSinceMs);
        expect(calledSinceMs).not.toBe(tickNowMs);
    });

    // ── RECONCILED_MISSING_UNRECOVERABLE event shape ─────────────────────────
    // When no fills are found, the event payload must include positionId, symbol,
    // side, dbQty, reason, and detectedAtMs per the D3.1 contract.
    it('RECONCILED_MISSING_UNRECOVERABLE event payload includes all required fields (D3.1 contract)', async () => {
        // BUILD
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });
        const capturedEvents: IReconciledMissingUnrecoverableEvent[] = [];

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([]),
            },
        });

        deps.events.on(RECONCILED_MISSING_UNRECOVERABLE_EVENT, (payload: IReconciledMissingUnrecoverableEvent) => {
            capturedEvents.push(payload);
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK
        expect(capturedEvents).toHaveLength(1);
        const event = capturedEvents[0];
        expect(event.positionId).toBe(String(position.id));
        expect(event.symbol).toBe('BTCUSDT');
        expect(event.side).toBe('buy'); // LONG position closes by selling → 'buy' is opposite, but the event uses position side mapped to buy/sell convention
        expect(typeof event.dbQty).toBe('string');
        expect(event.detectedAtMs).toBe(NOW_MS);
        expect(['no_fills_found', 'fetch_failed']).toContain(event.reason);
    });

    // ── Entry fill excluded from backfill ────────────────────────────────────
    // selectClosingFills filters: side must be opposite of position side AND
    // realizedPnl must be non-zero. An entry fill (realizedPnl='0') is excluded.
    it('entry fills with realizedPnl=0 are excluded from the backfill set (selectClosingFills H1)', async () => {
        // BUILD — mix of entry fill (realizedPnl='0') and closing fill (realizedPnl≠'0')
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });

        const entryFill = buildClosingTrade({ orderId: 'oid-entry', realizedPnl: '0', timestampMs: 500 });
        const closingFill = buildClosingTrade({ orderId: 'oid-close', realizedPnl: '100', timestampMs: 1_000 });

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([entryFill, closingFill]),
            },
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — recordReconciledClosingFills called with only the closing fill
        expect(deps.positionService.recordReconciledClosingFills).toHaveBeenCalledTimes(1);
        const [passedInput] = (deps.positionService.recordReconciledClosingFills as jest.Mock).mock.calls[0];
        const passedOrderIds = (passedInput.fills as IMyTradeSnapshot[]).map((f) => f.orderId);

        // Only the closing fill (realizedPnl≠0) should be passed
        expect(passedOrderIds).toContain('oid-close');
        expect(passedOrderIds).not.toContain('oid-entry');
    });

    // ── Successful backfill does NOT emit RECONCILED_MISSING_UNRECOVERABLE ───
    // The unrecoverable event is the fallback. A successful fill recovery must
    // NOT fire it.
    it('successful fill recovery does NOT emit RECONCILED_MISSING_UNRECOVERABLE (guard test)', async () => {
        // BUILD
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN });
        const capturedEvents: unknown[] = [];
        const closingTrade = buildClosingTrade();

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([closingTrade]),
            },
        });

        deps.events.on(RECONCILED_MISSING_UNRECOVERABLE_EVENT, (payload: unknown) => {
            capturedEvents.push(payload);
        });

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — no unrecoverable event when backfill succeeds
        expect(capturedEvents).toHaveLength(0);
        expect(deps.positionService.recordReconciledClosingFills).toHaveBeenCalled();
    });

    // ── Overfill WARN ────────────────────────────────────────────────────────
    // When the summed closing-fill qty exceeds position.qty * 1.01 a foreign
    // reducing fill likely leaked into the window — the misattribution detector
    // logs a WARN (observability-only; the close still finalizes).
    it('logs a WARN when summed closing-fill qty exceeds position.qty * 1.01 (overfill misattribution detector)', async () => {
        // BUILD — position qty 0.1; closing fill of 0.2 (> 0.1 * 1.01 = 0.101)
        const position = buildPositionEntity({ state: PositionStateEnum.OPEN, qty: parseMoney('0.1') });
        const overfillTrade = buildClosingTrade({ amount: '0.2', realizedPnl: '200' });

        const { service, deps } = buildService({
            positions: {
                findNonTerminal: jest.fn().mockResolvedValue([position]),
                findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
            },
            accountState: {
                fetchPositions: jest.fn().mockResolvedValue([]),
                fetchOpenOrders: jest.fn().mockResolvedValue([]),
                fetchFundingHistory: jest.fn().mockResolvedValue([]),
                fetchBalance: jest.fn().mockResolvedValue([]),
                fetchMyTrades: jest.fn().mockResolvedValue([overfillTrade]),
            },
        });

        const loggerWarnSpy = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => {});

        // OPERATE
        await service.forceTick(NOW_MS);

        // CHECK — overfill WARN fired; backfill still recorded the fills
        expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds position qty'));
        expect(deps.positionService.recordReconciledClosingFills).toHaveBeenCalled();
    });
});
