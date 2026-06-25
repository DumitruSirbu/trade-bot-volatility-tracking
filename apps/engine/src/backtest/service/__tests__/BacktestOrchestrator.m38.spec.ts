/**
 * BacktestOrchestrator — M38 D1 fill-time TP rebase tests (ADR 0045)
 *
 * Surfaces under test:
 *
 *   D1B1 — Momentum (tpRebaseEligible=true, atrDistance=X): LONG buildPosition produces
 *           takeProfitUsdt = fill + atrDistance, NOT the old signal-time frozen TP
 *   D1B2 — Momentum (tpRebaseEligible=true, atrDistance=X): SHORT buildPosition produces
 *           takeProfitUsdt = fill - atrDistance, NOT the old signal-time frozen TP
 *   D1B3 — Mean-reversion (tpRebaseEligible=false, atrDistance=null): buildPosition keeps
 *           the original clampedExit.takeProfitPrice frozen (no rebase)
 *   D1B4 — SL is NEVER rebased — stopLossUsdt equals clampedExit.stopLossPrice on BOTH
 *           momentum and mean-reversion paths
 *   D1B5 — Null atrDistance with tpRebaseEligible=true: fallback to frozen TP (edge case)
 *   D1B6 — D2 (evaluateFillDrift) is NOT invoked in backtest — only D1 rebase applies
 *   D1B7 — processEvent round-trip: momentum LONG with fill drift produces position where
 *           takeProfitUsdt = fill + atrDistance (end-to-end through processEvent)
 */

import {
    CoinTierEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RegimeLabelEnum,
    RiskOutcomeEnum,
    SignalActionEnum,
    SignalTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IApprovedRiskDecision } from '../../../risk/interface';
import { ReservationLedger } from '../../../risk/service';
import { IStrategy } from '../../../strategy/interface';
import { MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER } from '../../../strategy/const';
import { BacktestInstrumentAdapter } from '../../adapter/BacktestInstrumentAdapter';
import { BacktestPositionAdapter } from '../../adapter/BacktestPositionAdapter';
import { BacktestRiskStateAdapter } from '../../adapter/BacktestRiskStateAdapter';
import { BacktestBook } from '../../state/BacktestBook';
import { BacktestPnLLedger } from '../../state/BacktestPnLLedger';
import { BacktestExecutionSink } from '../BacktestExecutionSink';
import { BacktestOrchestrator, IBacktestOrchestratorContext } from '../BacktestOrchestrator';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const SIGNAL_VWAP = '50000';
const SIGNAL_DEVIATION_PCT = 1.0;
const ATR14 = '100';
// atrDistance = ATR14 * MULTIPLIER = 100 * 2.0 = 200
const ATR_DISTANCE = new Money(ATR14).times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

function buildParams() {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.3,
        btc_correlated_move_threshold_pct: 1.0,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier2_min_abs_move_pct: 1.0,
        tier3_min_abs_move_pct: 2.0,
        tier1_max_abs_move_pct: 5.0,
        tier2_max_abs_move_pct: 8.0,
        tier3_max_abs_move_pct: 12.0,
        funding_rate_suppress_threshold: 0.01,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 3,
        max_trades_per_symbol_per_day: 5,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
        min_rr: 1.5,
        entry_pct_floor: 0.3,
        atr_floor_multiplier: 0.3,
        max_tp_dist_factor: 5.0,
    };
}

function buildEvent(side: DeviationSideEnum = DeviationSideEnum.ABOVE) {
    return {
        symbol: 'BTCUSDT',
        side,
        entryCandleOpenTime: 1_700_000_000_000,
        eventId: 'BTCUSDT:1700000000000',
        vwapSession: new Money(SIGNAL_VWAP).toFixed(18),
        vwap20bar: new Money(SIGNAL_VWAP).toFixed(18),
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: side === DeviationSideEnum.ABOVE ? SIGNAL_DEVIATION_PCT : -SIGNAL_DEVIATION_PCT,
        vwapDeviationSigma: 1.8,
        volumeRatio: 2.0,
        volume20barAvg: new Money('500000').toFixed(18),
        atr14: new Money(ATR14).toFixed(18),
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 60,
        bollingerUpper: new Money('51000').toFixed(18),
        bollingerLower: new Money('49000').toFixed(18),
        bollingerPctB: 0.7,
        btc5mMovePct: 0.5,
        idiosyncrasyScore: 0.6,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 2,
        symbolUniverseAgeHours: 48,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.1,
        openInterest: new Money('1000000').toFixed(18),
        openInterestChange5mPct: 0.1,
        openInterestChange15mPct: 0.3,
        aggTradeBuyVolumeRatio: 0.55,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: new Money('200000').toFixed(18),
        bookDepth50bpsUsdt: new Money('500000').toFixed(18),
        regimeLabel: RegimeLabelEnum.TRENDING_UP,
        marketBreadth5mUpPct: 60,
        sameBarTriggerCount: 3,
        btc1mMovePct: 0.1,
        eth5mMovePct: 0.4,
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildMomentumApprovedDecision(tradeSide: PositionSideEnum, fillPrice: string, overrides: Partial<IApprovedRiskDecision> = {}): IApprovedRiskDecision {
    const fill = new Money(fillPrice);
    // Signal-time frozen TP (the OLD value before D1 rebase)
    const frozenTp =
        tradeSide === PositionSideEnum.LONG
            ? fill.plus(new Money('50')) // intentionally different from fill+ATR_DISTANCE to verify rebase
            : fill.minus(new Money('50')); // same idea for SHORT

    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: {
            qty: new Money('0.5'),
            notional: new Money('1000'),
            leverage: new Money('2'),
            riskPerTradeUsdt: new Money('20'),
            effectiveRiskUsdt: new Money('20'),
        },
        clampedExit: {
            takeProfitPrice: frozenTp, // signal-time frozen TP
            stopLossPrice: new Money(SIGNAL_VWAP), // VWAP for momentum SL
            stopType: 'structural' as any,
            timeStopAtMs: 1_700_003_600_000,
            tpRebaseEligible: true,
            atrDistance: ATR_DISTANCE, // atr14 * MULTIPLIER = 100 * 2.0 = 200
        },
        reservationId: 'test-res-id',
        haltReasonDetail: null,
        ...overrides,
    };
}

function buildMeanReversionApprovedDecision(_fillPrice: string): IApprovedRiskDecision {
    const frozenTp = new Money('49900'); // VWAP-anchored TP, must be preserved as-is

    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: PositionSlotEnum.A,
        approvedSizing: {
            qty: new Money('0.5'),
            notional: new Money('1000'),
            leverage: new Money('2'),
            riskPerTradeUsdt: new Money('20'),
            effectiveRiskUsdt: new Money('20'),
        },
        clampedExit: {
            takeProfitPrice: frozenTp,
            stopLossPrice: new Money('51000'), // structural stop (wick)
            stopType: 'structural' as any,
            timeStopAtMs: 1_700_003_600_000,
            tpRebaseEligible: false,
            atrDistance: null,
        },
        reservationId: 'test-res-id',
        haltReasonDetail: null,
    };
}

function buildInstrumentConstraints() {
    return {
        symbol: 'BTCUSDT',
        stepSize: new Money('0.001'),
        tickSize: new Money('0.01'),
        minNotional: new Money('5'),
        maintenanceMarginRate: new Money('0.005'),
    };
}

function buildContext(
    fillPrice: string,
    approvedDecision: IApprovedRiskDecision,
    tradeSide: PositionSideEnum,
    strategyOverride?: IStrategy,
): IBacktestOrchestratorContext {
    const book = new BacktestBook();
    book.instruments.set('BTCUSDT', buildInstrumentConstraints());

    const ledger = new BacktestPnLLedger();
    const sink = new BacktestExecutionSink(book, ledger);

    const openSignal = {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS,
        skipReason: null,
        tradeSide,
        signalScore: 80,
        flowType: FlowTypeEnum.TREND_INITIATION,
        reason: 'momentum_follow',
        proposedExit: approvedDecision.clampedExit,
    };

    return {
        book,
        ledger,
        sink,
        positionAdapter: new BacktestPositionAdapter(book),
        riskStateAdapter: new BacktestRiskStateAdapter(book),
        instrumentAdapter: new BacktestInstrumentAdapter(book),
        reservationLedger: new ReservationLedger(),
        fillSim: {
            simulateFill: jest.fn().mockReturnValue({
                eventId: 'BTCUSDT:1700000000000',
                symbol: 'BTCUSDT',
                side: tradeSide === PositionSideEnum.LONG ? 'long' : 'short',
                intent: 'open',
                priceUsdt: fillPrice,
                qty: '0.5',
                feeUsdt: '5',
                slippagePct: '0.05',
                tsMs: 1_700_000_300_000,
                missed: false,
                depthAware: false,
            }),
        } as any,
        ticks: [],
        bookSnapshot: null,
        strategy: strategyOverride ?? {
            name: 'v2',
            version: 2,
            direction: 'both' as any,
            evaluate: jest.fn().mockReturnValue(openSignal),
        },
        params: buildParams(),
        strategyVersionId: 2,
        tierSlippageParams: {
            slippage_tier1_pct: 0.05,
            slippage_tier2_pct: 0.1,
            slippage_tier3_pct: 0.2,
        },
        config: {
            strategyVersionId: 2,
            fromUtcDate: '2024-01-01',
            toUtcDate: '2024-01-31',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
            runLabel: 'test-m38',
        },
        isInUniverse: true,
        utcDateString: '2024-01-15',
        allocatedCapitalUsdt: '10000',
        nextBarOpen: new Money('50505'),
    };
}

function buildOrchestrator(approvedDecision: IApprovedRiskDecision) {
    const riskGate = {
        evaluate: jest.fn().mockResolvedValue(approvedDecision),
    } as any;

    const sizing = {
        kind: 'sized' as const,
        sizing: approvedDecision.approvedSizing,
    };

    const sizer = { size: jest.fn().mockReturnValue(sizing) } as any;

    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('50505'),
            timeoutMs: 800,
            slippageCapPct: new Money('0.05'),
            reduceOnly: false,
        }),
    } as any;

    return new BacktestOrchestrator(riskGate, sizer, policyRouter);
}

// Helper: get the single open position from the book after a fill (positionId is generated,
// so we take the first entry in the openPositions map). Throws if no position exists
// so tests fail with a clear message rather than a TypeScript undefined-access error.
function getFirstOpenPosition(ctx: IBacktestOrchestratorContext) {
    const entry = ctx.book.openPositions.values().next().value;
    if (!entry) throw new Error('No open position found in book');
    return entry;
}

// ─── D1B1: Momentum LONG → takeProfitUsdt = fill + atrDistance ────────────────

describe('BacktestOrchestrator M38 D1 — D1B1: momentum LONG fill → takeProfitUsdt rebased to fill + atrDistance', () => {
    it('momentum LONG position has takeProfitUsdt = fill + atrDistance (not frozen signal TP)', async () => {
        const fillPrice = '50520'; // fill drifted from signal 50505
        const approvedDecision = buildMomentumApprovedDecision(PositionSideEnum.LONG, fillPrice);
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.LONG);

        const result = await orchestrator.processEvent(buildEvent(DeviationSideEnum.ABOVE), ctx);

        expect(result.filled).toBe(true);
        expect(ctx.book.openPositionCount()).toBe(1);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();

        // Expected rebased TP = fill + atrDistance = 50520 + 200 = 50720
        const expectedTp = new Money(fillPrice).plus(ATR_DISTANCE);
        expect(position.takeProfitUsdt).toBe(expectedTp.toFixed(18));

        // Must NOT be the frozen signal TP (which was fill + 50 in our fixture = 50570)
        expect(position.takeProfitUsdt).not.toBe(approvedDecision.clampedExit.takeProfitPrice.toFixed(18));
    });
});

// ─── D1B2: Momentum SHORT → takeProfitUsdt = fill - atrDistance ──────────────

describe('BacktestOrchestrator M38 D1 — D1B2: momentum SHORT fill → takeProfitUsdt rebased to fill - atrDistance', () => {
    it('momentum SHORT position has takeProfitUsdt = fill - atrDistance (not frozen signal TP)', async () => {
        const fillPrice = '50480'; // fill drifted from signal
        const approvedDecision = buildMomentumApprovedDecision(PositionSideEnum.SHORT, fillPrice);
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.SHORT);

        const result = await orchestrator.processEvent(buildEvent(DeviationSideEnum.ABOVE), ctx);

        expect(result.filled).toBe(true);
        expect(ctx.book.openPositionCount()).toBe(1);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();

        // Expected rebased TP = fill - atrDistance = 50480 - 200 = 50280
        const expectedTp = new Money(fillPrice).minus(ATR_DISTANCE);
        expect(position.takeProfitUsdt).toBe(expectedTp.toFixed(18));
    });
});

// ─── D1B3: Mean-reversion → frozen TP preserved ───────────────────────────────

describe('BacktestOrchestrator M38 D1 — D1B3: mean-reversion (tpRebaseEligible=false) keeps frozen takeProfitPrice unchanged', () => {
    it('mean-reversion position preserves the original clampedExit.takeProfitPrice unchanged', async () => {
        const fillPrice = '50520';
        const approvedDecision = buildMeanReversionApprovedDecision(fillPrice);
        const frozenTp = approvedDecision.clampedExit.takeProfitPrice;
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.SHORT);

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        expect(result.filled).toBe(true);
        expect(ctx.book.openPositionCount()).toBe(1);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();

        // TP must be the original frozen VWAP-anchored value, not fill ± something
        expect(position.takeProfitUsdt).toBe(frozenTp.toFixed(18));
    });

    it('mean-reversion TP is NOT fill - atrDistance (no rebase corruption)', async () => {
        const fillPrice = '50520';
        const approvedDecision = buildMeanReversionApprovedDecision(fillPrice);
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.SHORT);

        await orchestrator.processEvent(buildEvent(), ctx);

        const position = getFirstOpenPosition(ctx);
        // The position TP must NOT equal fill-ATR (which would be what corruption looks like)
        const corruptedTp = new Money(fillPrice).minus(ATR_DISTANCE).toFixed(18);
        expect(position.takeProfitUsdt).not.toBe(corruptedTp);
    });
});

// ─── D1B4: SL never rebased on either path ────────────────────────────────────

describe('BacktestOrchestrator M38 D1 — D1B4: SL is never rebased on momentum or mean-reversion path', () => {
    it('momentum LONG position: stopLossUsdt equals clampedExit.stopLossPrice unchanged', async () => {
        const fillPrice = '50520';
        const approvedDecision = buildMomentumApprovedDecision(PositionSideEnum.LONG, fillPrice);
        const originalSl = approvedDecision.clampedExit.stopLossPrice;
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.LONG);

        await orchestrator.processEvent(buildEvent(), ctx);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();
        expect(position.stopLossUsdt).toBe(originalSl.toFixed(18));
    });

    it('mean-reversion position: stopLossUsdt equals clampedExit.stopLossPrice unchanged', async () => {
        const fillPrice = '50520';
        const approvedDecision = buildMeanReversionApprovedDecision(fillPrice);
        const originalSl = approvedDecision.clampedExit.stopLossPrice;
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.SHORT);

        await orchestrator.processEvent(buildEvent(), ctx);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();
        expect(position.stopLossUsdt).toBe(originalSl.toFixed(18));
    });
});

// ─── D1B5: tpRebaseEligible=true but atrDistance=null → frozen TP fallback ────

describe('BacktestOrchestrator M38 D1 — D1B5: tpRebaseEligible=true with null atrDistance → fallback to frozen TP, no crash', () => {
    it('does not throw and uses frozen TP when atrDistance is null despite tpRebaseEligible=true', async () => {
        const fillPrice = '50520';
        const frozenTp = new Money('50700');
        const approvedDecision: IApprovedRiskDecision = {
            outcome: RiskOutcomeEnum.APPROVED,
            rejectReason: null,
            approvedSlot: PositionSlotEnum.A,
            approvedSizing: {
                qty: new Money('0.5'),
                notional: new Money('1000'),
                leverage: new Money('2'),
                riskPerTradeUsdt: new Money('20'),
                effectiveRiskUsdt: new Money('20'),
            },
            clampedExit: {
                takeProfitPrice: frozenTp,
                stopLossPrice: new Money('50000'),
                stopType: 'structural' as any,
                timeStopAtMs: 1_700_003_600_000,
                tpRebaseEligible: true, // eligible but distance missing
                atrDistance: null, // null — should trigger fallback
            },
            reservationId: 'test-res-id',
            haltReasonDetail: null,
        };

        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.LONG);

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        expect(result.filled).toBe(true);
        expect(ctx.book.openPositionCount()).toBe(1);

        const position = getFirstOpenPosition(ctx);
        expect(position).toBeDefined();
        // Must use frozen TP, not crash
        expect(position.takeProfitUsdt).toBe(frozenTp.toFixed(18));
    });
});

// ─── D1B6: D2 (evaluateFillDrift) is NOT called in backtest ──────────────────

describe('BacktestOrchestrator M38 D1 — D1B6: D2 fill-acceptance guard is not invoked in backtest', () => {
    it('a fill that would be rejected by D2 wrong-side-of-SL check still creates a position in backtest', async () => {
        // In backtest we simulate a fill that is below the SL (which D2 would reject live).
        // The backtest must still record the position (D2 is live-only per ADR 0045 §8).
        const fillPrice = '49900'; // below VWAP SL of 50000 (would be wrong-side D2 reject live)
        const approvedDecision = buildMomentumApprovedDecision(PositionSideEnum.LONG, fillPrice);
        const orchestrator = buildOrchestrator(approvedDecision);
        const ctx = buildContext(fillPrice, approvedDecision, PositionSideEnum.LONG);

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        // Backtest does not apply D2: the position is created regardless of wrong-side geometry
        expect(result.filled).toBe(true);
        expect(ctx.book.openPositionCount()).toBe(1);
    });
});
