/**
 * Integration-style unit tests for MomentumOrchestratorService (ADR 0048 §2.3).
 *
 * All external deps are mocked via `Test.createTestingModule`. The service under test is
 * real; its `onRebalanceDue` method is called directly (no EventEmitter wiring required for
 * unit coverage). Each test builds a fresh module so no state leaks between runs.
 *
 * Coverage map (all mandatory adversarial cases from the M50 QA mandate):
 *   Case  1 — non-paper env                                → warn, no ranking, no gate call
 *   Case  2 — activePortfolioStrategyVersionId is null     → event no-op
 *   Case  3 — overlap guard                                → second event skipped
 *   Case  4 — universe all missing returns (NO_ELIGIBLE)   → no opens, no closes, no crash
 *   Case  5 — universe too small                           → same no-op behavior
 *   Case  6 — closes before opens ordering                 → close gate call precedes open gate call
 *   Case  7 — hold (symbol in top-N and already open)      → no close, no open gate call
 *   Case  8 — open (symbol in top-N, not open)             → gate called with OPEN intent
 *   Case  9 — close (symbol open, not in top-N)            → gate called with CLOSE intent
 *   Case 10 — gate rejects open                            → decision recorded, no ORDER_INTENT_APPROVED_EVENT
 *   Case 11 — de-rank close intent type                    → intentAction === CLOSE
 *   Case 12 — cold-boot trailing return fallback           → candles.findRange called, symbol included
 *   Case 13 — InstrumentPortAdapter returns null           → open skipped, no crash
 *   Case 14 — PositionSizer returns kind ≠ 'sized'         → open skipped, no crash
 *   Case 15 — exception in rebalance body                  → isRebalancing reset, next event processed
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExchangeEnvironmentEnum,
    OrderIntentActionEnum,
    PortfolioSelectionReasonEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RejectReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
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
import { Money } from '../../src/common/utils/money';

// ─── constants ───────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;
const ACTIVE_VERSION_ID = 7;

// ─── fixture builders ─────────────────────────────────────────────────────────

function buildVersionRow() {
    return {
        id: ACTIVE_VERSION_ID,
        name: 'xmom',
        version: 1,
        params: {
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: 86_400_000,
            min_universe_size: 5,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
        },
    };
}

/** Twenty closed 5m candles with H/L spread of 20 → ATR ≈ 20 > 0. */
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

function buildSymbolState(returnPct = 5.0) {
    const bars = buildMockBars();
    return {
        movePctOverWindow: jest.fn().mockReturnValue(returnPct),
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

function buildOpenPosition(overrides: Partial<PositionEntity> = {}): PositionEntity {
    return {
        id: 1,
        symbol: 'ETHUSDT',
        strategyVersionId: ACTIVE_VERSION_ID,
        side: PositionSideEnum.LONG,
        entryPrice: new Money('2000'),
        qty: new Money('0.05'),
        leverage: new Money('1'),
        coinTier: CoinTierEnum.TIER_1,
        positionSlot: PositionSlotEnum.A,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        ...overrides,
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

function buildRejectedDecision() {
    return {
        outcome: RiskOutcomeEnum.REJECTED,
        rejectReason: RejectReasonEnum.MAX_POSITIONS_REACHED,
        approvedSlot: null,
        approvedSizing: null,
        clampedExit: null,
        haltReasonDetail: null,
        reservationId: null,
    };
}

// ─── module builder ───────────────────────────────────────────────────────────

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
        strategyVersions: { findById: jest.fn().mockResolvedValue(buildVersionRow()) },
        universe: {
            getEntries: jest.fn().mockReturnValue([]),
            getEntry: jest.fn().mockReturnValue(null),
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
            selectUniverse: jest.fn().mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS }),
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

// ─── paper gate ───────────────────────────────────────────────────────────────

describe('MomentumOrchestratorService — paper gate', () => {
    it('is a no-op when EXCHANGE_ENV is not paper', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.config = { ...rawMocks.config, exchangeEnv: ExchangeEnvironmentEnum.LIVE };
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.universe.getEntries).not.toHaveBeenCalled();
        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        expect(mocks.events.emit).not.toHaveBeenCalled();
    });

    it('is a no-op when EXCHANGE_ENV is testnet', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.config = { ...rawMocks.config, exchangeEnv: ExchangeEnvironmentEnum.TESTNET };
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });

    it('is a no-op when activePortfolioStrategyVersionId is null (paper env)', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.config = { ...rawMocks.config, activePortfolioStrategyVersionId: null };
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.universe.getEntries).not.toHaveBeenCalled();
        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });
});

// ─── overlap guard ────────────────────────────────────────────────────────────

describe('MomentumOrchestratorService — overlap guard', () => {
    it('skips the second event when a rebalance is already in flight', async () => {
        const rawMocks = buildDefaultMocks();
        const { service, mocks } = await buildTestModule(rawMocks);

        // Start the first call without awaiting — it sets isRebalancing=true synchronously
        // then suspends at the first `await resolveActiveVersion()`.
        const firstCallPromise = service.onRebalanceDue({ nowMs: NOW_MS });

        // Second call runs SYNCHRONOUSLY (same tick, before any microtasks) and sees
        // isRebalancing=true → returns immediately with overlap skip.
        const secondCallPromise = service.onRebalanceDue({ nowMs: NOW_MS + 1 });

        await Promise.all([firstCallPromise, secondCallPromise]);

        // With empty universe, first call completes with zero gate calls.
        // Second call was blocked — universe.getEntries called only once (by first call).
        expect(mocks.universe.getEntries).toHaveBeenCalledTimes(1);
    });
});

// ─── empty / thin universe ────────────────────────────────────────────────────

describe('MomentumOrchestratorService — empty / thin universe selection', () => {
    it('processes no intents when strategy returns NO_ELIGIBLE_SYMBOLS', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        expect(mocks.events.emit).not.toHaveBeenCalledWith(ORDER_INTENT_APPROVED_EVENT, expect.anything());
    });

    it('processes no intents when strategy returns UNIVERSE_TOO_SMALL', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.UNIVERSE_TOO_SMALL });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        expect(mocks.events.emit).not.toHaveBeenCalledWith(ORDER_INTENT_APPROVED_EVENT, expect.anything());
    });
});

// ─── position lifecycle — hold / open / close ─────────────────────────────────

describe('MomentumOrchestratorService — hold: symbol still in top-N and already open', () => {
    it('generates no close and no open intent for a held symbol', async () => {
        const rawMocks = buildDefaultMocks();
        // One open position for BTCUSDT; selection also includes BTCUSDT → hold.
        rawMocks.positions.findOpen.mockResolvedValue([buildOpenPosition({ symbol: 'BTCUSDT', strategyVersionId: ACTIVE_VERSION_ID })]);
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });
});

describe('MomentumOrchestratorService — open: symbol in top-N but not open', () => {
    it('calls riskGate.evaluate with an OPEN intent for the selected symbol', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState(5.0));
        // ATR computation uses candles.findRange (BLOCKER 3 fix) — must supply ≥2 bars.
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars());
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).toHaveBeenCalledTimes(1);
        const [intent] = mocks.riskGate.evaluate.mock.calls[0];
        expect(intent.intentAction).toBe(OrderIntentActionEnum.OPEN);
        expect(intent.symbol).toBe('BTCUSDT');
    });
});

describe('MomentumOrchestratorService — close: symbol open but not in top-N', () => {
    it('calls riskGate.evaluate with a CLOSE intent for the de-ranked symbol', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([buildOpenPosition({ symbol: 'ETHUSDT', strategyVersionId: ACTIVE_VERSION_ID })]);
        // Selection has BTCUSDT (not ETHUSDT) → ETHUSDT should be closed.
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.riskGate.evaluate).toHaveBeenCalledTimes(1);
        const [intent] = mocks.riskGate.evaluate.mock.calls[0];
        expect(intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
        expect(intent.symbol).toBe('ETHUSDT');
    });

    it('close intent has intentAction === CLOSE (risk-reducing, auto-approved under halt)', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([buildOpenPosition({ symbol: 'SOLUSDT', strategyVersionId: ACTIVE_VERSION_ID })]);
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.RANKED });
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        const [intent] = mocks.riskGate.evaluate.mock.calls[0];
        expect(intent.intentAction).toBe(OrderIntentActionEnum.CLOSE);
    });
});

// ─── ordering: closes before opens ───────────────────────────────────────────

describe('MomentumOrchestratorService — closes precede opens within one rebalance', () => {
    it('calls riskGate.evaluate for the close intent before the open intent', async () => {
        const rawMocks = buildDefaultMocks();
        // ETHUSDT is open (will be closed). BTCUSDT is selected (will be opened).
        rawMocks.positions.findOpen.mockResolvedValue([buildOpenPosition({ symbol: 'ETHUSDT', strategyVersionId: ACTIVE_VERSION_ID })]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockImplementation((symbol: string) => (symbol === 'BTCUSDT' || symbol === 'ETHUSDT' ? buildSymbolState() : null));
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        // ATR computation for the BTCUSDT open uses candles.findRange (BLOCKER 3 fix).
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars());
        const { service, mocks } = await buildTestModule(rawMocks);

        const callOrder: string[] = [];
        mocks.riskGate.evaluate.mockImplementation(async (intent: { intentAction: string; symbol: string }) => {
            callOrder.push(`${intent.intentAction}:${intent.symbol}`);
            return buildApprovedDecision();
        });

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(callOrder).toHaveLength(2);
        expect(callOrder[0]).toBe(`${OrderIntentActionEnum.CLOSE}:ETHUSDT`);
        expect(callOrder[1]).toBe(`${OrderIntentActionEnum.OPEN}:BTCUSDT`);
    });
});

// ─── gate rejection ───────────────────────────────────────────────────────────

describe('MomentumOrchestratorService — gate rejection for open intent', () => {
    it('records a decision row but does not emit ORDER_INTENT_APPROVED_EVENT when gate rejects', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        // ATR computation uses candles.findRange (BLOCKER 3 fix) — must supply ≥2 bars so the
        // intent is built and reaches the gate (where the rejection under test can be observed).
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars());
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.riskGate.evaluate.mockResolvedValue(buildRejectedDecision());
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.decisions.record).toHaveBeenCalledTimes(1);
        expect(mocks.events.emit).not.toHaveBeenCalledWith(ORDER_INTENT_APPROVED_EVENT, expect.anything());
    });

    it('does not throw when the gate rejects an open intent', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars());
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.riskGate.evaluate.mockResolvedValue(buildRejectedDecision());
        const { service } = await buildTestModule(rawMocks);

        await expect(service.onRebalanceDue({ nowMs: NOW_MS })).resolves.not.toThrow();
    });
});

// ─── cold-boot trailing return fallback ──────────────────────────────────────

describe('MomentumOrchestratorService — cold-boot trailing return fallback', () => {
    it('calls candles.findRange when SymbolStateRegistry.get returns null', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(null); // tape unavailable
        rawMocks.candles.findRange.mockResolvedValue([
            {
                openTimeMs: NOW_MS - 86_400_000,
                open: new Money('90'),
                high: new Money('95'),
                low: new Money('88'),
                close: new Money('90'),
                volume: new Money('100'),
                quoteVolume: new Money('9000'),
                isClosed: true,
            },
            {
                openTimeMs: NOW_MS - 5 * 60_000,
                open: new Money('95'),
                high: new Money('100'),
                low: new Money('93'),
                close: new Money('95'),
                volume: new Money('100'),
                quoteVolume: new Money('9500'),
                isClosed: true,
            },
        ]);
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        expect(mocks.candles.findRange).toHaveBeenCalledWith('BTCUSDT', '5m', expect.any(Date), expect.any(Date));
    });

    it('includes the symbol in the universe passed to strategy when 2+ candles resolve a return', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(null);
        // 2 candles: close went from 90 to 99 → +10%
        rawMocks.candles.findRange.mockResolvedValue([
            {
                openTimeMs: NOW_MS - 86_400_000,
                open: new Money('90'),
                high: new Money('95'),
                low: new Money('88'),
                close: new Money('90'),
                volume: new Money('100'),
                quoteVolume: new Money('9000'),
                isClosed: true,
            },
            {
                openTimeMs: NOW_MS - 5 * 60_000,
                open: new Money('95'),
                high: new Money('100'),
                low: new Money('93'),
                close: new Money('99'),
                volume: new Money('100'),
                quoteVolume: new Money('9900'),
                isClosed: true,
            },
        ]);
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        const [universeArg] = mocks.strategy.selectUniverse.mock.calls[0][0].universe;
        expect(universeArg.symbol).toBe('BTCUSDT');
        expect(universeArg.trailingReturnPct).toBeCloseTo(10, 2);
    });

    it('excludes the symbol from the universe when fewer than 2 candles are available', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(null);
        rawMocks.candles.findRange.mockResolvedValue([]); // no candles
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        const { universe } = mocks.strategy.selectUniverse.mock.calls[0][0];
        expect(universe).toHaveLength(0);
    });
});

// ─── open-path early exits ────────────────────────────────────────────────────

describe('MomentumOrchestratorService — open skipped when InstrumentPortAdapter returns null', () => {
    it('skips the open and does not crash when instrument is unknown', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.instrumentPort.findConstraints.mockResolvedValue(null);
        const { service, mocks } = await buildTestModule(rawMocks);

        await expect(service.onRebalanceDue({ nowMs: NOW_MS })).resolves.not.toThrow();
        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });
});

describe('MomentumOrchestratorService — open skipped when PositionSizer returns non-sized result', () => {
    it('skips the open and does not crash when sizing fails', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState());
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        rawMocks.sizer.size.mockReturnValue({ kind: 'skipped', reason: 'min_notional_not_met' });
        const { service, mocks } = await buildTestModule(rawMocks);

        await expect(service.onRebalanceDue({ nowMs: NOW_MS })).resolves.not.toThrow();
        expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
    });
});

// ─── BLOCKER 1: tape-path guard for long lookbacks ───────────────────────────

describe('MomentumOrchestratorService — tape-path guard: 24h lookback bypasses movePctOverWindow', () => {
    it('does not call movePctOverWindow when lookback_ms exceeds PRICE_TAPE_RETENTION_MS (24h > 15 min)', async () => {
        const rawMocks = buildDefaultMocks();
        // buildVersionRow() uses lookback_ms = 86_400_000 (24h), well above the 15 min tape window.
        const symbolStateMock = buildSymbolState(9.9); // 9.9% would be returned by tape — must be ignored
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(symbolStateMock);
        // Candles provide the real return: first close=100 → last close=105 → +5%.
        rawMocks.candles.findRange.mockResolvedValue([
            {
                openTimeMs: NOW_MS - 86_400_000,
                open: new Money('100'),
                high: new Money('110'),
                low: new Money('90'),
                close: new Money('100'),
                volume: new Money('1000'),
                quoteVolume: new Money('100000'),
                isClosed: true,
            },
            {
                openTimeMs: NOW_MS - 5 * 60_000,
                open: new Money('100'),
                high: new Money('110'),
                low: new Money('90'),
                close: new Money('105'),
                volume: new Money('1000'),
                quoteVolume: new Money('100000'),
                isClosed: true,
            },
        ]);
        rawMocks.strategy.selectUniverse.mockReturnValue({ selected: [], reason: PortfolioSelectionReasonEnum.NO_ELIGIBLE_SYMBOLS });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        // Tape path must be entirely skipped — movePctOverWindow must not be called.
        expect(symbolStateMock.movePctOverWindow).not.toHaveBeenCalled();
        // The universe entry must carry the candle-derived return (~5%), not the tape value (9.9%).
        const [universeEntry] = mocks.strategy.selectUniverse.mock.calls[0][0].universe;
        expect(universeEntry.symbol).toBe('BTCUSDT');
        expect(universeEntry.trailingReturnPct).toBeCloseTo(5, 2);
    });
});

// ─── BLOCKER 2: time-stop anchored at 2× rebalance interval ──────────────────

describe('MomentumOrchestratorService — time-stop at 2× rebalance interval on approved open', () => {
    it('sets proposedExit.timeStopAtMs to nowMs + rebalance_interval_ms × 2', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        rawMocks.symbolStates.get.mockReturnValue(buildSymbolState(5.0));
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars());
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        const approvedEmit = mocks.events.emit.mock.calls.find(([eventName]) => eventName === ORDER_INTENT_APPROVED_EVENT);
        expect(approvedEmit).toBeDefined();
        const approvedPayload = approvedEmit![1];
        const rebalanceIntervalMs = buildVersionRow().params.rebalance_interval_ms;
        expect(approvedPayload.intent.proposedExit.timeStopAtMs).toBe(NOW_MS + rebalanceIntervalMs * 2);
    });
});

// ─── BLOCKER 3: ATR sourced from CandleRepository, not in-memory 5m bars ─────

describe('MomentumOrchestratorService — ATR sourced from CandleRepository, not state.candles5m.getClosedBars()', () => {
    it('does not call getClosedBars and produces a non-zero atrDistance from candles.findRange bars', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockResolvedValue([]);
        rawMocks.universe.getEntries.mockReturnValue([buildMembershipEntry('BTCUSDT')]);
        const symbolState = buildSymbolState(5.0);
        rawMocks.symbolStates.get.mockReturnValue(symbolState);
        rawMocks.universe.getEntry.mockReturnValue(buildMembershipEntry('BTCUSDT'));
        // 20 candles, each with high=110 / low=90 / close=100 → true range=20 → ATR≈20.
        rawMocks.candles.findRange.mockResolvedValue(buildMockBars(20));
        rawMocks.strategy.selectUniverse.mockReturnValue({
            selected: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }],
            reason: PortfolioSelectionReasonEnum.RANKED,
        });
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS });

        // getClosedBars must never be called — ATR uses the candle repository, not in-memory state.
        expect(symbolState.candles5m.getClosedBars).not.toHaveBeenCalled();
        const approvedEmit = mocks.events.emit.mock.calls.find(([eventName]) => eventName === ORDER_INTENT_APPROVED_EVENT);
        expect(approvedEmit).toBeDefined();
        const atrDistance = approvedEmit![1].intent.proposedExit.atrDistance;
        expect(atrDistance).not.toBeNull();
        expect(atrDistance.toNumber()).toBeGreaterThan(0);
    });
});

// ─── exception resilience ─────────────────────────────────────────────────────

describe('MomentumOrchestratorService — exception in rebalance body resets isRebalancing', () => {
    it('processes the next event normally after an exception in a prior rebalance', async () => {
        const rawMocks = buildDefaultMocks();
        // First call: positions.findOpen throws → rebalance fails.
        // Second call: positions.findOpen succeeds → rebalance processes normally.
        rawMocks.positions.findOpen.mockRejectedValueOnce(new Error('DB timeout')).mockResolvedValue([]);
        const { service, mocks } = await buildTestModule(rawMocks);

        await service.onRebalanceDue({ nowMs: NOW_MS }); // first call → throws, isRebalancing reset
        await service.onRebalanceDue({ nowMs: NOW_MS + 1 }); // second call → not blocked

        // universe.getEntries called twice (both calls reached rebalance).
        expect(mocks.universe.getEntries).toHaveBeenCalledTimes(2);
    });

    it('does not propagate the exception to the caller', async () => {
        const rawMocks = buildDefaultMocks();
        rawMocks.positions.findOpen.mockRejectedValue(new Error('unexpected failure'));
        const { service } = await buildTestModule(rawMocks);

        await expect(service.onRebalanceDue({ nowMs: NOW_MS })).resolves.not.toThrow();
    });
});
