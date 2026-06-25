/**
 * BacktestOrchestrator — adversarial unit tests.
 *
 * Surfaces under test:
 *   O1 — processEvent: SKIPPED when strategy returns SKIP
 *   O2 — processEvent: SKIPPED when strategy returns OPEN but open position exists (ADD out-of-scope)
 *   O3 — processEvent: SKIPPED when sizing returns kind≠'sized'
 *   O4 — processEvent: REJECTED when gate rejects the intent
 *   O5 — processEvent: MISSED when fill is simulated as missed + reservation released (no leak)
 *   O6 — processEvent: FILLED + reservation confirmed + position written when fill succeeds
 *   O7 — resolveCorrelationMode: btc5mMovePct >= threshold → CORRELATED; below → IDIOSYNCRATIC
 *   O8 — mapSlot: A, B, C all map to correct string literals
 *
 * Dependencies mocked: RiskGateService, PositionSizer. The strategy, FillSimulator,
 * ReservationLedger, BacktestExecutionSink, BacktestBook, and adapters are provided as
 * real or minimal fakes to keep tests authoritative.
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    PositionSlotEnum,
    RegimeLabelEnum,
    RejectReasonEnum,
    RiskOutcomeEnum,
    SignalActionEnum,
    SignalTypeEnum,
    SkipReasonEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IApprovedRiskDecision, IRiskDecision } from '../../../risk/interface';
import { ReservationLedger } from '../../../risk/service';
import { IStrategy } from '../../../strategy/interface';
import { BacktestInstrumentAdapter } from '../../adapter/BacktestInstrumentAdapter';
import { BacktestPositionAdapter } from '../../adapter/BacktestPositionAdapter';
import { BacktestRiskStateAdapter } from '../../adapter/BacktestRiskStateAdapter';
import { BacktestBook } from '../../state/BacktestBook';
import { BacktestPnLLedger } from '../../state/BacktestPnLLedger';
import { BacktestExecutionSink } from '../BacktestExecutionSink';
import { BacktestOrchestrator, IBacktestOrchestratorContext } from '../BacktestOrchestrator';

// ─── helpers ──────────────────────────────────────────────────────────────────

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

function buildEvent() {
    return {
        symbol: 'ETHUSDT',
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: 1_700_000_000_000,
        eventId: 'ETHUSDT:1700000000000',
        vwapSession: new Money('2000').toFixed(18),
        vwap20bar: new Money('2000').toFixed(18),
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 2.5,
        vwapDeviationSigma: 1.2,
        volumeRatio: 2.0,
        volume20barAvg: new Money('500000').toFixed(18),
        atr14: new Money('50').toFixed(18),
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 60,
        bollingerUpper: new Money('2100').toFixed(18),
        bollingerLower: new Money('1900').toFixed(18),
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
        flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
    };
}

function buildOpenSignal() {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.SHORT,
        signalScore: 72,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        reason: 'reversion_above_vwap',
        proposedExit: {
            takeProfitPrice: new Money('1900'),
            stopLossPrice: new Money('2100'),
            stopType: 'atr' as any,
            timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        },
    };
}

function buildSkipSignal() {
    return {
        action: SignalActionEnum.SKIP,
        signalType: SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS,
        skipReason: SkipReasonEnum.BASELINE_NO_TRADE,
        tradeSide: null,
        signalScore: 0,
        flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
        reason: 'baseline_no_trade',
        proposedExit: null,
    };
}

function buildApprovedDecision(overrides: Partial<IApprovedRiskDecision> = {}): IApprovedRiskDecision {
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
            takeProfitPrice: new Money('1900'),
            stopLossPrice: new Money('2100'),
            stopType: 'atr' as any,
            timeStopAtMs: 1_700_003_600_000,
            tpRebaseEligible: false,
            atrDistance: null,
        },
        reservationId: 'test-reservation-id',
        haltReasonDetail: null,
        ...overrides,
    };
}

function buildRejectedDecision(): IRiskDecision {
    return {
        outcome: RiskOutcomeEnum.REJECTED,
        rejectReason: RejectReasonEnum.MAX_POSITIONS_REACHED,
        approvedSlot: null,
        approvedSizing: null,
        clampedExit: null,
        reservationId: null,
        haltReasonDetail: null,
    };
}

function buildInstrumentConstraints() {
    return {
        symbol: 'ETHUSDT',
        stepSize: new Money('0.001'),
        tickSize: new Money('0.01'),
        minNotional: new Money('5'),
        maintenanceMarginRate: new Money('0.005'),
    };
}

function buildContext(bookOverride?: BacktestBook, strategyOverride?: IStrategy): IBacktestOrchestratorContext {
    const book = bookOverride ?? new BacktestBook();
    book.instruments.set('ETHUSDT', buildInstrumentConstraints());

    const ledger = new BacktestPnLLedger();
    const sink = new BacktestExecutionSink(book, ledger);

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
                eventId: 'ETHUSDT:1700000000000',
                symbol: 'ETHUSDT',
                side: 'short',
                intent: 'open',
                priceUsdt: '2051',
                qty: '0.5',
                feeUsdt: '0.41',
                slippagePct: '0.05',
                tsMs: 1_700_000_300_000,
                missed: false,
                depthAware: false,
            }),
        } as any,
        ticks: [],
        bookSnapshot: null,
        strategy: strategyOverride ?? {
            name: 'v1',
            version: 1,
            direction: 'both' as any,
            evaluate: jest.fn().mockReturnValue(buildOpenSignal()),
        },
        params: buildParams(),
        strategyVersionId: 1,
        tierSlippageParams: {
            slippage_tier1_pct: 0.05,
            slippage_tier2_pct: 0.1,
            slippage_tier3_pct: 0.2,
        },
        config: {
            strategyVersionId: 1,
            fromUtcDate: '2024-01-01',
            toUtcDate: '2024-01-31',
            allocatedCapitalUsdt: '10000',
            latencyMs: 100,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: false,
            runLabel: 'test-run',
        },
        isInUniverse: true,
        utcDateString: '2024-01-15',
        allocatedCapitalUsdt: '10000',
        nextBarOpen: new Money('2000'),
    };
}

function buildOrchestrator(
    riskGateDecision: IRiskDecision = buildApprovedDecision(),
    sizingKind: 'sized' | 'below_min_notional' | 'invalid_inputs' | 'funding_suppressed' = 'sized',
) {
    const riskGate = {
        evaluate: jest.fn().mockResolvedValue(riskGateDecision),
    } as any;

    const sizing =
        sizingKind === 'sized'
            ? {
                  kind: 'sized' as const,
                  sizing: {
                      qty: new Money('0.5'),
                      notional: new Money('1000'),
                      leverage: new Money('2'),
                      riskPerTradeUsdt: new Money('20'),
                      effectiveRiskUsdt: new Money('20'),
                  },
              }
            : { kind: sizingKind as any };

    const sizer = {
        size: jest.fn().mockReturnValue(sizing),
    } as any;

    // M8 W1: BacktestOrchestrator depends on IOrderPolicyRouter. The default test fake
    // returns MARKETABLE_LIMIT_IOC for every call, preserving the pre-M8 hard-coded
    // behaviour these legacy assertions were calibrated against. Tests that exercise
    // policy routing construct the orchestrator directly with a custom router.
    const policyRouter = {
        plan: jest.fn().mockReturnValue({
            policy: OrderPolicyEnum.MARKETABLE_LIMIT_IOC,
            limitPrice: new Money('2000'),
            timeoutMs: 800,
            slippageCapPct: new Money('0.05'),
            reduceOnly: false,
        }),
    } as any;

    return { orchestrator: new BacktestOrchestrator(riskGate, sizer, policyRouter), riskGate, sizer, policyRouter };
}

// ─── O1: SKIP signal ──────────────────────────────────────────────────────────

describe('BacktestOrchestrator.processEvent — SKIP signal', () => {
    it('returns SKIPPED when strategy evaluate returns SKIP action', async () => {
        const { orchestrator } = buildOrchestrator();
        const skipStrategy = {
            name: 'v1',
            version: 1,
            direction: 'both' as any,
            evaluate: jest.fn().mockReturnValue(buildSkipSignal()),
        };
        const ctx = buildContext(undefined, skipStrategy);

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        expect(result.skipped).toBe(true);
        expect(result.rejectedByGate).toBe(false);
        expect(result.missedFill).toBe(false);
        expect(result.filled).toBe(false);
    });

    it('does not call the risk gate when strategy skips', async () => {
        const { orchestrator, riskGate } = buildOrchestrator();
        const skipStrategy = {
            name: 'v1',
            version: 1,
            direction: 'both' as any,
            evaluate: jest.fn().mockReturnValue(buildSkipSignal()),
        };

        await orchestrator.processEvent(buildEvent(), buildContext(undefined, skipStrategy));

        expect(riskGate.evaluate).not.toHaveBeenCalled();
    });
});

// ─── O2: OPEN onto existing position → SKIPPED ───────────────────────────────

describe('BacktestOrchestrator.processEvent — ADD out of scope', () => {
    it('returns SKIPPED when strategy returns OPEN but position already exists for the symbol', async () => {
        const { orchestrator } = buildOrchestrator();

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        // Pre-place an open position for ETHUSDT
        book.openPositions.set('existing-position', {
            positionId: 'existing-position',
            symbol: 'ETHUSDT',
            side: 'long',
            slot: 'A',
            entryPriceUsdt: '1950',
            qty: '0.5',
            entryNotionalUsdt: '975',
            leverage: '2.0000',
            stopLossUsdt: '1850',
            takeProfitUsdt: '2100',
            openedAtMs: 1_699_990_000_000,
            timeStopAtMs: null,
            maxAdverseExcursionPct: '0',
            maxFavorableExcursionPct: '0',
            accumulatedFundingUsdt: '0',
        });

        const result = await orchestrator.processEvent(buildEvent(), buildContext(book));

        expect(result.skipped).toBe(true);
    });

    it('does not call the risk gate when position already exists', async () => {
        const { orchestrator, riskGate } = buildOrchestrator();

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        book.openPositions.set('existing-position', {
            positionId: 'existing-position',
            symbol: 'ETHUSDT',
            side: 'long',
            slot: 'B',
            entryPriceUsdt: '2000',
            qty: '0.3',
            entryNotionalUsdt: '600',
            leverage: '1.5000',
            stopLossUsdt: '1900',
            takeProfitUsdt: '2200',
            openedAtMs: 1_699_990_000_000,
            timeStopAtMs: null,
            maxAdverseExcursionPct: '0',
            maxFavorableExcursionPct: '0',
            accumulatedFundingUsdt: '0',
        });

        await orchestrator.processEvent(buildEvent(), buildContext(book));

        expect(riskGate.evaluate).not.toHaveBeenCalled();
    });

    it('does NOT skip when a different symbol has an open position', async () => {
        const approved = buildApprovedDecision();
        const { orchestrator: orchApproved } = buildOrchestrator(approved);

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        // Position for a different symbol — should not block ETHUSDT
        book.openPositions.set('btc-position', {
            positionId: 'btc-position',
            symbol: 'BTCUSDT',
            side: 'long',
            slot: 'C',
            entryPriceUsdt: '42000',
            qty: '0.01',
            entryNotionalUsdt: '420',
            leverage: '2.0000',
            stopLossUsdt: '40000',
            takeProfitUsdt: '44000',
            openedAtMs: 1_699_990_000_000,
            timeStopAtMs: null,
            maxAdverseExcursionPct: '0',
            maxFavorableExcursionPct: '0',
            accumulatedFundingUsdt: '0',
        });

        const result = await orchApproved.processEvent(buildEvent(), buildContext(book));

        // Should NOT be skipped due to a different symbol's open position
        expect(result.skipped).toBe(false);
    });
});

// ─── O3: Sizing returns non-sized → SKIPPED ──────────────────────────────────

describe('BacktestOrchestrator.processEvent — sizing failure', () => {
    it('returns SKIPPED when sizer returns below_min_notional', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision(), 'below_min_notional');

        const result = await orchestrator.processEvent(buildEvent(), buildContext());

        expect(result.skipped).toBe(true);
    });

    it('returns SKIPPED when sizer returns invalid_inputs', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision(), 'invalid_inputs');

        const result = await orchestrator.processEvent(buildEvent(), buildContext());

        expect(result.skipped).toBe(true);
    });

    it('returns SKIPPED when sizer returns funding_suppressed', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision(), 'funding_suppressed');

        const result = await orchestrator.processEvent(buildEvent(), buildContext());

        expect(result.skipped).toBe(true);
    });

    it('does not call the risk gate when sizing fails', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision(), 'below_min_notional');

        await orchestrator.processEvent(buildEvent(), buildContext());

        expect(riskGate.evaluate).not.toHaveBeenCalled();
    });
});

// ─── O4: Gate rejects → REJECTED ─────────────────────────────────────────────

describe('BacktestOrchestrator.processEvent — gate rejection', () => {
    it('returns REJECTED when risk gate rejects the intent', async () => {
        const { orchestrator } = buildOrchestrator(buildRejectedDecision());

        const result = await orchestrator.processEvent(buildEvent(), buildContext());

        expect(result.rejectedByGate).toBe(true);
        expect(result.skipped).toBe(false);
        expect(result.missedFill).toBe(false);
        expect(result.filled).toBe(false);
    });
});

// ─── O5: Fill missed → MISSED + reservation released ─────────────────────────

describe('BacktestOrchestrator.processEvent — missed fill', () => {
    it('returns MISSED when fill simulator reports missed', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const ledger = new BacktestPnLLedger();
        const sink = new BacktestExecutionSink(book, ledger);
        const reservationLedger = new ReservationLedger();

        const ctx: IBacktestOrchestratorContext = {
            ...buildContext(book),
            ledger,
            sink,
            reservationLedger,
            fillSim: {
                simulateFill: jest.fn().mockReturnValue({
                    eventId: 'ETHUSDT:1700000000000',
                    symbol: 'ETHUSDT',
                    side: 'short',
                    intent: 'open',
                    priceUsdt: '0',
                    qty: '0',
                    feeUsdt: '0',
                    slippagePct: '0',
                    tsMs: 1_700_000_300_000,
                    missed: true,
                    depthAware: false,
                }),
            } as any,
        };

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        expect(result.missedFill).toBe(true);
        expect(result.filled).toBe(false);
    });

    it('releases the reservation when fill is missed (no reservation leak)', async () => {
        const decision = buildApprovedDecision({ reservationId: 'res-to-release' });
        const { orchestrator } = buildOrchestrator(decision);

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const ledger = new BacktestPnLLedger();
        const sink = new BacktestExecutionSink(book, ledger);
        const reservationLedger = new ReservationLedger();
        const releaseSpy = jest.spyOn(reservationLedger, 'releaseReservation');

        const ctx: IBacktestOrchestratorContext = {
            ...buildContext(book),
            ledger,
            sink,
            reservationLedger,
            fillSim: {
                simulateFill: jest.fn().mockReturnValue({
                    eventId: 'ETHUSDT:1700000000000',
                    symbol: 'ETHUSDT',
                    side: 'short',
                    intent: 'open',
                    priceUsdt: '0',
                    qty: '0',
                    feeUsdt: '0',
                    slippagePct: '0',
                    tsMs: 1_700_000_300_000,
                    missed: true,
                    depthAware: false,
                }),
            } as any,
        };

        await orchestrator.processEvent(buildEvent(), ctx);

        expect(releaseSpy).toHaveBeenCalledWith('res-to-release');
    });

    it('does NOT confirm reservation when fill is missed', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const reservationLedger = new ReservationLedger();
        const confirmSpy = jest.spyOn(reservationLedger, 'confirmReservation');

        const ctx: IBacktestOrchestratorContext = {
            ...buildContext(book),
            reservationLedger,
            fillSim: {
                simulateFill: jest.fn().mockReturnValue({
                    eventId: 'ETHUSDT:1700000000000',
                    symbol: 'ETHUSDT',
                    side: 'short',
                    intent: 'open',
                    priceUsdt: '0',
                    qty: '0',
                    feeUsdt: '0',
                    slippagePct: '0',
                    tsMs: 1_700_000_300_000,
                    missed: true,
                    depthAware: false,
                }),
            } as any,
        };

        await orchestrator.processEvent(buildEvent(), ctx);

        expect(confirmSpy).not.toHaveBeenCalled();
    });
});

// ─── O6: Fill succeeds → FILLED ───────────────────────────────────────────────

describe('BacktestOrchestrator.processEvent — successful fill', () => {
    it('returns FILLED when fill succeeds', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const result = await orchestrator.processEvent(buildEvent(), buildContext());

        expect(result.filled).toBe(true);
        expect(result.skipped).toBe(false);
        expect(result.rejectedByGate).toBe(false);
        expect(result.missedFill).toBe(false);
    });

    it('confirms the reservation when fill succeeds', async () => {
        const decision = buildApprovedDecision({ reservationId: 'res-to-confirm' });
        const { orchestrator } = buildOrchestrator(decision);

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const ledger = new BacktestPnLLedger();
        const sink = new BacktestExecutionSink(book, ledger);
        const reservationLedger = new ReservationLedger();
        const confirmSpy = jest.spyOn(reservationLedger, 'confirmReservation');

        const ctx: IBacktestOrchestratorContext = {
            ...buildContext(book),
            ledger,
            sink,
            reservationLedger,
        };

        await orchestrator.processEvent(buildEvent(), ctx);

        expect(confirmSpy).toHaveBeenCalledWith('res-to-confirm');
    });

    it('registers the position in the book when fill succeeds', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const ctx = buildContext(book);

        await orchestrator.processEvent(buildEvent(), ctx);

        expect(book.openPositionCount()).toBe(1);
    });

    it('does NOT release reservation when fill succeeds', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const reservationLedger = new ReservationLedger();
        const releaseSpy = jest.spyOn(reservationLedger, 'releaseReservation');

        const ctx = { ...buildContext(book), reservationLedger };

        await orchestrator.processEvent(buildEvent(), ctx);

        expect(releaseSpy).not.toHaveBeenCalled();
    });
});

// ─── O7: resolveCorrelationMode ───────────────────────────────────────────────

describe('BacktestOrchestrator — resolveCorrelationMode', () => {
    it('resolves CORRELATED when btc5mMovePct equals threshold exactly (boundary)', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision());

        // threshold = 1.0 (from params.btc_correlated_move_threshold_pct)
        const event = { ...buildEvent(), btc5mMovePct: 1.0 };

        await orchestrator.processEvent(event, buildContext());

        const capturedIntent = riskGate.evaluate.mock.calls[0][0];
        expect(capturedIntent.correlationMode).toBe(CorrelationModeEnum.CORRELATED);
    });

    it('resolves CORRELATED when btc5mMovePct exceeds threshold', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision());

        const event = { ...buildEvent(), btc5mMovePct: 3.5 };

        await orchestrator.processEvent(event, buildContext());

        const capturedIntent = riskGate.evaluate.mock.calls[0][0];
        expect(capturedIntent.correlationMode).toBe(CorrelationModeEnum.CORRELATED);
    });

    it('resolves CORRELATED when btc5mMovePct is negative but absolute value meets threshold', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision());

        const event = { ...buildEvent(), btc5mMovePct: -2.0 };

        await orchestrator.processEvent(event, buildContext());

        const capturedIntent = riskGate.evaluate.mock.calls[0][0];
        expect(capturedIntent.correlationMode).toBe(CorrelationModeEnum.CORRELATED);
    });

    it('resolves IDIOSYNCRATIC when btc5mMovePct is below threshold', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision());

        const event = { ...buildEvent(), btc5mMovePct: 0.5 };

        await orchestrator.processEvent(event, buildContext());

        const capturedIntent = riskGate.evaluate.mock.calls[0][0];
        expect(capturedIntent.correlationMode).toBe(CorrelationModeEnum.IDIOSYNCRATIC);
    });

    it('resolves IDIOSYNCRATIC when btc5mMovePct is exactly zero', async () => {
        const { orchestrator, riskGate } = buildOrchestrator(buildApprovedDecision());

        const event = { ...buildEvent(), btc5mMovePct: 0 };

        await orchestrator.processEvent(event, buildContext());

        const capturedIntent = riskGate.evaluate.mock.calls[0][0];
        expect(capturedIntent.correlationMode).toBe(CorrelationModeEnum.IDIOSYNCRATIC);
    });
});

// ─── O8: mapSlot ──────────────────────────────────────────────────────────────

describe('BacktestOrchestrator — mapSlot via position slot field', () => {
    async function getPositionSlot(slotEnum: PositionSlotEnum): Promise<string> {
        const decision = buildApprovedDecision({ approvedSlot: slotEnum });
        const { orchestrator } = buildOrchestrator(decision);

        const book = new BacktestBook();
        book.instruments.set('ETHUSDT', buildInstrumentConstraints());
        const ctx = buildContext(book);

        await orchestrator.processEvent(buildEvent(), ctx);

        const positions = book.openPositionList();
        return positions[0].slot;
    }

    it('maps PositionSlotEnum.A to string "A"', async () => {
        const slot = await getPositionSlot(PositionSlotEnum.A);
        expect(slot).toBe('A');
    });

    it('maps PositionSlotEnum.B to string "B"', async () => {
        const slot = await getPositionSlot(PositionSlotEnum.B);
        expect(slot).toBe('B');
    });

    it('maps PositionSlotEnum.C to string "C"', async () => {
        const slot = await getPositionSlot(PositionSlotEnum.C);
        expect(slot).toBe('C');
    });
});

// ─── O9: instrument not seeded → SKIPPED ─────────────────────────────────────

describe('BacktestOrchestrator.processEvent — missing instrument', () => {
    it('returns SKIPPED when symbol has no instrument constraints seeded', async () => {
        const { orchestrator } = buildOrchestrator(buildApprovedDecision());

        const book = new BacktestBook();
        // Deliberately do NOT seed ETHUSDT into book.instruments — instrumentAdapter returns null
        const ledger = new BacktestPnLLedger();
        const sink = new BacktestExecutionSink(book, ledger);

        const ctx: IBacktestOrchestratorContext = {
            book,
            ledger,
            sink,
            positionAdapter: new BacktestPositionAdapter(book),
            riskStateAdapter: new BacktestRiskStateAdapter(book),
            instrumentAdapter: new BacktestInstrumentAdapter(book),
            reservationLedger: new ReservationLedger(),
            fillSim: {
                simulateFill: jest.fn().mockReturnValue({
                    eventId: 'ETHUSDT:1700000000000',
                    symbol: 'ETHUSDT',
                    side: 'short',
                    intent: 'open',
                    priceUsdt: '2051',
                    qty: '0.5',
                    feeUsdt: '0.41',
                    slippagePct: '0.05',
                    tsMs: 1_700_000_300_000,
                    missed: false,
                    depthAware: false,
                }),
            } as any,
            ticks: [],
            bookSnapshot: null,
            strategy: {
                name: 'v1',
                version: 1,
                direction: 'both' as any,
                evaluate: jest.fn().mockReturnValue(buildOpenSignal()),
            },
            params: buildParams(),
            strategyVersionId: 1,
            tierSlippageParams: {
                slippage_tier1_pct: 0.05,
                slippage_tier2_pct: 0.1,
                slippage_tier3_pct: 0.2,
            },
            config: {
                strategyVersionId: 1,
                fromUtcDate: '2024-01-01',
                toUtcDate: '2024-01-31',
                allocatedCapitalUsdt: '10000',
                latencyMs: 100,
                enableDepthAwareSlippage: false,
                enableIntrabarStopSimulation: false,
                runLabel: 'test-run',
            },
            isInUniverse: true,
            utcDateString: '2024-01-15',
            allocatedCapitalUsdt: '10000',
            nextBarOpen: new Money('2000'),
        };

        const result = await orchestrator.processEvent(buildEvent(), ctx);

        expect(result.skipped).toBe(true);
    });
});

// ─── M8 W1: OrderPolicyRouter injection ───────────────────────────────────────

describe('BacktestOrchestrator — OrderPolicyRouter injection (M8 W1)', () => {
    // Builds an orchestrator with a spy router so we can assert call args and override
    // the policy returned per-test. Mirrors buildOrchestrator() but exposes the spy.
    function buildOrchestratorWithRouter(routerPolicy: OrderPolicyEnum) {
        const riskGate = { evaluate: jest.fn().mockResolvedValue(buildApprovedDecision()) } as any;
        const sizer = {
            size: jest.fn().mockReturnValue({
                kind: 'sized' as const,
                sizing: {
                    qty: new Money('0.5'),
                    notional: new Money('1000'),
                    leverage: new Money('2'),
                    riskPerTradeUsdt: new Money('20'),
                    effectiveRiskUsdt: new Money('20'),
                },
            }),
        } as any;
        const policyRouter = {
            plan: jest.fn().mockReturnValue({
                policy: routerPolicy,
                limitPrice: new Money('2000'),
                timeoutMs: 800,
                slippageCapPct: new Money('0.05'),
                reduceOnly: false,
            }),
        } as any;

        return { orchestrator: new BacktestOrchestrator(riskGate, sizer, policyRouter), policyRouter };
    }

    it('passes the intent (including flowType) into the injected policy router', async () => {
        const { orchestrator, policyRouter } = buildOrchestratorWithRouter(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
        // V1 strategy stub — MEAN_REVERSION direction, returns an OPEN signal with FORCED_EXHAUSTION.
        const v1Strategy = {
            name: 'v1',
            version: 1,
            direction: 'mean_reversion' as any,
            evaluate: jest.fn().mockReturnValue(buildOpenSignal()),
        };
        const ctx = buildContext(undefined, v1Strategy);
        // Patch nextBarOpen so the orchestrator builds a fill request (which is what routes
        // through the policy router). buildContext supplies the rest.
        const ctxWithNextBar: IBacktestOrchestratorContext = { ...ctx, nextBarOpen: new Money('2000') } as any;

        await orchestrator.processEvent(buildEvent(), ctxWithNextBar);

        expect(policyRouter.plan).toHaveBeenCalledTimes(1);
        const arg = policyRouter.plan.mock.calls[0][0];
        expect(arg.intent.flowType).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        expect(arg.strategyDirection).toBe('mean_reversion');
        expect(arg.maxSlippageOfSlPct).toBeNull();
    });

    it('resolves HYBRID strategy direction by flow_type: TREND_INITIATION → MOMENTUM, FORCED_EXHAUSTION → MEAN_REVERSION', async () => {
        const v3Strategy = (flowType: FlowTypeEnum): IStrategy =>
            ({
                name: 'v3',
                version: 1,
                direction: 'hybrid' as any,
                evaluate: jest.fn().mockReturnValue({ ...buildOpenSignal(), flowType }),
            }) as any;

        // Case 1: TREND_INITIATION (new-money / catalyst leg) → MOMENTUM leg routed.
        {
            const { orchestrator, policyRouter } = buildOrchestratorWithRouter(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
            const ctx = buildContext(undefined, v3Strategy(FlowTypeEnum.TREND_INITIATION));
            const ctxWithNextBar: IBacktestOrchestratorContext = { ...ctx, nextBarOpen: new Money('2000') } as any;
            await orchestrator.processEvent(buildEvent(), ctxWithNextBar);

            expect(policyRouter.plan).toHaveBeenCalledTimes(1);
            expect(policyRouter.plan.mock.calls[0][0].strategyDirection).toBe('momentum');
            expect(policyRouter.plan.mock.calls[0][0].intent.flowType).toBe(FlowTypeEnum.TREND_INITIATION);
        }

        // Case 2: FORCED_EXHAUSTION (cascade) → MEAN_REVERSION leg routed (fade).
        {
            const { orchestrator, policyRouter } = buildOrchestratorWithRouter(OrderPolicyEnum.MARKETABLE_LIMIT_IOC);
            const ctx = buildContext(undefined, v3Strategy(FlowTypeEnum.FORCED_EXHAUSTION));
            const ctxWithNextBar: IBacktestOrchestratorContext = { ...ctx, nextBarOpen: new Money('2000') } as any;
            await orchestrator.processEvent(buildEvent(), ctxWithNextBar);

            expect(policyRouter.plan).toHaveBeenCalledTimes(1);
            expect(policyRouter.plan.mock.calls[0][0].strategyDirection).toBe('mean_reversion');
            expect(policyRouter.plan.mock.calls[0][0].intent.flowType).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        }
    });

    it('substituting a single-policy fake routes every event through that policy (isolation override)', async () => {
        const { orchestrator, policyRouter } = buildOrchestratorWithRouter(OrderPolicyEnum.POST_ONLY_MAKER);
        const v1Strategy = {
            name: 'v1',
            version: 1,
            direction: 'mean_reversion' as any,
            evaluate: jest.fn().mockReturnValue(buildOpenSignal()),
        };
        const ctx = buildContext(undefined, v1Strategy);
        const ctxWithNextBar: IBacktestOrchestratorContext = { ...ctx, nextBarOpen: new Money('2000') } as any;

        await orchestrator.processEvent(buildEvent(), ctxWithNextBar);

        // The override fake returned POST_ONLY_MAKER irrespective of inputs; the orchestrator
        // routed through it and asked the FillSimulator with the overridden policy.
        const fillSimMock = ctxWithNextBar.fillSim.simulateFill as jest.Mock;
        expect(fillSimMock).toHaveBeenCalledTimes(1);
        expect(fillSimMock.mock.calls[0][0].policy).toBe(OrderPolicyEnum.POST_ONLY_MAKER);
        expect(policyRouter.plan).toHaveBeenCalledTimes(1);
    });
});
