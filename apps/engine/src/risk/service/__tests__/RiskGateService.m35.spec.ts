/**
 * RiskGateService — M35 TP geometry guards (Finding 3 risk gate)
 *
 * Surfaces under test (exercised through public evaluate()):
 *
 *   TG1 — Wrong-side TP for SHORT (TP above entry) → REJECTED / TP_WRONG_SIDE
 *   TG2 — Wrong-side TP for LONG  (TP below entry) → REJECTED / TP_WRONG_SIDE
 *   TG3 — Correct-side TP but sub-cost LONG (distance < round-trip cost) → REJECTED / TP_BELOW_COST
 *   TG4 — Correct geometry (valid side, sufficient TP distance) → does NOT reject on TG guards
 *   TG5 — Boundary cost: TP distance exactly equals roundTripCostDistance → REJECTED / TP_BELOW_COST
 *
 * Round-trip cost formula: entry × (2 × RISK_TAKER_FEE_RATE + 2 × slippageFraction)
 *   RISK_TAKER_FEE_RATE = 0.0004 (0.04%)
 *   With estimated_slippage_pct = 0.04 → slippageFraction = 0.0004
 *   round-trip cost fraction = 2×0.0004 + 2×0.0004 = 0.0016 (0.16%)
 *
 * These guards run AFTER clampStopInsideLiquidation (which may short-circuit first),
 * so all fixtures supply an in-range SL that passes liquidation validation.
 */

import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { IRiskGateContext, IRiskStateDay, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── fixture constants ────────────────────────────────────────────────────────

const DATE = '2026-06-14';
const NOW_MS = new Date(`${DATE}T04:00:00.000Z`).getTime();

// EDGE/USDT price domain for SHORT tests
const EDGE_ENTRY_SHORT = new Money('0.415');
const EDGE_TP_WRONG_SIDE = new Money('0.416'); // above entry → wrong side for SHORT

// Standard price domain for LONG tests
const LONG_ENTRY = new Money('1.000');
const LONG_TP_WRONG_SIDE = new Money('0.999'); // below entry → wrong side for LONG

// ─── snapshot factories ───────────────────────────────────────────────────────

// estimated_slippage_pct=0.04 so round-trip cost = 2×0.04% + 2×0.04% = 0.16%
function buildCalmSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 0.5,
        vwap_deviation_sigma: 0.2,
        volume_ratio: 1.0,
        volume_20bar_avg: '1000000',
        atr_14: '200',
        adx_14: 20,
        adx_di_plus: 15,
        adx_di_minus: 10,
        rsi_14: 50,
        bollinger_upper: '51000',
        bollinger_lower: '49000',
        bollinger_pct_b: 0.5,
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        market_breadth_5m_up_pct: 50,
        same_bar_trigger_count: 0,
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.2,
        open_interest: '1000000',
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        bid_ask_spread_pct: 0.01,
        estimated_slippage_pct: 0.04, // round-trip cost = 0.16% of entry
        book_depth_10bps_usdt: '50000000',
        book_depth_50bps_usdt: '999999999',
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 80,
        position_slot: 'A',
        active_positions_count: 0,
        regime_label: 'ranging',
        entry_candle_open_time: NOW_MS,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session',
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };
}

function buildParams(): Record<string, unknown> {
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
        candle_interval: '5m',
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 100,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildLimits() {
    return {
        dailyLossLimitUsdt: new Money(9999),
        weeklyLossLimitUsdt: new Money(99999),
        maxExposurePerCoinUsdt: new Money(9999),
        maxSameDirectionExposureUsdt: new Money(99999),
        cooldownAfterLossMs: 0,
    };
}

function buildContext(overrides: { snapshot?: Record<string, unknown> } = {}): IRiskGateContext {
    const snapshot = overrides.snapshot ?? buildCalmSnapshot();

    const dayRow: IRiskStateDay = {
        date: DATE,
        realizedPnlDay: new Money(0),
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
    };

    return {
        nowMs: NOW_MS,
        utcDateString: DATE,
        snapshot: snapshot as any, // test boundary: partial snapshot fixture
        params: buildParams() as any, // test boundary: partial params fixture
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildLimits(),
        modelDivergenceDetected: false,
        riskState: {
            getDay: jest.fn().mockResolvedValue(dayRow),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money(0)),
            upsertDay: jest.fn().mockResolvedValue(undefined),
            upsertHaltForDay: jest.fn().mockResolvedValue(undefined),
            clearHaltForDate: jest.fn().mockResolvedValue(undefined),
        },
        openPositions: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
            findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
            countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
        },
        instruments: {
            findConstraints: jest.fn().mockResolvedValue({
                symbol: 'EDGEUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.0001'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        },
    };
}

// Build an intent with a valid SL for the given side so it passes clampStopInsideLiquidation.
// For SHORT: SL above entry (protective). For LONG: SL below entry.
// leverage=3x, maint=0.5%: safeDistance = entry * (1/3 - 0.005) * 0.8 ≈ entry * 0.2627.
// We keep SL inside that bound (entry ± 1%) to avoid SL_OUTSIDE_LIQUIDATION.
function buildIntent(tradeSide: PositionSideEnum, entryPrice: MoneyValue, takeProfitPrice: MoneyValue, overrides: Partial<IOrderIntent> = {}): IOrderIntent {
    const slBelow = entryPrice.times(new Money('0.99')); // 1% below entry
    const slAbove = entryPrice.times(new Money('1.01')); // 1% above entry
    const stopLossPrice = tradeSide === PositionSideEnum.LONG ? slBelow : slAbove;

    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'EDGEUSDT',
        eventId: 'EDGEUSDT:1700000000000',
        tradeSide,
        signalScore: 75,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8,
        entryPrice,
        midAtTrigger: entryPrice,
        maintenanceMarginRate: new Money('0.005'),
        proposedExit: {
            takeProfitPrice,
            stopLossPrice,
            stopType: 'structural' as any,
            timeStopAtMs: NOW_MS + 30 * 60_000,
            tpRebaseEligible: false,
            atrDistance: null,
        },
        openPosition: null,
        sizing: {
            qty: new Money('10'),
            notional: new Money('4.15'),
            leverage: new Money('3'),
            riskPerTradeUsdt: new Money('0.05'),
            effectiveRiskUsdt: new Money('0.05'),
        },
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };
}

function buildGate(): { gate: RiskGateService } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) } as any;
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { emit: jest.fn() } as any;
    const appConfig = { marketStressAutoResumeEnabled: true, paperRelaxMarketStress: false } as any;

    const gate = new RiskGateService(ledger, slotManager, stress, positions, riskState, events, appConfig);
    gate.markRecoveryComplete();

    return { gate };
}

// ─── TG1: Wrong-side TP for SHORT → TP_WRONG_SIDE ────────────────────────────

describe('RiskGateService M35 — TG1: SHORT with TP above entry → REJECTED / TP_WRONG_SIDE', () => {
    it('SHORT entry=0.415, takeProfitPrice=0.416 (above entry) → rejectReason=TP_WRONG_SIDE', async () => {
        const { gate } = buildGate();

        const intent = buildIntent(PositionSideEnum.SHORT, EDGE_ENTRY_SHORT, EDGE_TP_WRONG_SIDE);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });

    it('SHORT entry=0.415, TP exactly at entry → TP_WRONG_SIDE (guard uses >=)', async () => {
        // isWrongSideTakeProfit SHORT: tp.greaterThanOrEqualTo(entryPrice) → equality triggers
        const { gate } = buildGate();

        const intent = buildIntent(PositionSideEnum.SHORT, EDGE_ENTRY_SHORT, EDGE_ENTRY_SHORT);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });
});

// ─── TG2: Wrong-side TP for LONG → TP_WRONG_SIDE ─────────────────────────────

describe('RiskGateService M35 — TG2: LONG with TP below entry → REJECTED / TP_WRONG_SIDE', () => {
    it('LONG entry=1.000, takeProfitPrice=0.999 (below entry) → rejectReason=TP_WRONG_SIDE', async () => {
        const { gate } = buildGate();

        const intent = buildIntent(PositionSideEnum.LONG, LONG_ENTRY, LONG_TP_WRONG_SIDE);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });

    it('LONG entry=1.000, TP exactly at entry → TP_WRONG_SIDE (guard uses <=)', async () => {
        // isWrongSideTakeProfit LONG: tp.lessThanOrEqualTo(entryPrice) → equality triggers
        const { gate } = buildGate();

        const intent = buildIntent(PositionSideEnum.LONG, LONG_ENTRY, LONG_ENTRY);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });
});

// ─── TG3: Sub-cost TP for LONG → TP_BELOW_COST ───────────────────────────────

describe('RiskGateService M35 — TG3: correct-side TP but profit distance below round-trip cost → REJECTED / TP_BELOW_COST', () => {
    // Round-trip cost with estimated_slippage_pct=0.04:
    //   slippageFraction = 0.04/100 = 0.0004
    //   roundTripCostFraction = 2×0.0004 + 2×0.0004 = 0.0016
    //   for LONG entry=1.000: roundTripCostDistance = 1.000 × 0.0016 = 0.0016
    //   TP at 1.0006 → distance = 0.0006 < 0.0016 → TP_BELOW_COST

    it('LONG entry=1.000, TP=1.0006, slippage=0.04% → distance 0.06% < cost 0.16% → TP_BELOW_COST', async () => {
        const { gate } = buildGate();

        const entryPrice = new Money('1.000');
        const takeProfitPrice = new Money('1.0006'); // +0.06% above entry
        const intent = buildIntent(PositionSideEnum.LONG, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_BELOW_COST);
    });

    it('SHORT entry=0.415, TP below entry by 0.0008, slippage=0.04% → distance above cost → not TP_BELOW_COST', async () => {
        // Verify cost math in the short direction: TP below entry is correct side.
        // roundTripCostDistance = 0.415 * 0.0016 = 0.000664; distance 0.0008 > 0.000664 → passes
        const { gate } = buildGate();

        const entryPrice = new Money('0.415');
        // distance needed to pass: > entry * 0.0016 = 0.000664. Use 0.0008 → above cost.
        const takeProfitPrice = entryPrice.minus(new Money('0.0008')); // 0.4142
        const intent = buildIntent(PositionSideEnum.SHORT, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_BELOW_COST);
        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });
});

// ─── TG4: Correct geometry → passes TP guards ────────────────────────────────

describe('RiskGateService M35 — TG4: correct-side, sufficient-distance TP does NOT trigger TP_WRONG_SIDE or TP_BELOW_COST', () => {
    it('SHORT: TP 0.5% below entry (well above round-trip cost) → no TP geometry rejection', async () => {
        const { gate } = buildGate();

        const entryPrice = new Money('0.415');
        // 0.5% below entry = 0.415 * 0.995 = 0.413075. Distance = 0.001925, cost = 0.000664 → passes.
        const takeProfitPrice = entryPrice.times(new Money('0.995'));
        const intent = buildIntent(PositionSideEnum.SHORT, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_WRONG_SIDE);
        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_BELOW_COST);
    });

    it('LONG: TP 0.5% above entry → no TP geometry rejection', async () => {
        const { gate } = buildGate();

        const entryPrice = new Money('1.000');
        // distance = 0.005 >> cost = 0.0016 → passes.
        const takeProfitPrice = entryPrice.times(new Money('1.005'));
        const intent = buildIntent(PositionSideEnum.LONG, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_WRONG_SIDE);
        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_BELOW_COST);
    });
});

// ─── TG5: Boundary cost — exactly at threshold → TP_BELOW_COST ───────────────

describe('RiskGateService M35 — TG5: TP distance exactly equals round-trip cost → REJECTED / TP_BELOW_COST (guard is <=)', () => {
    // isTakeProfitBelowCost: tpDistance.lessThanOrEqualTo(roundTripCostDistance)
    // Equality → rejected.

    it('LONG entry=1.000, TP exactly at entry + roundTripCostDistance → TP_BELOW_COST', async () => {
        // roundTripCostFraction = 2×0.0004 + 2×0.0004 = 0.0016
        // roundTripCostDistance = 1.000 * 0.0016 = 0.0016
        // TP = 1.000 + 0.0016 = 1.0016 → tpDistance = 0.0016 = roundTripCostDistance → <=, rejected
        const { gate } = buildGate();

        const entryPrice = new Money('1.000');
        const roundTripCostDistance = new Money('0.0016'); // 1.000 × (2×0.0004 + 2×0.0004)
        const takeProfitPrice = entryPrice.plus(roundTripCostDistance);
        const intent = buildIntent(PositionSideEnum.LONG, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_BELOW_COST);
    });

    it('SHORT entry=0.415, TP exactly at entry - roundTripCostDistance → TP_BELOW_COST', async () => {
        // roundTripCostDistance = 0.415 * 0.0016 = 0.000664
        // TP = 0.415 - 0.000664 = 0.414336 → distance = 0.000664 = roundTripCostDistance → <=, rejected
        const { gate } = buildGate();

        const entryPrice = new Money('0.415');
        const roundTripCostDistance = entryPrice.times(new Money('0.0016'));
        const takeProfitPrice = entryPrice.minus(roundTripCostDistance);
        const intent = buildIntent(PositionSideEnum.SHORT, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).toBe(RejectReasonEnum.TP_BELOW_COST);
    });

    it('LONG entry=1.000, TP one minimal unit above boundary → NOT TP_BELOW_COST', async () => {
        // distance = 0.0016 + 0.000001 (one pip above) > roundTripCostDistance → passes cost guard
        const { gate } = buildGate();

        const entryPrice = new Money('1.000');
        const onePipAboveCost = new Money('0.001601');
        const takeProfitPrice = entryPrice.plus(onePipAboveCost);
        const intent = buildIntent(PositionSideEnum.LONG, entryPrice, takeProfitPrice);
        const result = await gate.evaluate(intent, buildContext());

        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_BELOW_COST);
        expect(result.rejectReason).not.toBe(RejectReasonEnum.TP_WRONG_SIDE);
    });
});
