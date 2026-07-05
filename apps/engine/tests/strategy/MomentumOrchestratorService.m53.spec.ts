/**
 * MomentumOrchestratorService — M53 D1 arm-ratio decoupling (docs/plans/M53-xmom-tp-arm-headroom.md).
 *
 * `xmom_tp_arm_rr` drives the take-profit arm at the open-intent build site only
 * (`buildMomentumOpenIntent`, ADR-referenced ":623"); `xmom_min_rr` remains the ONLY input to the
 * fill-acceptance guard floor threaded via `buildGateStrategyParams` → `emitApproval`'s
 * `geometryParams.min_rr`. These tests drive a real `onRebalanceDue` open leg (same
 * `captureOpenGateCall`-style harness as `MomentumOrchestratorService.spec.ts`) and inspect the
 * emitted `ORDER_INTENT_APPROVED_EVENT` payload.
 *
 * Coverage map (M53 testing-strategy items 1, 4, 5):
 *   - params={} (no xmom_tp_arm_rr key)         → schema default 1.5 → arm = 1.5·D, byte-identical to
 *                                                  pre-M53 behavior (no-op at default)
 *   - xmom_tp_arm_rr=1.8, xmom_min_rr=1.5        → arm = 1.8·D but geometryParams.min_rr stays 1.5
 *                                                  (the two seams never merge, even when they diverge)
 *   - same inputs, two independent rebalances    → identical TP price both times (determinism; no
 *                                                  clock/RNG/I-O leaked into the arm site)
 */

import { CoinTierEnum, ExchangeEnvironmentEnum, PortfolioSelectionReasonEnum, RebalanceTriggerSourceEnum, RiskOutcomeEnum } from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { AppConfigService } from '../../src/config/service';
import { ICandle } from '../../src/market-data/interface/ICandle';
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
const ENTRY_PRICE = 100; // buildMockBars() closes are flat at 100

function buildMockBars(count = 20): ICandle[] {
    // Flat close=100, H=110/L=90 every bar → true range converges to a constant 20 → ATR = 20 exactly.
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

function buildMembershipEntry(symbol: string) {
    return { symbol, volumeRank: 1, tier: CoinTierEnum.TIER_1, quoteVolume24h: new Money('1000000') };
}

function buildApprovedDecision() {
    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: null,
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

/** `params` is passed through untouched — the caller controls exactly which keys the "row" carries,
 * so a test can omit `xmom_tp_arm_rr` entirely and let the real momentumParamsSchema default it. */
function buildDefaultMocks(params: Record<string, unknown>): IMockSet {
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
            findById: jest.fn().mockResolvedValue({ id: ACTIVE_VERSION_ID, name: 'xmom', version: 1, params }),
        },
        universe: {
            getEntries: jest.fn().mockReturnValue([buildMembershipEntry('BTCUSDT')]),
            getEntry: jest.fn().mockReturnValue(buildMembershipEntry('BTCUSDT')),
        },
        symbolStates: { get: jest.fn().mockReturnValue(buildSymbolState()) },
        candles: { findRange: jest.fn().mockResolvedValue(buildMockBars()) },
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
            selectUniverse: jest
                .fn()
                .mockReturnValue({ ranked: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }], reason: PortfolioSelectionReasonEnum.RANKED }),
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

/** Runs one BTCUSDT open leg and returns the emitted ORDER_INTENT_APPROVED_EVENT payload. */
async function runOpenAndCaptureApproval(params: Record<string, unknown>): Promise<any> {
    const mocks = buildDefaultMocks(params);
    const { service } = await buildTestModule(mocks);

    await service.onRebalanceDue({ nowMs: NOW_MS, triggerSource: RebalanceTriggerSourceEnum.SCHEDULED });

    const approvedEmit = mocks.events.emit.mock.calls.find(([eventName]) => eventName === ORDER_INTENT_APPROVED_EVENT);
    expect(approvedEmit).toBeDefined();

    return approvedEmit![1];
}

// ─── no-op at default (M53 testing-strategy item 1) ──────────────────────────

describe('MomentumOrchestratorService — M53 D1: no-op at default (params={} has no xmom_tp_arm_rr key)', () => {
    it('arms the TP at entryPrice + 1.5·stopDistance via the schema default, byte-identical to pre-M53', async () => {
        const payload = await runOpenAndCaptureApproval({
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
            // xmom_tp_arm_rr deliberately omitted — momentumParamsSchema.parse must default it to 1.5.
        });

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedTp = new Money(ENTRY_PRICE).plus(atrDistance.times(2.0).times(1.5));

        expect(payload.intent.proposedExit.takeProfitPrice.toFixed(8)).toBe(expectedTp.toFixed(8));
        expect(payload.geometryParams.min_rr).toBe(1.5);
    });

    it('arms identically when xmom_tp_arm_rr is explicitly set to 1.5 (equivalent to the default)', async () => {
        const payload = await runOpenAndCaptureApproval({
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
            xmom_tp_arm_rr: 1.5,
        });

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedTp = new Money(ENTRY_PRICE).plus(atrDistance.times(2.0).times(1.5));

        expect(payload.intent.proposedExit.takeProfitPrice.toFixed(8)).toBe(expectedTp.toFixed(8));
    });
});

// ─── decoupled arm (M53 testing-strategy item 3/4) ───────────────────────────

describe('MomentumOrchestratorService — M53 D1: xmom_tp_arm_rr drives the arm independently of xmom_min_rr', () => {
    it('arms the TP at 1.8·stopDistance while the guard floor (geometryParams.min_rr) stays at 1.5', async () => {
        const payload = await runOpenAndCaptureApproval({
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
            xmom_tp_arm_rr: 1.8,
        });

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedTp = new Money(ENTRY_PRICE).plus(atrDistance.times(2.0).times(1.8));

        expect(payload.intent.proposedExit.takeProfitPrice.toFixed(8)).toBe(expectedTp.toFixed(8));
        // The guard-floor thread is UNTOUCHED — it still reads xmom_min_rr, not the wider arm.
        expect(payload.geometryParams.min_rr).toBe(1.5);
        expect(payload.geometryParams.min_rr).not.toBe(1.8);
    });

    it('the stop-loss price is unaffected by xmom_tp_arm_rr (only the TP arm moves)', async () => {
        const payload = await runOpenAndCaptureApproval({
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
            xmom_tp_arm_rr: 1.8,
        });

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedSl = new Money(ENTRY_PRICE).minus(atrDistance.times(2.0));

        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(expectedSl.toFixed(8));
    });
});

// ─── determinism (M53 testing-strategy item 5) ───────────────────────────────

describe('MomentumOrchestratorService — M53 D1: determinism — no clock/RNG/I-O leaked into the arm site', () => {
    it('two independent rebalances with identical inputs produce an identical TP price', async () => {
        const params = {
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
            xmom_tp_arm_rr: 1.8,
        };

        const payloadOne = await runOpenAndCaptureApproval(params);
        const payloadTwo = await runOpenAndCaptureApproval(params);

        expect(payloadOne.intent.proposedExit.takeProfitPrice.toFixed(18)).toBe(payloadTwo.intent.proposedExit.takeProfitPrice.toFixed(18));
    });
});
