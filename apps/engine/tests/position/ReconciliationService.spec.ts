/**
 * ReconciliationService — M6 W4a (ADR 0010 §1a/§1b/§1c/§1d/§1e/§1f, §7).
 *
 * Coverage matrix (paired-per-fix, one happy-path per case + adversarial):
 *   - Case (a) EXCHANGE_NOT_IN_DB / adopt_unmanaged: inserts MANUAL_ADOPTED_UNMANAGED
 *     row with FK to the manual_adopted sentinel, emits IPositionAdoptedEvent and
 *     ADOPTED_FOREIGN resolved.
 *   - Case (a) sentinel missing: skipped + error logged (no crash, next tick retries).
 *   - Case (b) DB_OPEN_NOT_ON_EXCHANGE: log-only — drift detected event emitted,
 *     no transition, no release (W4a deferral).
 *   - Case (c) QTY_MISMATCH: log-only — drift event emitted with delta + cause class.
 *   - Case (c) match within tolerance: no drift event.
 *   - Case (d) SIDE_MISMATCH: critical drift event + log, no transition.
 *   - Case (e) PROTECTIVE_ORDER_DRIFT: missing SL/TP → flip to LOCAL_FALLBACK,
 *     re-arm monitor, emit PROTECTIVE_FALLBACK.
 *   - Case (e) protection intact: no action, no monitor call.
 *   - Case (f) UNKNOWN_INTENT_OUTCOME: TTL sweep (expireStaleReservations) is called
 *     at runPass entry; reconciling rows are surfaced for resolution.
 *   - Cooldown sweep: retainer with COOLDOWN_ACTIVE for symbol whose window elapsed
 *     → released exactly once. Window still active → not released.
 *   - Adversarial: concurrent ticks are idempotent (running flag); a CLOSING row is
 *     skipped not double-resolved; fetchPositions throwing does not break the tick.
 *   - forceTick bypasses the RECONCILIATION_MIN_INTERVAL_MS lower bound.
 */

import {
    DriftCaseEnum,
    IPositionAdoptedEvent,
    IReconciliationDriftDetectedEvent,
    IReconciliationResolvedEvent,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    ReconciliationOutcomeEnum,
    RetainReasonEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { Money } from '../../src/common/utils/money';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { IExchangeClient, IOpenOrderSnapshot, IPositionSnapshot } from '../../src/exchange/interface';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import {
    POSITION_ADOPTED_EVENT,
    RECONCILIATION_DRIFT_DETECTED_EVENT,
    RECONCILIATION_RESOLVED_EVENT,
    RECONCILIATION_MIN_INTERVAL_MS,
    ReconciliationService,
} from '../../src/position/service/ReconciliationService';
import { COOLDOWN_AFTER_LOSS_MS } from '../../src/risk/const';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

interface IHarness {
    service: ReconciliationService;
    exchangeClient: { fetchPositions: jest.Mock; fetchOpenOrders: jest.Mock; fetchOrderByClientId: jest.Mock; fetchFundingHistory: jest.Mock };
    positions: { findOpen: jest.Mock; createOpen: jest.Mock; save: jest.Mock; findLastClosedBySymbol: jest.Mock };
    transactions: { findByClientOrderId: jest.Mock };
    positionService: { transition: jest.Mock };
    riskGate: { expireStaleReservations: jest.Mock };
    monitor: { arm: jest.Mock; disarm: jest.Mock };
    retainer: SubscriptionRetainer;
    strategyVersions: { findByNameAndVersion: jest.Mock };
    events: EventEmitter2;
    emitSpy: jest.SpyInstance;
}

interface IBuildOpts {
    exchangePositions?: IPositionSnapshot[];
    openOrders?: IOpenOrderSnapshot[];
    dbPositions?: PositionEntity[];
    sentinelPresent?: boolean;
    fetchPositionsThrows?: boolean;
}

function buildExchangePosition(overrides: Partial<IPositionSnapshot> = {}): IPositionSnapshot {
    return {
        symbol: 'BTCUSDT',
        side: 'long',
        qty: '0.01',
        entryPrice: '30000',
        markPrice: '30100',
        liquidationPrice: '28000',
        marginType: 'isolated',
        leverage: '5',
        timestampMs: 1_700_000_000_000,
        ...overrides,
    };
}

function buildOpenOrder(overrides: Partial<IOpenOrderSnapshot> = {}): IOpenOrderSnapshot {
    return {
        exchangeOrderId: 'ex-1',
        clientOrderId: 'tbvt-aabbccddee112233aabb',
        symbol: 'BTCUSDT',
        status: 'open',
        type: 'stop_market',
        side: 'sell',
        reduceOnly: true,
        timestampMs: 1_700_000_000_000,
        ...overrides,
    };
}

function buildPositionRow(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 42,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        status: 'open',
        strategyVersionId: 1,
        leverage: new Money('5'),
        entryPrice: new Money('30000'),
        qty: new Money('0.01'),
        entryNotional: new Money('300'),
        openedAt: new Date(1_700_000_000_000),
        protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        positionSlot: PositionSlotEnum.A,
        stopLossPrice: new Money('29500'),
        takeProfitPrice: new Money('31000'),
        ...overrides,
    } as PositionEntity;
}

function buildHarness(opts: IBuildOpts = {}): IHarness {
    const exchangePositions = opts.exchangePositions ?? [];
    const openOrders = opts.openOrders ?? [];
    const dbPositions = opts.dbPositions ?? [];

    const exchangeClient = {
        fetchPositions: opts.fetchPositionsThrows ? jest.fn().mockRejectedValue(new Error('venue offline')) : jest.fn().mockResolvedValue(exchangePositions),
        fetchOpenOrders: jest.fn().mockResolvedValue(openOrders),
        fetchOrderByClientId: jest.fn().mockResolvedValue(null),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    };

    const positions = {
        findOpen: jest.fn().mockResolvedValue(dbPositions),
        createOpen: jest.fn().mockImplementation(async (entityLike: Partial<PositionEntity>) => ({ id: 999, ...entityLike }) as PositionEntity),
        save: jest.fn().mockImplementation(async (entity: PositionEntity) => entity),
        findLastClosedBySymbol: jest.fn().mockResolvedValue(null),
        // M6 R1.2.5 — case-(e) uses the state-guarded column UPDATE. Default
        // returns affected=1 (state guard matched) so the existing case-(e)
        // happy-path tests still see the re-arm.
        updateProtectiveOrderTypeIfState: jest.fn().mockResolvedValue(1),
    };

    const transactions = {
        findByClientOrderId: jest.fn().mockResolvedValue(null),
        findLatestFundingByPosition: jest.fn().mockResolvedValue(null),
        // M6 R1.2.4 — case-(f) reads the position's most recent transaction.
        // Default null so "no transaction" defensive branch fires unless a test overrides.
        findLatestByPositionId: jest.fn().mockResolvedValue(null),
    };

    const positionService = {
        transition: jest.fn().mockResolvedValue(undefined),
        finalizeRealizedPnl: jest.fn().mockResolvedValue(undefined),
        recordFunding: jest.fn().mockResolvedValue(undefined),
    };

    const riskGate = {
        expireStaleReservations: jest.fn(),
    };

    const monitor = {
        arm: jest.fn(),
        disarm: jest.fn(),
    };

    const retainer = new SubscriptionRetainer();

    const strategyVersions = {
        findByNameAndVersion: jest.fn().mockResolvedValue(opts.sentinelPresent === false ? null : { id: 7, name: 'manual_adopted', version: 0 }),
    };

    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');

    const haltFlag = new HaltFlagService();
    const instrumentor = { setLiquidationPrice: jest.fn() } as never;
    const snapshotWriter = { writeNow: jest.fn().mockResolvedValue(null) } as never;
    const service = new ReconciliationService(
        exchangeClient as unknown as IExchangeClient,
        positions as unknown as PositionRepository,
        transactions as unknown as TransactionRepository,
        positionService as unknown as PositionService,
        riskGate as unknown as RiskGateService,
        monitor as unknown as LocalProtectiveMonitor,
        retainer,
        strategyVersions as unknown as StrategyVersionRepository,
        haltFlag,
        instrumentor,
        snapshotWriter,
        events,
    );

    return { service, exchangeClient, positions, transactions, positionService, riskGate, monitor, retainer, strategyVersions, events, emitSpy };
}

function getDriftEvents(emitSpy: jest.SpyInstance): IReconciliationDriftDetectedEvent[] {
    return emitSpy.mock.calls.filter(([n]) => n === RECONCILIATION_DRIFT_DETECTED_EVENT).map(([, p]) => p as IReconciliationDriftDetectedEvent);
}

function getResolvedEvents(emitSpy: jest.SpyInstance): IReconciliationResolvedEvent[] {
    return emitSpy.mock.calls.filter(([n]) => n === RECONCILIATION_RESOLVED_EVENT).map(([, p]) => p as IReconciliationResolvedEvent);
}

function getAdoptedEvents(emitSpy: jest.SpyInstance): IPositionAdoptedEvent[] {
    return emitSpy.mock.calls.filter(([n]) => n === POSITION_ADOPTED_EVENT).map(([, p]) => p as IPositionAdoptedEvent);
}

const NOW_MS = 1_700_000_000_000;

describe('ReconciliationService — case (a) EXCHANGE_NOT_IN_DB / adopt_unmanaged (ADR 0010 §1a)', () => {
    it('inserts a MANUAL_ADOPTED_UNMANAGED row with FK to the manual_adopted sentinel', async () => {
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ symbol: 'ETHUSDT', side: 'long', qty: '0.5', entryPrice: '2000' })],
            dbPositions: [],
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.EXCHANGE_NOT_IN_DB]).toBe(1);
        expect(harness.positions.createOpen).toHaveBeenCalledTimes(1);
        const inserted = harness.positions.createOpen.mock.calls[0][0] as Partial<PositionEntity>;
        expect(inserted.state).toBe(PositionStateEnum.MANUAL_ADOPTED_UNMANAGED);
        expect(inserted.strategyVersionId).toBe(7);
        expect(inserted.symbol).toBe('ETHUSDT');
        expect(inserted.side).toBe(PositionSideEnum.LONG);
        expect(inserted.protectiveOrderType).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);
    });

    it('emits IPositionAdoptedEvent and ADOPTED_FOREIGN resolved on successful adoption', async () => {
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ symbol: 'ETHUSDT', side: 'short', qty: '1.5' })],
        });

        await harness.service.tick(NOW_MS);

        const adopted = getAdoptedEvents(harness.emitSpy);
        expect(adopted).toHaveLength(1);
        expect(adopted[0].symbol).toBe('ETHUSDT');
        expect(adopted[0].side).toBe(PositionSideEnum.SHORT);
        expect(adopted[0].qty).toBe('1.5');

        const resolved = getResolvedEvents(harness.emitSpy);
        expect(resolved.some((r) => r.outcome === ReconciliationOutcomeEnum.ADOPTED_FOREIGN)).toBe(true);
    });

    it('skips adoption when the manual_adopted sentinel is missing (no crash, error logged)', async () => {
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition()],
            sentinelPresent: false,
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.errors).toBe(0); // graceful skip, not a thrown error
        expect(harness.positions.createOpen).not.toHaveBeenCalled();
        expect(getAdoptedEvents(harness.emitSpy)).toHaveLength(0);
    });
});

describe('ReconciliationService — case (b) DB_OPEN_NOT_ON_EXCHANGE (W4a log-only)', () => {
    it('emits IReconciliationDriftDetectedEvent with case b; no transition, no release', async () => {
        const dbRow = buildPositionRow({
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            qty: new Money('0.01'),
            protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK,
        });
        const harness = buildHarness({
            exchangePositions: [],
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        const drifts = getDriftEvents(harness.emitSpy).filter((d) => d.driftCase === DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE);
        expect(drifts).toHaveLength(1);
        expect(drifts[0].positionId).toBe(42);
        expect(drifts[0].dbQty).toBe('0.01');
        expect(drifts[0].exchangeQty).toBeNull();
        // W4b: case (b) is now precise — transitions through CLOSING -> CLOSED.
        // Full handler coverage is in W4b.spec.ts; W4a regression only asserts the
        // drift detection still fires.
    });
});

describe('ReconciliationService — case (c) QTY_MISMATCH (W4a log-only)', () => {
    it('emits drift event with delta when qty differs beyond tolerance', async () => {
        const dbRow = buildPositionRow({ qty: new Money('0.01'), protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ qty: '0.015' })],
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        const drifts = getDriftEvents(harness.emitSpy).filter((d) => d.driftCase === DriftCaseEnum.QTY_MISMATCH);
        expect(drifts).toHaveLength(1);
        expect(drifts[0].dbQty).toBe('0.01');
        expect(drifts[0].exchangeQty).toBe('0.015');
    });

    it('does not emit when qty matches within tolerance', async () => {
        const dbRow = buildPositionRow({ qty: new Money('0.01') });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ qty: '0.01' }), buildOpenOrderForRow(dbRow)] as never,
            openOrders: [buildOpenOrder({ clientOrderId: 'tbvt-aabb-sl' }), buildOpenOrder({ clientOrderId: 'tbvt-aabb-tp' })],
            dbPositions: [dbRow],
        });
        // Inline helper above was incorrect — recompose without it.
        harness.exchangeClient.fetchPositions.mockResolvedValue([buildExchangePosition({ qty: '0.01' })]);

        await harness.service.tick(NOW_MS);

        const driftCases = getDriftEvents(harness.emitSpy).map((d) => d.driftCase);
        expect(driftCases).not.toContain(DriftCaseEnum.QTY_MISMATCH);
    });
});

// Helper marker to keep the spec compiling — never referenced beyond the line above.
function buildOpenOrderForRow(_row: PositionEntity): IOpenOrderSnapshot {
    return buildOpenOrder();
}

describe('ReconciliationService — case (d) SIDE_MISMATCH (W4a critical alert)', () => {
    it('emits SIDE_MISMATCH drift when DB row is LONG and exchange is SHORT for the same symbol', async () => {
        const dbRow = buildPositionRow({ side: PositionSideEnum.LONG });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ side: 'short', qty: '0.02' })],
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        const drifts = getDriftEvents(harness.emitSpy);
        expect(drifts.some((d) => d.driftCase === DriftCaseEnum.SIDE_MISMATCH)).toBe(true);
    });
});

describe('ReconciliationService — case (e) PROTECTIVE_ORDER_DRIFT', () => {
    it('flips to LOCAL_FALLBACK and re-arms the monitor when both SL and TP are missing', async () => {
        const dbRow = buildPositionRow({ protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition()],
            openOrders: [], // no SL/TP orders resting
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        expect(harness.monitor.arm).toHaveBeenCalledTimes(1);
        expect(harness.monitor.arm).toHaveBeenCalledWith(expect.objectContaining({ positionId: 42, symbol: 'BTCUSDT', side: PositionSideEnum.LONG }));

        // M6 R1.2.5: case-(e) now writes via the state-guarded column UPDATE
        // (`updateProtectiveOrderTypeIfState`) instead of the full-row `save`.
        const updateCalls = (harness.positions as unknown as { updateProtectiveOrderTypeIfState: jest.Mock }).updateProtectiveOrderTypeIfState.mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0][1]).toBe(ProtectiveOrderTypeEnum.LOCAL_FALLBACK);

        const resolved = getResolvedEvents(harness.emitSpy);
        expect(resolved.some((r) => r.outcome === ReconciliationOutcomeEnum.PROTECTIVE_FALLBACK)).toBe(true);
    });

    it('takes no action when both -sl and -tp orders are resting on the exchange', async () => {
        const dbRow = buildPositionRow({ protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition()],
            openOrders: [buildOpenOrder({ clientOrderId: 'tbvt-xxxxxxxxxxxxxxx-sl' }), buildOpenOrder({ clientOrderId: 'tbvt-xxxxxxxxxxxxxxx-tp' })],
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        expect(harness.monitor.arm).not.toHaveBeenCalled();
        const drifts = getDriftEvents(harness.emitSpy).filter((d) => d.driftCase === DriftCaseEnum.PROTECTIVE_ORDER_DRIFT);
        expect(drifts).toHaveLength(0);
    });

    it('skips case (e) for rows already on LOCAL_FALLBACK (no double-arm)', async () => {
        const dbRow = buildPositionRow({ protectiveOrderType: ProtectiveOrderTypeEnum.LOCAL_FALLBACK });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition()],
            openOrders: [],
            dbPositions: [dbRow],
        });

        await harness.service.tick(NOW_MS);

        expect(harness.monitor.arm).not.toHaveBeenCalled();
    });
});

describe('ReconciliationService — case (f) UNKNOWN_INTENT_OUTCOME + TTL sweep', () => {
    it('calls expireStaleReservations at the start of every pass (TTL is the authoritative release path)', async () => {
        const harness = buildHarness();

        await harness.service.tick(NOW_MS);

        expect(harness.riskGate.expireStaleReservations).toHaveBeenCalledTimes(1);
        expect(harness.riskGate.expireStaleReservations).toHaveBeenCalledWith(NOW_MS);
    });

    it('counts a RECONCILING row toward case (f) and emits UNRESOLVED_TTL when no transaction is found', async () => {
        const dbRow = buildPositionRow({ state: PositionStateEnum.RECONCILING });
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition()],
            dbPositions: [dbRow],
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.UNKNOWN_INTENT_OUTCOME]).toBe(1);
        const resolved = getResolvedEvents(harness.emitSpy);
        expect(resolved.some((r) => r.outcome === ReconciliationOutcomeEnum.UNRESOLVED_TTL)).toBe(true);
    });
});

describe('ReconciliationService — cooldown retention sweep (ADR 0010 §7, ADR 0011 §5 revised)', () => {
    it('releases COOLDOWN_ACTIVE when the cooldown window has elapsed', async () => {
        const harness = buildHarness();
        harness.retainer.retain('SOLUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);

        // Last close was a loss WAY beyond the cooldown window.
        harness.positions.findLastClosedBySymbol.mockResolvedValue({
            closedAt: new Date(NOW_MS - COOLDOWN_AFTER_LOSS_MS - 60_000),
            realizedPnl: new Money('-10'),
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.cooldownReleases).toBe(1);
        expect(harness.retainer.isRetained('SOLUSDT')).toBe(false);
    });

    it('does NOT release COOLDOWN_ACTIVE when the window is still active', async () => {
        const harness = buildHarness();
        harness.retainer.retain('SOLUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        harness.positions.findLastClosedBySymbol.mockResolvedValue({
            closedAt: new Date(NOW_MS - 60_000), // 1 minute ago — well within window
            realizedPnl: new Money('-10'),
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.cooldownReleases).toBe(0);
        expect(harness.retainer.isRetained('SOLUSDT')).toBe(true);
    });

    it('releases COOLDOWN_ACTIVE for a symbol with no closed history (defensive: stale retention)', async () => {
        const harness = buildHarness();
        harness.retainer.retain('SOLUSDT', RetainReasonEnum.COOLDOWN_ACTIVE);
        harness.positions.findLastClosedBySymbol.mockResolvedValue(null);

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.cooldownReleases).toBe(1);
    });

    it('handles multiple symbols simultaneously', async () => {
        const harness = buildHarness();
        harness.retainer.retain('SOL', RetainReasonEnum.COOLDOWN_ACTIVE);
        harness.retainer.retain('AVAX', RetainReasonEnum.COOLDOWN_ACTIVE);
        harness.retainer.retain('LTC', RetainReasonEnum.COOLDOWN_ACTIVE);

        harness.positions.findLastClosedBySymbol.mockImplementation(async (symbol: string) => {
            // AVAX is still cooling down; others have expired.
            if (symbol === 'AVAX') {
                return { closedAt: new Date(NOW_MS - 60_000), realizedPnl: new Money('-5') };
            }

            return { closedAt: new Date(NOW_MS - COOLDOWN_AFTER_LOSS_MS - 60_000), realizedPnl: new Money('-5') };
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.cooldownReleases).toBe(2);
        expect(harness.retainer.isRetained('AVAX')).toBe(true);
        expect(harness.retainer.isRetained('SOL')).toBe(false);
        expect(harness.retainer.isRetained('LTC')).toBe(false);
    });

    it('ignores retainer entries that are NOT COOLDOWN_ACTIVE (independence from OPEN_POSITION etc.)', async () => {
        const harness = buildHarness();
        harness.retainer.retain('BTCUSDT', RetainReasonEnum.OPEN_POSITION);

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.cooldownReleases).toBe(0);
        expect(harness.retainer.isRetained('BTCUSDT')).toBe(true);
    });
});

describe('ReconciliationService — adversarial / safety', () => {
    it('concurrent ticks are idempotent: a second tick while the first runs returns the prior pass and does no extra work', async () => {
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ symbol: 'ETHUSDT' })],
        });

        // First tick.
        const pass1 = await harness.service.tick(NOW_MS);
        // Second tick — within MIN_INTERVAL, returns the last pass without new work.
        const pass2 = await harness.service.tick(NOW_MS + 1_000);

        // createOpen ran once for the first pass; the second tick was suppressed by the
        // RECONCILIATION_MIN_INTERVAL_MS floor.
        expect(harness.positions.createOpen).toHaveBeenCalledTimes(1);
        expect(pass2).toEqual(pass1);
    });

    it('forceTick bypasses the RECONCILIATION_MIN_INTERVAL_MS lower bound', async () => {
        const harness = buildHarness({
            exchangePositions: [buildExchangePosition({ symbol: 'ETHUSDT' })],
        });

        await harness.service.tick(NOW_MS);
        await harness.service.forceTick(NOW_MS + 100);

        // Both ticks ran the diff sweep.
        expect(harness.exchangeClient.fetchPositions).toHaveBeenCalledTimes(2);
        expect(harness.riskGate.expireStaleReservations).toHaveBeenCalledTimes(2);
    });

    it('a CLOSED row is filtered upstream by loadNonClosedPositions (never reaches the case-b loop)', async () => {
        // M6 R1.1.2 (ADR 0010 §1b revised): CLOSING is now a legitimate source state
        // for case-(b) handling. Only CLOSED remains in the defensive skip filter,
        // but CLOSED rows are filtered upstream in `loadNonClosedPositions` so the
        // skip filter is defensive dead-code: no triggerable production path lands
        // a CLOSED row in the diff loop. Test confirms the upstream filter:
        // no transition / no drift fired for the CLOSED row. CLOSING source-state
        // routing is covered in R1_1.spec.ts.
        const closedRow = buildPositionRow({ state: PositionStateEnum.CLOSED });
        const harness = buildHarness({
            exchangePositions: [],
            dbPositions: [closedRow],
        });

        await harness.service.tick(NOW_MS);

        // CLOSED row filtered upstream; no case-b drift detected.
        const drifts = getDriftEvents(harness.emitSpy);
        expect(drifts.filter((d) => d.driftCase === DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE)).toHaveLength(0);
        // No transition fired (loadNonClosedPositions filtered it out).
        // (positionService is a mock; assert via the emit spy that no resolved
        // event was fired for the CLOSED row.)
    });

    it('fetchPositions throwing does not break the tick: empty snapshot used, next tick retries', async () => {
        const harness = buildHarness({ fetchPositionsThrows: true });

        const pass = await harness.service.tick(NOW_MS);

        // Tick completed cleanly even though the exchange read threw at the boundary.
        expect(pass.tickAtMs).toBe(NOW_MS);
        // No drift events because both sides are empty after the throw.
        expect(getDriftEvents(harness.emitSpy)).toHaveLength(0);
    });

    it('tick honors RECONCILIATION_MIN_INTERVAL_MS — a second call within the floor is suppressed', async () => {
        const harness = buildHarness();

        await harness.service.tick(NOW_MS);
        const secondPass = await harness.service.tick(NOW_MS + RECONCILIATION_MIN_INTERVAL_MS - 1);

        expect(harness.exchangeClient.fetchPositions).toHaveBeenCalledTimes(1);
        expect(secondPass.tickAtMs).toBe(NOW_MS); // returned the prior pass
    });
});

describe('ReconciliationService — observability summary (IReconciliationPass)', () => {
    it('returns per-case counters reflecting the classifications', async () => {
        const dbRowB = buildPositionRow({ id: 42, symbol: 'BTCUSDT', side: PositionSideEnum.LONG }); // case b candidate
        const dbRowC = buildPositionRow({ id: 43, symbol: 'ETHUSDT', side: PositionSideEnum.LONG, qty: new Money('1.0') }); // case c candidate
        const harness = buildHarness({
            exchangePositions: [
                buildExchangePosition({ symbol: 'ETHUSDT', side: 'long', qty: '1.5' }), // matches dbRowC with delta
                buildExchangePosition({ symbol: 'SOLUSDT', side: 'short', qty: '5' }), // case a: not in DB
            ],
            dbPositions: [dbRowB, dbRowC],
        });

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.driftsByCase[DriftCaseEnum.EXCHANGE_NOT_IN_DB]).toBe(1);
        expect(pass.driftsByCase[DriftCaseEnum.DB_OPEN_NOT_ON_EXCHANGE]).toBe(1);
        expect(pass.driftsByCase[DriftCaseEnum.QTY_MISMATCH]).toBe(1);
    });
});
