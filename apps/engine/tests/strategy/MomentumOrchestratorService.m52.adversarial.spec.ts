/**
 * MomentumOrchestratorService — M52 D1+D2 ADVERSARIAL QA pass (ADR 0051).
 *
 * Independent QA coverage beyond the D1/D2 paired-test specs (MomentumOrchestratorService.m52.spec.ts
 * / .m52d2.spec.ts). These target race/ordering edge cases, multi-symbol cross-contamination, the
 * D1+D2 attempt-cap interaction end-to-end, and version-swap-mid-cycle abandonment.
 *
 * Coverage map:
 *   AQ1 — two DIFFERENT symbols force_close in the same cycle → independent ledger/arm entries,
 *         no cross-contamination (each keyed by its own symbol).
 *   AQ2 — a re-entrant CANDLE_CLOSED_EVENT for the same armed symbol (arriving twice before the
 *         first onCandleClosed's await chain resolves) fires the retry AT MOST ONCE — the arm is
 *         deleted synchronously before the awaited gate re-entry (verifies no double-fire even
 *         under artificial re-entrancy, not just sequential calls).
 *   AQ3 — end-to-end D1+D2: an eligible retry fires, and its OWN fill is ALSO force_close'd →
 *         the second force_close on the same (cycle, symbol) is EXHAUSTED, not re-armed.
 *   AQ4 — a strategy-version swap mid-cycle (resolveActiveVersion picks up a new id) makes a
 *         force_close report for the OLD version SUPERSEDED, and the stale-version armed retry is
 *         abandoned at fire time by the top_n re-check against the NEW version's open count.
 *   AQ5 — boundary: MAX_WAIT_MS exactly at the threshold fires; one ms over abandons (off-by-one
 *         direction on the abandonment guard).
 */

import {
    CoinTierEnum,
    ExchangeEnvironmentEnum,
    OrderIntentActionEnum,
    PortfolioSelectionReasonEnum,
    PositionSlotEnum,
    RebalanceTriggerSourceEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { MOMENTUM_RETRY_EXHAUSTED, MOMENTUM_RETRY_MAX_WAIT_MS, MOMENTUM_RETRY_SUPERSEDED } from '../../src/strategy/const';
import { AppConfigService } from '../../src/config/service';
import { ICandle } from '../../src/market-data/interface/ICandle';
import { ICandleClosedEvent } from '../../src/market-data/interface/ICandleClosedEvent';
import { CandleRepository } from '../../src/market-data/repository/CandleRepository';
import { UniverseMembershipRepository } from '../../src/market-data/repository/UniverseMembershipRepository';
import { SymbolStateRegistry } from '../../src/market-data/service/SymbolStateRegistry';
import { UniverseService } from '../../src/market-data/service/UniverseService';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { InstrumentPortAdapter, OpenPositionsPortAdapter, PositionSizer, RiskGateService, RiskStatePortAdapter } from '../../src/risk/service';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { MomentumOrchestratorService } from '../../src/strategy/service/MomentumOrchestratorService';
import { XMomPortfolioStrategy } from '../../src/strategy/strategies/XMomPortfolioStrategy';
import { IMomentumFillForceClosedEvent } from '../../src/common/interface';
import { Money } from '../../src/common/utils/money';

const NOW_MS = 1_700_000_000_000;
const ACTIVE_VERSION_ID = 7;
const OTHER_VERSION_ID = 8;
const TOP_N = 3;
const CYCLE_ID = `xmom-cycle-${NOW_MS}-${RebalanceTriggerSourceEnum.SCHEDULED}`;
const FIVE_MIN_MS = 5 * 60_000;
const FRESH_BAR_CLOSE = '123.45';

function buildMockBars(count = 20, close = '100'): ICandle[] {
    return Array.from({ length: count }, (_, index) => ({
        openTimeMs: NOW_MS - (count - index) * FIVE_MIN_MS,
        open: new Money('100'),
        high: new Money('110'),
        low: new Money('90'),
        close: new Money(index === count - 1 ? close : '100'),
        volume: new Money('1000'),
        quoteVolume: new Money('100000'),
        isClosed: true,
    }));
}

function buildSymbolState(freshClose = FRESH_BAR_CLOSE) {
    const bars = buildMockBars(20, freshClose);

    return {
        movePctOverWindow: jest.fn().mockReturnValue(5.0),
        candles5m: {
            getLatestClosedBar: jest.fn().mockReturnValue(bars[bars.length - 1]),
            getClosedBars: jest.fn().mockReturnValue(bars),
        },
        getFundingRate: jest.fn().mockReturnValue(0),
        getFundingRateAnnualized: jest.fn().mockReturnValue(0),
        getSpreadPct: jest.fn().mockReturnValue(0),
        latestOpenInterest: jest.fn().mockReturnValue(new Money('0')),
        getBookDepth10bpsUsdt: jest.fn().mockReturnValue(new Money('0')),
        getBookDepth50bpsUsdt: jest.fn().mockReturnValue(new Money('0')),
    };
}

function buildApprovedDecision() {
    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: {
            qty: new Money('0.01'),
            notional: new Money('100'),
            leverage: new Money('1'),
            riskPerTradeUsdt: new Money('10'),
            effectiveRiskUsdt: new Money('10'),
        },
        clampedExit: null,
        haltReasonDetail: null,
        reservationId: 'test-res',
    };
}

interface IMockSet {
    config: Record<string, unknown>;
    strategyVersions: { findById: jest.Mock };
    universe: { getEntries: jest.Mock; getEntry: jest.Mock };
    symbolStates: { get: jest.Mock };
    candles: { findRange: jest.Mock };
    positions: { findOpen: jest.Mock };
    riskGate: { evaluate: jest.Mock };
    instrumentPort: { findConstraints: jest.Mock };
    sizer: { size: jest.Mock };
    riskStatePort: Record<string, jest.Mock>;
    openPositionsPort: Record<string, jest.Mock>;
    universeMembership: { findOpenMembership: jest.Mock };
    decisions: { record: jest.Mock };
    strategy: { selectUniverse: jest.Mock };
    events: { emit: jest.Mock };
}

function buildDefaultMocks(xmomForceCloseRetry = true): IMockSet {
    return {
        config: {
            exchangeEnv: ExchangeEnvironmentEnum.PAPER,
            activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            accountCapitalUsdt: 1000,
            maxOpenPositions: 3,
            maxExposurePerCoinUsdt: 500,
            dailyLossLimitUsdt: 100,
            weeklyLossLimitUsdt: 300,
            maxSameDirectionExposureUsdt: 800,
            cooldownAfterLossMs: 0,
            paperRelaxConsecutiveLossHalt: false,
            xmomForceCloseRetry,
        },
        strategyVersions: {
            findById: jest.fn().mockResolvedValue({
                id: ACTIVE_VERSION_ID,
                name: 'xmom',
                version: 1,
                params: {
                    top_n: TOP_N,
                    lookback_ms: 86_400_000,
                    rebalance_interval_ms: 86_400_000,
                    min_universe_size: 5,
                    xmom_atr_stop_multiplier: 2.0,
                    xmom_min_rr: 1.5,
                    xmom_tp_arm_rr: 1.5,
                },
            }),
        },
        universe: {
            getEntries: jest.fn().mockReturnValue([]),
            getEntry: jest.fn().mockReturnValue({ symbol: 'X', volumeRank: 1, tier: CoinTierEnum.TIER_1 }),
        },
        symbolStates: { get: jest.fn().mockReturnValue(null) },
        candles: { findRange: jest.fn().mockResolvedValue([]) },
        positions: { findOpen: jest.fn().mockResolvedValue([]) },
        riskGate: { evaluate: jest.fn().mockResolvedValue(buildApprovedDecision()) },
        instrumentPort: {
            findConstraints: jest.fn().mockResolvedValue({
                symbol: 'BTCUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.1'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        },
        sizer: {
            size: jest.fn().mockReturnValue({
                kind: 'sized',
                sizing: {
                    qty: new Money('0.01'),
                    notional: new Money('100'),
                    leverage: new Money('1'),
                    riskPerTradeUsdt: new Money('10'),
                    effectiveRiskUsdt: new Money('10'),
                },
            }),
        },
        riskStatePort: {
            getDay: jest.fn().mockResolvedValue(null),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money('0')),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        },
        openPositionsPort: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
            findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
            countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
        },
        universeMembership: { findOpenMembership: jest.fn().mockResolvedValue({}) },
        decisions: { record: jest.fn().mockResolvedValue({}) },
        strategy: {
            selectUniverse: jest.fn().mockReturnValue({ ranked: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS }),
        },
        events: { emit: jest.fn() },
    };
}

async function buildTestModule(mocks: IMockSet): Promise<{ service: MomentumOrchestratorService; mocks: IMockSet }> {
    const module: TestingModule = await Test.createTestingModule({
        providers: [
            MomentumOrchestratorService,
            { provide: AppConfigService, useValue: mocks.config },
            { provide: StrategyVersionRepository, useValue: mocks.strategyVersions },
            { provide: UniverseService, useValue: mocks.universe },
            { provide: SymbolStateRegistry, useValue: mocks.symbolStates },
            { provide: CandleRepository, useValue: mocks.candles },
            { provide: PositionRepository, useValue: mocks.positions },
            { provide: RiskGateService, useValue: mocks.riskGate },
            { provide: InstrumentPortAdapter, useValue: mocks.instrumentPort },
            { provide: PositionSizer, useValue: mocks.sizer },
            { provide: RiskStatePortAdapter, useValue: mocks.riskStatePort },
            { provide: OpenPositionsPortAdapter, useValue: mocks.openPositionsPort },
            { provide: UniverseMembershipRepository, useValue: mocks.universeMembership },
            { provide: DecisionRepository, useValue: mocks.decisions },
            { provide: XMomPortfolioStrategy, useValue: mocks.strategy },
            { provide: EventEmitter2, useValue: mocks.events },
        ],
    }).compile();

    return { service: module.get(MomentumOrchestratorService), mocks };
}

function primeCycleState(service: MomentumOrchestratorService, versionId = ACTIVE_VERSION_ID): void {
    const anyService = service as unknown as {
        activeVersionId: number;
        activeParams: Record<string, number | boolean | null>;
        currentCycleId: string;
        currentCycleNowMs: number;
        currentTriggerSource: RebalanceTriggerSourceEnum;
    };
    anyService.activeVersionId = versionId;
    anyService.activeParams = {
        top_n: TOP_N,
        lookback_ms: 86_400_000,
        rebalance_interval_ms: 86_400_000,
        min_universe_size: 5,
        xmom_atr_stop_multiplier: 2.0,
        xmom_min_rr: 1.5,
        xmom_tp_arm_rr: 1.5,
        xmom_max_depth_fraction: null,
        xmom_expected_fill_enabled: false,
    };
    anyService.currentCycleId = CYCLE_ID;
    anyService.currentCycleNowMs = NOW_MS;
    anyService.currentTriggerSource = RebalanceTriggerSourceEnum.SCHEDULED;
}

function armedMap(service: MomentumOrchestratorService): Map<string, unknown> {
    return (service as unknown as { armedRetries: Map<string, unknown> }).armedRetries;
}

function retryAttemptsMap(service: MomentumOrchestratorService): Map<string, number> {
    return (service as unknown as { retryAttempts: Map<string, number> }).retryAttempts;
}

function buildForceClosedEvent(symbol: string, overrides: Partial<IMomentumFillForceClosedEvent> = {}): IMomentumFillForceClosedEvent {
    return {
        rebalanceCycleId: CYCLE_ID,
        symbol,
        strategyVersionId: ACTIVE_VERSION_ID,
        rank: 2,
        atrUnitsDrift: new Money('0.5'),
        driftPct: new Money('0.3'),
        reason: 'sl_below_floor',
        ...overrides,
    };
}

function buildCandleEvent(symbol: string, barCloseOffsetMs = FIVE_MIN_MS): ICandleClosedEvent {
    const openTimeMs = NOW_MS + barCloseOffsetMs - FIVE_MIN_MS;

    return {
        symbol,
        interval: '5m',
        candle: {
            openTimeMs,
            open: new Money('120'),
            high: new Money('130'),
            low: new Money('118'),
            close: new Money(FRESH_BAR_CLOSE),
            volume: new Money('1000'),
            quoteVolume: new Money('120000'),
            isClosed: true,
        },
    };
}

function primeFreshBuild(mocks: IMockSet, symbol: string): void {
    mocks.symbolStates.get.mockImplementation((sym: string) => (sym === symbol ? buildSymbolState() : null));
    mocks.candles.findRange.mockResolvedValue(buildMockBars(20, FRESH_BAR_CLOSE));
    mocks.universe.getEntry.mockReturnValue({ symbol, volumeRank: 1, tier: CoinTierEnum.TIER_1 });
}

function approvedOpenCalls(mocks: IMockSet) {
    return mocks.events.emit.mock.calls.filter((call) => call[0] === ORDER_INTENT_APPROVED_EVENT && call[1].intent.intentAction === OrderIntentActionEnum.OPEN);
}

describe('MomentumOrchestratorService — M52 adversarial QA', () => {
    describe('AQ1 — two different symbols force_close in the same cycle, independently', () => {
        it('arms both symbols independently with no cross-contamination of the attempt ledger', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));
            await service.onMomentumFillForceClosed(buildForceClosedEvent('WLDUSDT'));

            expect(armedMap(service).has('FARTCOINUSDT')).toBe(true);
            expect(armedMap(service).has('WLDUSDT')).toBe(true);
            // Independent ledger entries — one attempt each, not a shared counter.
            expect(retryAttemptsMap(service).get(`${CYCLE_ID}::FARTCOINUSDT`)).toBe(1);
            expect(retryAttemptsMap(service).get(`${CYCLE_ID}::WLDUSDT`)).toBe(1);
        });

        it('firing one armed symbol does not consume or disturb the other armed symbol', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);
            primeFreshBuild(mocks, 'FARTCOINUSDT');

            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));
            await service.onMomentumFillForceClosed(buildForceClosedEvent('WLDUSDT'));
            expect(armedMap(service).size).toBe(2);

            await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS));

            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
            // WLD's arm is untouched by FARTCOIN's fire.
            expect(armedMap(service).has('WLDUSDT')).toBe(true);
        });
    });

    describe('AQ2 — re-entrant bar-close for the same armed symbol cannot double-fire', () => {
        // Regression test for a race the architect classified as an implementation bug (round 1
        // fix): `onCandleClosed` now claims the arm — `this.armedRetries.delete(event.symbol)` —
        // synchronously before the `await fireArmedRetry(...)` call. Since Map.get+Map.delete never
        // suspend, a second concurrent onCandleClosed for the SAME symbol (e.g. a duplicate/replayed
        // CANDLE_CLOSED_EVENT from a websocket reconnect, or MarketDataService draining two closed
        // bars back-to-back for a quiet symbol) sees the arm already gone and is a no-op, regardless
        // of how many awaits fireArmedRetry itself contains.
        it('two concurrent onCandleClosed calls for the same symbol fire AT MOST ONCE — the arm is claimed before the first await', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks, 'FARTCOINUSDT');
            mocks.positions.findOpen.mockResolvedValue([]);

            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(true);

            const event = buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS);
            await Promise.all([service.onCandleClosed(event), service.onCandleClosed(event)]);

            const opens = approvedOpenCalls(mocks).filter((call) => call[1].intent.symbol === 'FARTCOINUSDT');
            expect(opens).toHaveLength(1);
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        });
    });

    describe('AQ3 — D1+D2 together: the retry fires, and its OWN fill also force_closes', () => {
        it('a second force_close of the retried symbol in the same cycle is EXHAUSTED, not re-armed', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks, 'FARTCOINUSDT');
            mocks.positions.findOpen.mockResolvedValue([]);

            // First force_close → eligible → armed.
            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(true);

            // Fire the retry — it re-enters the gate and is approved (consumes the arm).
            await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS));
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
            expect(approvedOpenCalls(mocks).some((call) => call[1].intent.symbol === 'FARTCOINUSDT')).toBe(true);

            // The retry's OWN fill also force_closes — same cycle, same symbol, second report.
            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));

            // NOT re-armed — the attempt cap (MOMENTUM_RETRY_MAX_ATTEMPTS_PER_SYMBOL=1) bites.
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        });

        it('the second force_close decision is logged as MOMENTUM_RETRY_EXHAUSTED', async () => {
            const { Logger } = await import('@nestjs/common');
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks, 'FARTCOINUSDT');
            mocks.positions.findOpen.mockResolvedValue([]);

            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));
            await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS));

            const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
            await service.onMomentumFillForceClosed(buildForceClosedEvent('FARTCOINUSDT'));

            expect(logSpy.mock.calls.some((call) => String(call[0]).startsWith(MOMENTUM_RETRY_EXHAUSTED))).toBe(true);
            logSpy.mockRestore();
        });
    });

    describe('AQ4 — strategy-version swap mid-cycle abandons stale-version activity', () => {
        it('a force_close report stamped with the OLD version is SUPERSEDED once activeVersionId has advanced', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service, ACTIVE_VERSION_ID);
            mocks.positions.findOpen.mockResolvedValue([]);

            // Version swap happens (e.g. operator changed ACTIVE_STRATEGY_VERSION_ID + restart-equivalent
            // resolveActiveVersion re-read) — activeVersionId now points at a new version.
            (service as unknown as { activeVersionId: number }).activeVersionId = OTHER_VERSION_ID;

            const decision = await (
                service as unknown as { evaluateRetryEligibility(e: IMomentumFillForceClosedEvent): Promise<{ outcome: string; eligible: boolean }> }
            ).evaluateRetryEligibility(buildForceClosedEvent('FARTCOINUSDT', { strategyVersionId: ACTIVE_VERSION_ID }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_SUPERSEDED);
            expect(decision.eligible).toBe(false);
        });

        it('an armed retry from before a new rebalance cycle is dropped even if it targets the new activeVersionId basket', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service, ACTIVE_VERSION_ID);
            armedMap(service).set('FARTCOINUSDT', {
                symbol: 'FARTCOINUSDT',
                rank: 2,
                rebalanceCycleId: CYCLE_ID,
                triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
                armedAtMs: NOW_MS,
            });

            // A new rebalance cycle runs under the (now-swapped) version, clearing stale arms
            // regardless of which version they were opened under (ADR 0051 §3.3).
            mocks.strategyVersions.findById.mockResolvedValue({
                id: OTHER_VERSION_ID,
                name: 'xmom',
                version: 2,
                params: {
                    top_n: TOP_N,
                    lookback_ms: 86_400_000,
                    rebalance_interval_ms: 86_400_000,
                    min_universe_size: 5,
                    xmom_atr_stop_multiplier: 2.0,
                    xmom_min_rr: 1.5,
                    xmom_tp_arm_rr: 1.5,
                },
            });
            mocks.config.activePortfolioStrategyVersionId = OTHER_VERSION_ID;

            await service.onRebalanceDue({ nowMs: NOW_MS + 86_400_000, triggerSource: RebalanceTriggerSourceEnum.SCHEDULED });

            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        });
    });

    describe('AQ5 — MAX_WAIT_MS boundary: exactly at threshold fires, one ms over abandons', () => {
        it('fires when the bar closes EXACTLY at MOMENTUM_RETRY_MAX_WAIT_MS after arming', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks, 'FARTCOINUSDT');
            mocks.positions.findOpen.mockResolvedValue([]);

            armedMap(service).set('FARTCOINUSDT', {
                symbol: 'FARTCOINUSDT',
                rank: 2,
                rebalanceCycleId: CYCLE_ID,
                triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
                armedAtMs: NOW_MS,
            });

            await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', MOMENTUM_RETRY_MAX_WAIT_MS));

            expect(approvedOpenCalls(mocks).some((call) => call[1].intent.symbol === 'FARTCOINUSDT')).toBe(true);
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        });

        it('abandons when the bar closes ONE MS beyond MOMENTUM_RETRY_MAX_WAIT_MS after arming', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks, 'FARTCOINUSDT');
            mocks.positions.findOpen.mockResolvedValue([]);

            armedMap(service).set('FARTCOINUSDT', {
                symbol: 'FARTCOINUSDT',
                rank: 2,
                rebalanceCycleId: CYCLE_ID,
                triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
                armedAtMs: NOW_MS,
            });

            await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', MOMENTUM_RETRY_MAX_WAIT_MS + 1));

            expect(approvedOpenCalls(mocks).some((call) => call[1].intent.symbol === 'FARTCOINUSDT')).toBe(false);
            expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        });
    });
});
