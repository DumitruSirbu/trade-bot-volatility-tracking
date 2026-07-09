/**
 * MomentumOrchestratorService — M54 D2 item 9 (docs/plans/M54-xmom-entry-geometry-expected-fill.md
 * §9 #9, §7 D2 "M52 retry coupling").
 *
 * The M52 retry rebuild (`fireArmedRetry` → `processOpen` → `buildMomentumOpenIntent`) is the SAME
 * builder attempt-1 opens go through, so it inherits the M54 anchor + skip automatically. This file
 * asserts a thin-book retry whose depth fails the budget is SKIPPED (no intent emitted, arm
 * consumed) rather than re-opened. Harness mirrors `MomentumOrchestratorService.m52.adversarial.spec.ts`
 * (`primeCycleState` + direct `armedRetries` seeding + `onCandleClosed` to fire).
 */

import {
    CoinTierEnum,
    ExchangeEnvironmentEnum,
    OrderIntentActionEnum,
    PortfolioSelectionReasonEnum,
    RebalanceTriggerSourceEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
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
import { Money, MoneyValue } from '../../src/common/utils/money';

const NOW_MS = 1_700_000_000_000;
const ACTIVE_VERSION_ID = 7;
const TOP_N = 3;
const CYCLE_ID = `xmom-cycle-${NOW_MS}-${RebalanceTriggerSourceEnum.SCHEDULED}`;
const FIVE_MIN_MS = 5 * 60_000;
const FRESH_BAR_CLOSE = '123.45';
const MOCK_NOTIONAL = 100; // fixed sizer.size() mock output notional

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

function buildSymbolState(freshClose = FRESH_BAR_CLOSE, bookDepth10bpsUsdt: MoneyValue | null = new Money('0'), spreadPct: number | null = 0) {
    const bars = buildMockBars(20, freshClose);

    return {
        movePctOverWindow: jest.fn().mockReturnValue(5.0),
        candles5m: {
            getLatestClosedBar: jest.fn().mockReturnValue(bars[bars.length - 1]),
            getClosedBars: jest.fn().mockReturnValue(bars),
        },
        getFundingRate: jest.fn().mockReturnValue(0),
        getFundingRateAnnualized: jest.fn().mockReturnValue(0),
        getSpreadPct: jest.fn().mockReturnValue(spreadPct),
        latestOpenInterest: jest.fn().mockReturnValue(new Money('0')),
        getBookDepth10bpsUsdt: jest.fn().mockReturnValue(bookDepth10bpsUsdt),
        getBookDepth50bpsUsdt: jest.fn().mockReturnValue(new Money('0')),
    };
}

function buildApprovedDecision() {
    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: null,
        approvedSizing: {
            qty: new Money('0.01'),
            notional: new Money(MOCK_NOTIONAL),
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
            xmomForceCloseRetry: true,
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
                    notional: new Money(MOCK_NOTIONAL),
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

function primeCycleState(service: MomentumOrchestratorService, extraParams: Record<string, unknown> = {}): void {
    const anyService = service as unknown as {
        activeVersionId: number;
        activeParams: Record<string, unknown>;
        currentCycleId: string;
        currentCycleNowMs: number;
        currentTriggerSource: RebalanceTriggerSourceEnum;
    };
    anyService.activeVersionId = ACTIVE_VERSION_ID;
    anyService.activeParams = {
        top_n: TOP_N,
        lookback_ms: 86_400_000,
        rebalance_interval_ms: 86_400_000,
        min_universe_size: 5,
        xmom_atr_stop_multiplier: 2.0,
        xmom_min_rr: 1.5,
        xmom_tp_arm_rr: 1.5,
        xmom_expected_fill_enabled: false,
        xmom_max_depth_fraction: null,
        ...extraParams,
    };
    anyService.currentCycleId = CYCLE_ID;
    anyService.currentCycleNowMs = NOW_MS;
    anyService.currentTriggerSource = RebalanceTriggerSourceEnum.SCHEDULED;
}

function armedMap(service: MomentumOrchestratorService): Map<string, unknown> {
    return (service as unknown as { armedRetries: Map<string, unknown> }).armedRetries;
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

function seedArmedRetry(service: MomentumOrchestratorService, symbol: string): void {
    armedMap(service).set(symbol, {
        symbol,
        rank: 2,
        rebalanceCycleId: CYCLE_ID,
        triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
        armedAtMs: NOW_MS,
    });
}

function approvedOpenCalls(mocks: IMockSet, symbol: string) {
    return mocks.events.emit.mock.calls.filter(
        (call) => call[0] === ORDER_INTENT_APPROVED_EVENT && call[1].intent.intentAction === OrderIntentActionEnum.OPEN && call[1].intent.symbol === symbol,
    );
}

describe('MomentumOrchestratorService — M54 item 9: the M52 retry rebuild inherits the M54 skip', () => {
    it('a retry rebuild on a thin coin whose depth fails the budget is SKIPPED — no OPEN intent emitted, arm consumed', async () => {
        const mocks = buildDefaultMocks();
        const { service } = await buildTestModule(mocks);
        // Budget-failing depth: fixed mock notional=100, budget=0.5 → threshold depth=200; 190 fails it.
        primeCycleState(service, { xmom_max_depth_fraction: 0.5 });
        mocks.symbolStates.get.mockImplementation((sym: string) => (sym === 'FARTCOINUSDT' ? buildSymbolState(FRESH_BAR_CLOSE, new Money('190')) : null));
        mocks.candles.findRange.mockResolvedValue(buildMockBars(20, FRESH_BAR_CLOSE));
        mocks.universe.getEntry.mockReturnValue({ symbol: 'FARTCOINUSDT', volumeRank: 1, tier: CoinTierEnum.TIER_1 });
        mocks.positions.findOpen.mockResolvedValue([]);
        seedArmedRetry(service, 'FARTCOINUSDT');

        await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS));

        expect(approvedOpenCalls(mocks, 'FARTCOINUSDT')).toHaveLength(0);
        // The arm is consumed (claimed before the rebuild attempt), not left dangling for a future re-fire.
        expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
        // No risk-gate call at all — the skip returns null from buildMomentumOpenIntent BEFORE the gate.
        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });

    it('the SAME retry rebuild opens normally when depth clears the budget (control — proves the harness distinguishes skip from a broken retry)', async () => {
        const mocks = buildDefaultMocks();
        const { service } = await buildTestModule(mocks);
        primeCycleState(service, { xmom_max_depth_fraction: 0.5 });
        mocks.symbolStates.get.mockImplementation((sym: string) => (sym === 'FARTCOINUSDT' ? buildSymbolState(FRESH_BAR_CLOSE, new Money('210')) : null));
        mocks.candles.findRange.mockResolvedValue(buildMockBars(20, FRESH_BAR_CLOSE));
        mocks.universe.getEntry.mockReturnValue({ symbol: 'FARTCOINUSDT', volumeRank: 1, tier: CoinTierEnum.TIER_1 });
        mocks.positions.findOpen.mockResolvedValue([]);
        seedArmedRetry(service, 'FARTCOINUSDT');

        await service.onCandleClosed(buildCandleEvent('FARTCOINUSDT', FIVE_MIN_MS));

        expect(approvedOpenCalls(mocks, 'FARTCOINUSDT')).toHaveLength(1);
        expect(armedMap(service).has('FARTCOINUSDT')).toBe(false);
    });
});
