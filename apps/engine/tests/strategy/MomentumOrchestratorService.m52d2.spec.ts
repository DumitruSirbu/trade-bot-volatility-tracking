/**
 * MomentumOrchestratorService — M52 D2 cooldown/re-anchor retry EXECUTION path (ADR 0051 §3.3–§3.5).
 *
 * D1 stops at the eligibility decision; D2 consumes an ELIGIBLE decision to ARM a retry and fire it
 * on the NEXT closed 5m bar — freshly rebuilt (new price / ATR / sizer.size()), re-entering the
 * UNCHANGED gate, behind the default-off paper-only XMOM_FORCE_CLOSE_RETRY flag. These tests drive
 * the two public event listeners (`onMomentumFillForceClosed`, `onCandleClosed`) plus the private
 * fire seam via `(service as any).*` (same convention as the D1 spec).
 *
 * Coverage map (M52 testing-strategy items 2, 7–12):
 *   - eligible retry fires FRESH on the next 5m bar (not the force_close tick) → re-enters the gate
 *   - never instant: arming emits NO order; only the bar-close fires it
 *   - fresh sizing: the rebuilt intent's entry price + sizer.size() come from the fresh bar
 *   - reservation-safe by construction: the gate is only re-entered on the bar-close seam, which is
 *     strictly after ExecutionService.unwindRejectedFill's synchronous release (see ExecutionService)
 *   - superseded by a newer cycle → armed retry abandoned (no order)
 *   - MAX_WAIT_MS elapsed (next bar too late) → armed retry abandoned (no order)
 *   - basket already full at FIRE time → abandoned, never overfills
 *   - default off (flag unset) → identical to D1: decision logged, NOTHING armed or fired
 *   - the retry is a normal OPEN through the unchanged gate/guard (no special-cased retry path)
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

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { AppConfigService } from '../../src/config/service';
import { ICandle } from '../../src/market-data/interface/ICandle';
import { ICandleClosedEvent } from '../../src/market-data/interface/ICandleClosedEvent';
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
const FIVE_MIN_MS = 5 * 60_000;
const FRESH_BAR_CLOSE = '123.45';
const SYMBOL = 'FARTCOINUSDT';

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

// A symbol state whose LATEST closed bar carries a distinctive fresh close, so a retry build is
// provably re-anchored on the current bar (not attempt-1's frozen 100).
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
            getEntry: jest.fn().mockReturnValue({ symbol: SYMBOL, volumeRank: 1, tier: CoinTierEnum.TIER_1 }),
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

// Prime the private per-cycle state a rebalance would set, without driving a full rebalance, so the
// arm/fire tests stay focused on the D2 execution seam. Mirrors what rebalance() writes.
function primeCycleState(service: MomentumOrchestratorService): void {
    const anyService = service as unknown as {
        activeVersionId: number;
        activeParams: Record<string, number | boolean | null>;
        currentCycleId: string;
        currentCycleNowMs: number;
        currentTriggerSource: RebalanceTriggerSourceEnum;
    };
    anyService.activeVersionId = ACTIVE_VERSION_ID;
    // Full params so the fire path's buildMomentumOpenIntent (ATR window, stop multiplier, min_rr,
    // time-stop) resolves — not just top_n (which is all the D1 decision seam reads).
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

function seedArmedRetry(service: MomentumOrchestratorService, overrides: Record<string, unknown> = {}): void {
    armedMap(service).set(SYMBOL, {
        symbol: SYMBOL,
        rank: 2,
        rebalanceCycleId: CYCLE_ID,
        triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
        armedAtMs: NOW_MS,
        ...overrides,
    });
}

function buildForceClosedEvent(overrides: Partial<IMomentumFillForceClosedEvent> = {}): IMomentumFillForceClosedEvent {
    return {
        rebalanceCycleId: CYCLE_ID,
        symbol: SYMBOL,
        strategyVersionId: ACTIVE_VERSION_ID,
        rank: 2,
        atrUnitsDrift: new Money('0.8'),
        driftPct: new Money('0.5'),
        reason: 'sl_below_floor',
        ...overrides,
    };
}

// A closed 5m bar whose CLOSE instant sits `barCloseOffsetMs` after NOW_MS (the arming instant).
function buildCandleEvent(barCloseOffsetMs = FIVE_MIN_MS, interval: '1m' | '5m' = '5m'): ICandleClosedEvent {
    const openTimeMs = NOW_MS + barCloseOffsetMs - FIVE_MIN_MS;

    return {
        symbol: SYMBOL,
        interval,
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

// Wire the symbol state + candle history a fresh retry build needs (price bar, ATR bars, instrument).
function primeFreshBuild(mocks: IMockSet): void {
    mocks.symbolStates.get.mockReturnValue(buildSymbolState());
    mocks.candles.findRange.mockResolvedValue(buildMockBars(20, FRESH_BAR_CLOSE));
    mocks.universe.getEntry.mockReturnValue({ symbol: SYMBOL, volumeRank: 1, tier: CoinTierEnum.TIER_1 });
}

function approvedOpenCall(mocks: IMockSet) {
    return mocks.events.emit.mock.calls.find((call) => call[0] === ORDER_INTENT_APPROVED_EVENT && call[1].intent.intentAction === OrderIntentActionEnum.OPEN);
}

describe('MomentumOrchestratorService — M52 D2 retry execution', () => {
    describe('arm + fire on the next closed 5m bar', () => {
        it('arms an eligible force_close WITHOUT firing an order (never instant)', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            await service.onMomentumFillForceClosed(buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }));

            expect(armedMap(service).has(SYMBOL)).toBe(true);
            // No order emitted on the force_close tick — the retry is deferred to the next bar.
            expect(approvedOpenCall(mocks)).toBeUndefined();
        });

        it('fires the armed retry FRESH on the next 5m bar — rebuilt via sizer.size(), re-entering the gate', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            // Re-entered the UNCHANGED gate and emitted a first-class OPEN approval.
            expect(mocks.riskGate.evaluate).toHaveBeenCalled();
            expect(mocks.sizer.size).toHaveBeenCalled();
            const call = approvedOpenCall(mocks);
            expect(call).toBeDefined();
            // Re-anchored on the fresh bar close (123.45), not attempt-1's frozen 100.
            expect(call![1].intent.entryPrice.toFixed()).toBe(new Money(FRESH_BAR_CLOSE).toFixed());
            // Same cycle id + rank carried forward for ledger attribution (ADR 0051 §3.5).
            expect(call![1].intent.rebalanceCycleId).toBe(CYCLE_ID);
            expect(call![1].intent.rank).toBe(2);
            // Fired once — the arm is consumed.
            expect(armedMap(service).has(SYMBOL)).toBe(false);
        });

        // M52 D3 (ADR 0051 §6) — the retry-rebuilt intent must carry isRetryEntry=true so the executor
        // persists positions.is_retry_entry, keeping retry entries separable from attempt-1 entries in
        // the paper-soak adverse-selection analysis.
        it('stamps isRetryEntry=true on the rebuilt retry intent (D3 attribution)', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            const call = approvedOpenCall(mocks);
            expect(call).toBeDefined();
            expect(call![1].intent.isRetryEntry).toBe(true);
        });

        it('the retry is a normal OPEN through the unchanged gate — no special-cased retry path', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            const call = approvedOpenCall(mocks);
            expect(call).toBeDefined();
            expect(call![1].intent.intentAction).toBe(OrderIntentActionEnum.OPEN);
            expect(call![1].intent.tradeSide).toBe(PositionSideEnum.LONG);
        });

        it('ignores a 1m bar close — the retry re-anchors on the 5m grid only', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS, '1m'));

            expect(approvedOpenCall(mocks)).toBeUndefined();
            expect(armedMap(service).has(SYMBOL)).toBe(true);
        });
    });

    describe('abandonment guards (slot left empty)', () => {
        it('abandons when a newer rebalance cycle has superseded the armed retry', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            // Armed under an older cycle; current cycle has since advanced.
            seedArmedRetry(service, { rebalanceCycleId: 'xmom-cycle-OLDER-scheduled' });

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            expect(approvedOpenCall(mocks)).toBeUndefined();
            expect(armedMap(service).has(SYMBOL)).toBe(false);
        });

        it('abandons when the next 5m bar arrives beyond MOMENTUM_RETRY_MAX_WAIT_MS', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            // Bar close 25 min after arming (> 10 min guard) → stale re-anchor.
            await service.onCandleClosed(buildCandleEvent(25 * 60_000));

            expect(approvedOpenCall(mocks)).toBeUndefined();
            expect(armedMap(service).has(SYMBOL)).toBe(false);
        });

        it('abandons at FIRE time when the basket already refilled to top_n (never overfills)', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);
            // A concurrent fill / manual rebalance refilled the basket between arming and fire.
            mocks.positions.findOpen.mockResolvedValue([buildOpenPosition('AUSDT'), buildOpenPosition('BUSDT'), buildOpenPosition('CUSDT')]);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            expect(approvedOpenCall(mocks)).toBeUndefined();
            expect(armedMap(service).has(SYMBOL)).toBe(false);
        });
    });

    describe('default-off flag (identical to D1 do-nothing behavior)', () => {
        it('does NOT arm an eligible force_close when the flag is off', async () => {
            const mocks = buildDefaultMocks(false);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            mocks.positions.findOpen.mockResolvedValue([]);

            await service.onMomentumFillForceClosed(buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }));

            expect(armedMap(service).has(SYMBOL)).toBe(false);
            expect(approvedOpenCall(mocks)).toBeUndefined();
        });

        it('never fires even if an arm somehow exists while the flag is off', async () => {
            const mocks = buildDefaultMocks(false);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            seedArmedRetry(service);

            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));

            expect(approvedOpenCall(mocks)).toBeUndefined();
            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        });
    });

    describe('reservation-safe by construction (fire only on the bar seam)', () => {
        it('re-enters the gate ONLY on the bar-close seam, not on the force_close report', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            primeFreshBuild(mocks);
            mocks.positions.findOpen.mockResolvedValue([]);

            // The force_close report (emitted by ExecutionService AFTER releaseReservationSafely) only
            // arms — the gate is not touched here, so no retry can race a still-held reservation.
            await service.onMomentumFillForceClosed(buildForceClosedEvent({ atrUnitsDrift: new Money('0.8') }));
            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();

            // Only the later bar-close seam re-enters the gate against the released ledger.
            await service.onCandleClosed(buildCandleEvent(FIVE_MIN_MS));
            expect(mocks.riskGate.evaluate).toHaveBeenCalledTimes(1);
            expect(approvedOpenCall(mocks)).toBeDefined();
        });
    });

    describe('supersession clears armed retries on a new rebalance', () => {
        it('drops a prior-cycle armed retry when a new rebalance runs', async () => {
            const mocks = buildDefaultMocks(true);
            const { service } = await buildTestModule(mocks);
            primeCycleState(service);
            seedArmedRetry(service);
            expect(armedMap(service).has(SYMBOL)).toBe(true);

            await service.onRebalanceDue({ nowMs: NOW_MS + 86_400_000, triggerSource: RebalanceTriggerSourceEnum.SCHEDULED });

            // The new cycle cleared the stale arm (ADR 0051 §3.3).
            expect(armedMap(service).has(SYMBOL)).toBe(false);
        });
    });
});
