/**
 * MomentumOrchestratorService — M52 D1 retry-eligibility breaker (ADR 0051 §2.1/§3).
 *
 * D1 is the retry DECISION surface only: cycle correlation, the volatility breaker (primary gate),
 * the per-cycle attempt-cap backstop, and the live top_n re-check. It fires NO order — the actual
 * next-bar retry execution is D2. These tests drive the private decision seam
 * `evaluateRetryEligibility` via `(service as any).*` (same convention as the M38 execution specs)
 * and assert the classified outcome + ledger side effects; one test drives a real rebalance to prove
 * the rebalanceCycleId + rank are stamped onto the emitted OPEN intent (the correlation mechanism).
 *
 * Coverage map (M52 testing-strategy items 1,3,4,5,6):
 *   - drift 0.8, basket below top_n            → MOMENTUM_RETRY_ELIGIBLE
 *   - drift 1.0 / 1.76 (FARTCOIN) / 1.32 (WLD) → MOMENTUM_RETRY_SKIPPED_DRIFT (observed case)
 *   - 2nd force_close same symbol/cycle        → MOMENTUM_RETRY_EXHAUSTED
 *   - live open count already at top_n         → MOMENTUM_RETRY_BASKET_FULL (uses findOpen, not `filled`)
 *   - foreign version / superseded cycle       → MOMENTUM_RETRY_SUPERSEDED
 *   - listener logs the outcome + swallows errors
 *   - cycle correlation: rebalanceCycleId + rank stamped on the OPEN intent
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExchangeEnvironmentEnum,
    OrderIntentActionEnum,
    PortfolioSelectionReasonEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RebalanceTriggerSourceEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import {
    MOMENTUM_RETRY_BASKET_FULL,
    MOMENTUM_RETRY_ELIGIBLE,
    MOMENTUM_RETRY_EXHAUSTED,
    MOMENTUM_RETRY_SKIPPED_DRIFT,
    MOMENTUM_RETRY_SUPERSEDED,
} from '../../src/strategy/const';
import { AppConfigService } from '../../src/config/service';
import { ICandle } from '../../src/market-data/interface/ICandle';
import { CandleRepository } from '../../src/market-data/repository/CandleRepository';
import { UniverseMembershipRepository } from '../../src/market-data/repository/UniverseMembershipRepository';
import { SymbolStateRegistry } from '../../src/market-data/service/SymbolStateRegistry';
import { UniverseService } from '../../src/market-data/service/UniverseService';
import { PositionEntity } from '../../src/position/entity/PositionEntity';
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
const TOP_N = 3;
const CYCLE_ID = `xmom-cycle-${NOW_MS}-${RebalanceTriggerSourceEnum.SCHEDULED}`;

function buildMockBars(count = 20): ICandle[] {
    return Array.from({ length: count }, (_, index) => ({
        openTimeMs: NOW_MS - (count - index) * 5 * 60_000,
        open: new Money('100'),
        high: new Money('110'),
        low: new Money('90'),
        close: new Money('100'),
        volume: new Money('1000'),
        quoteVolume: new Money('100000'),
        isClosed: true,
    }));
}

function buildSymbolState() {
    const bars = buildMockBars();

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

function buildOpenPosition(symbol: string): PositionEntity {
    return {
        id: 1,
        symbol,
        strategyVersionId: ACTIVE_VERSION_ID,
        side: PositionSideEnum.LONG,
        entryPrice: new Money('100'),
        qty: new Money('0.05'),
        leverage: new Money('1'),
        coinTier: CoinTierEnum.TIER_1,
        positionSlot: PositionSlotEnum.A,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
    } as unknown as PositionEntity;
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

function buildDefaultMocks(): IMockSet {
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

// Establish the private cycle state the listener reads WITHOUT driving a full rebalance, so the
// breaker tests stay focused on the decision logic. This mirrors the state rebalance() sets.
function primeCycleState(service: MomentumOrchestratorService): void {
    const anyService = service as unknown as {
        activeVersionId: number;
        activeParams: { top_n: number };
        currentCycleId: string;
    };
    anyService.activeVersionId = ACTIVE_VERSION_ID;
    anyService.activeParams = { top_n: TOP_N };
    anyService.currentCycleId = CYCLE_ID;
}

function buildForceClosedEvent(overrides: Partial<IMomentumFillForceClosedEvent> = {}): IMomentumFillForceClosedEvent {
    return {
        rebalanceCycleId: CYCLE_ID,
        symbol: 'FARTCOINUSDT',
        strategyVersionId: ACTIVE_VERSION_ID,
        rank: 2,
        atrUnitsDrift: new Money('0.8'),
        driftPct: new Money('0.5'),
        reason: 'sl_below_floor',
        ...overrides,
    };
}

function evaluate(service: MomentumOrchestratorService, event: IMomentumFillForceClosedEvent): Promise<{ outcome: string; eligible: boolean }> {
    return (
        service as unknown as { evaluateRetryEligibility(e: IMomentumFillForceClosedEvent): Promise<{ outcome: string; eligible: boolean }> }
    ).evaluateRetryEligibility(event);
}

describe('MomentumOrchestratorService — M52 D1 retry breaker', () => {
    describe('volatility breaker (primary gate)', () => {
        it('marks a small-drift force_close eligible when the basket is below top_n', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            const decision = await evaluate(service, buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_ELIGIBLE);
            expect(decision.eligible).toBe(true);
        });

        it('skips at the threshold boundary (drift = 1.0, strictly-below rule)', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            const decision = await evaluate(service, buildForceClosedEvent({ atrUnitsDrift: new Money('1.0') }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_SKIPPED_DRIFT);
            expect(decision.eligible).toBe(false);
        });

        it('skips the observed FARTCOIN (1.76) and WLD (1.32) dislocations — slot left empty', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            const fartcoin = await evaluate(service, buildForceClosedEvent({ symbol: 'FARTCOINUSDT', atrUnitsDrift: new Money('1.76') }));
            const wld = await evaluate(service, buildForceClosedEvent({ symbol: 'WLDUSDT', atrUnitsDrift: new Money('1.32') }));

            expect(fartcoin.outcome).toBe(MOMENTUM_RETRY_SKIPPED_DRIFT);
            expect(wld.outcome).toBe(MOMENTUM_RETRY_SKIPPED_DRIFT);
            // A skipped drift consumes no attempt — nothing was retried.
            expect((service as unknown as { retryAttempts: Map<string, number> }).retryAttempts.size).toBe(0);
        });
    });

    describe('attempt-cap backstop', () => {
        it('exhausts a second force_close of the same symbol in the same cycle', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            const first = await evaluate(service, buildForceClosedEvent({ symbol: 'PEPEUSDT', atrUnitsDrift: new Money('0.5') }));
            const second = await evaluate(service, buildForceClosedEvent({ symbol: 'PEPEUSDT', atrUnitsDrift: new Money('0.5') }));

            expect(first.outcome).toBe(MOMENTUM_RETRY_ELIGIBLE);
            expect(second.outcome).toBe(MOMENTUM_RETRY_EXHAUSTED);
            expect(second.eligible).toBe(false);
        });
    });

    describe('live top_n re-check', () => {
        it('abandons when the live open count already reached top_n (reads findOpen, not the stale filled)', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([buildOpenPosition('AUSDT'), buildOpenPosition('BUSDT'), buildOpenPosition('CUSDT')]);

            const decision = await evaluate(service, buildForceClosedEvent({ atrUnitsDrift: new Money('0.5') }));

            expect(mocks.positions.findOpen).toHaveBeenCalled();
            expect(decision.outcome).toBe(MOMENTUM_RETRY_BASKET_FULL);
            expect(decision.eligible).toBe(false);
        });

        it('ignores open positions from a different strategy version when counting the basket', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            const foreign = buildOpenPosition('AUSDT');
            (foreign as unknown as { strategyVersionId: number }).strategyVersionId = ACTIVE_VERSION_ID + 1;
            mocks.positions.findOpen.mockResolvedValue([foreign, foreign, foreign]);

            const decision = await evaluate(service, buildForceClosedEvent({ atrUnitsDrift: new Money('0.5') }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_ELIGIBLE);
        });
    });

    describe('supersession / version guard', () => {
        it('abandons a report whose cycle id no longer matches the current cycle', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            const decision = await evaluate(service, buildForceClosedEvent({ rebalanceCycleId: 'xmom-cycle-STALE-scheduled' }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_SUPERSEDED);
            expect(mocks.positions.findOpen).not.toHaveBeenCalled();
        });

        it('abandons a report for a foreign strategy version', async () => {
            const { service } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);

            const decision = await evaluate(service, buildForceClosedEvent({ strategyVersionId: ACTIVE_VERSION_ID + 99 }));

            expect(decision.outcome).toBe(MOMENTUM_RETRY_SUPERSEDED);
        });
    });

    describe('listener wiring', () => {
        it('logs the decision outcome and fires no order', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);
            const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

            await service.onMomentumFillForceClosed(buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }));

            expect(logSpy.mock.calls.some((call) => String(call[0]).startsWith(MOMENTUM_RETRY_ELIGIBLE))).toBe(true);
            expect(mocks.events.emit).not.toHaveBeenCalled();

            logSpy.mockRestore();
        });

        it('swallows an evaluation error without throwing', async () => {
            const { service, mocks } = await buildTestModule(buildDefaultMocks());
            primeCycleState(service);
            mocks.positions.findOpen.mockRejectedValue(new Error('db down'));
            const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

            await expect(service.onMomentumFillForceClosed(buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }))).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalled();

            errorSpy.mockRestore();
        });
    });

    describe('cycle correlation (stamping)', () => {
        it('stamps rebalanceCycleId + rank onto every emitted momentum OPEN intent', async () => {
            const mocks = buildDefaultMocks();
            mocks.universe.getEntries.mockReturnValue([{ symbol: 'SOLUSDT', tier: CoinTierEnum.TIER_1 }]);
            mocks.universe.getEntry.mockReturnValue({ symbol: 'SOLUSDT', volumeRank: 1, tier: CoinTierEnum.TIER_1 });
            mocks.symbolStates.get.mockReturnValue(buildSymbolState());
            mocks.candles.findRange.mockResolvedValue(buildMockBars());
            mocks.strategy.selectUniverse.mockReturnValue({
                ranked: [{ symbol: 'SOLUSDT', rank: 1, trailingReturnPct: 5, tier: 1 }],
                reason: PortfolioSelectionReasonEnum.RANKED,
            });
            const { service } = await buildTestModule(mocks);

            await service.onRebalanceDue({ nowMs: NOW_MS, triggerSource: RebalanceTriggerSourceEnum.SCHEDULED });

            const approvedCall = mocks.events.emit.mock.calls.find(
                (call) => call[0] === ORDER_INTENT_APPROVED_EVENT && call[1].intent.intentAction === OrderIntentActionEnum.OPEN,
            );
            expect(approvedCall).toBeDefined();
            expect(approvedCall![1].intent.rebalanceCycleId).toBe(CYCLE_ID);
            expect(approvedCall![1].intent.rank).toBe(1);
        });
    });
});
