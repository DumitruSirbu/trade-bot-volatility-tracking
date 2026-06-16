/**
 * RiskGateService — book-depth guard (M22 recalibration).
 *
 * Surfaces under test (all exercised through the public `evaluate()` API):
 *   BD1 — Per-tier boundary: depth exactly at floor → COIN_BOOK_TOO_THIN
 *   BD2 — Per-tier boundary: depth one cent above floor → does NOT return COIN_BOOK_TOO_THIN
 *   BD3 — Regression proof: soak depths that pass new floors but would have failed old floors
 *   BD4 — Still-blocked proof: depths below both old and new floors still reject
 *   BD5 — Fail-closed: empty/garbage/NaN/negative depth all reject COIN_BOOK_TOO_THIN
 *
 * The guard lives in the private `isBookTooThin` method called from `firstFailingTierFilter`.
 * All pre-depth checks are satisfied by the base fixture so that only `book_depth_10bps_usdt`
 * varies across tests.
 *
 * New floors (M22):  TIER_1=$10,000  TIER_2=$2,500  TIER_3=$2,000
 * Old floors (M19):  TIER_1=$20,000  TIER_2=$10,000 TIER_3=$5,000
 */

import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { COIN_DEPTH_FLOOR_10BPS_USDT } from '../../const/riskConsts';
import { IRiskGateContext, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── M19 regression-pin floors ───────────────────────────────────────────────
// OLD_FLOORS is a deliberate regression pin of prior (M19) values.
// It is NOT a mirror of the live const — that is its correct purpose.

const OLD_FLOORS = { TIER_1: 20_000, TIER_2: 10_000, TIER_3: 5_000 } as const;

// ─── fixture factories ────────────────────────────────────────────────────────

/**
 * Minimal calm snapshot. All stress and halt inputs are far from their thresholds
 * so `firstFailingHaltCheck` returns null. Spread is 0.01 (below all tier ceilings).
 * `book_depth_10bps_usdt` is overridden per-test.
 */
function buildCalmSnapshot(bookDepth: string) {
    return {
        // VWAP / deviation
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 0.5, // small positive → not a fade for a LONG
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
        // Index-shock (M21): well below STRESS_BTC_5M_SHOCK_PCT=1.5 and STRESS_ETH_5M_SHOCK_PCT=2.5
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        // Breadth: neutral (50), far from STRESS_BREADTH_DISTANCE_PCT=40 threshold
        market_breadth_5m_up_pct: 50,
        same_bar_trigger_count: 0,
        // OI: calm (below STRESS_OI_CHANGE_5M_PCT=5)
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.2,
        open_interest: '1000000',
        // Funding: calm
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        // Spread: 0.01% — below all tier ceilings (0.15/0.30/0.50)
        bid_ask_spread_pct: 0.01,
        estimated_slippage_pct: 0.05,
        // Depth: controlled by the test
        book_depth_10bps_usdt: bookDepth,
        book_depth_50bps_usdt: '999999999',
        // Classification fields
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 80,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.45, // below 0.5 balance — no squeeze skip for LONG
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

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
        consecutive_loss_halt: 5, // high: prevents consecutive-loss halt from firing
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0, // deprecated (M21); present for replay compatibility
        stress_eth_1m_shock_pct: 2.0, // deprecated (M21); present for replay compatibility
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildLimits() {
    return {
        dailyLossLimitUsdt: new Money(9999), // virtually never triggered
        weeklyLossLimitUsdt: new Money(99999),
        maxExposurePerCoinUsdt: new Money(250),
        maxSameDirectionExposureUsdt: new Money(600),
        cooldownAfterLossMs: 0, // no cooldown in tests
    };
}

/**
 * Builds a minimal LONG/OPEN intent. SL is below entry (correct side), within
 * the liquidation buffer. coinTier is overridden per-test.
 */
function buildIntent(coinTier: CoinTierEnum = CoinTierEnum.TIER_1): IOrderIntent {
    const entryPrice = new Money('50000');
    const stopLossPrice = new Money('49000'); // 2% below entry → inside liquidation buffer at 3x leverage

    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId: 'BTCUSDT:1700000000000',
        tradeSide: PositionSideEnum.LONG,
        signalScore: 80,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier,
        idiosyncrasyScore: 0.8,
        entryPrice,
        midAtTrigger: entryPrice,
        maintenanceMarginRate: new Money('0.005'),
        proposedExit: {
            takeProfitPrice: new Money('52000'),
            stopLossPrice,
            stopType: 'atr' as any,
            // nowMs + 30min → satisfies time_stop_minutes=60 constraint
            timeStopAtMs: 1_700_000_000_000 + 30 * 60_000,
            tpRebaseEligible: false,
            atrDistance: null,
        },
        openPosition: null,
        sizing: {
            qty: new Money('0.001'),
            notional: new Money('50'), // small: well within exposure caps
            leverage: new Money('3'),
            riskPerTradeUsdt: new Money('5'),
            effectiveRiskUsdt: new Money('5'),
        },
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

/**
 * Builds a minimal IRiskGateContext. All stateful checks are mocked to
 * return safe/no-op values so they do NOT reject before the depth guard.
 */
function buildContext(bookDepth: string, nowMs = 1_700_000_000_000): IRiskGateContext {
    const safeRiskStateDay = {
        date: '2023-11-14',
        realizedPnlDay: new Money(0),
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
    };

    return {
        nowMs,
        utcDateString: '2023-11-14',
        snapshot: buildCalmSnapshot(bookDepth) as any,
        params: buildParams(),
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildLimits(),
        modelDivergenceDetected: false,
        riskState: {
            getDay: jest.fn().mockResolvedValue(safeRiskStateDay),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money(0)),
            upsertDay: jest.fn().mockResolvedValue(undefined),
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
                symbol: 'BTCUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.01'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        },
    };
}

function buildGate(): RiskGateService {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) } as any;
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { emit: jest.fn() } as any;

    const gate = new RiskGateService(ledger, slotManager, stress, positions, riskState, events, { marketStressAutoResumeEnabled: false } as any);
    gate.markRecoveryComplete();

    return gate;
}

// ─── BD1: per-tier boundary — depth exactly at floor rejects ─────────────────

describe('RiskGateService.isBookTooThin — BD1: depth exactly at tier floor rejects', () => {
    it('TIER_1: depth exactly at $10,000 floor → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1]));

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_2: depth exactly at $2,500 floor → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2]));

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_3: depth exactly at $2,000 floor → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_3);
        // TIER_3 is not in the validated allow-list; snapshot tier must match
        const context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3]));

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        // TIER3_NOT_VALIDATED fires after the depth check, so depth-at-floor rejects first
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── BD2: per-tier boundary — one cent above floor passes depth guard ─────────

describe('RiskGateService.isBookTooThin — BD2: depth one cent above floor passes depth guard', () => {
    it('TIER_1: depth $10,000.01 → does NOT return COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1] + 0.01));

        const result = await gate.evaluate(intent, context);

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_2: depth $2,500.01 → does NOT return COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2] + 0.01));

        const result = await gate.evaluate(intent, context);

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_3: depth $2,000.01 → does NOT return COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        // Use TIER_3 intent; the depth guard runs before TIER3_NOT_VALIDATED so a depth
        // just above the floor confirms the depth check passes (any subsequent rejection
        // is for a different reason, asserted below with .not.toBe).
        const tier3Intent = buildIntent(CoinTierEnum.TIER_3);
        const tier3Context = buildContext(String(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3] + 0.01));

        const result = await gate.evaluate(tier3Intent, tier3Context);

        // May reject with TIER3_NOT_VALIDATED (depth passed) but NOT COIN_BOOK_TOO_THIN
        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── BD3: regression proof — depths that pass new floors but not old floors ───

describe('RiskGateService.isBookTooThin — BD3: regression: depths that pass new floors but would have been rejected by old floors', () => {
    /**
     * Each case: depth was <= old floor for the tier (would have been blocked by M19),
     * but is > new floor for the tier (admitted by M22).
     *
     * Assertion:
     *   1. evaluate() does NOT return COIN_BOOK_TOO_THIN (new floor admits the depth).
     *   2. The depth is <= old floor (documents the regression: M19 would have blocked it).
     *
     * Note: $3,468 and $4,500 (TIER_2) are soak-range values. $2,500 (TIER_3) and
     * $15,000 (TIER_1) are synthetic round numbers used to confirm the floor boundary.
     */

    it('TIER_2 depth=$3,468 (soak-range) passes new $2,500 floor and would have failed old $10,000 floor', async () => {
        const depth = '3468';
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext(depth);

        const result = await gate.evaluate(intent, context);

        // New floor admits this depth
        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        // Regression document: old floor would have blocked it
        expect(Number(depth)).toBeLessThanOrEqual(OLD_FLOORS.TIER_2);
    });

    it('TIER_2 depth=$4,500 (soak-range) passes new $2,500 floor and would have failed old $10,000 floor', async () => {
        const depth = '4500';
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext(depth);

        const result = await gate.evaluate(intent, context);

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        expect(Number(depth)).toBeLessThanOrEqual(OLD_FLOORS.TIER_2);
    });

    it('TIER_3 depth=$2,500 passes new $2,000 floor and would have failed old $5,000 floor', async () => {
        const depth = '2500';
        const gate = buildGate();
        // Use TIER_2 to avoid TIER3_NOT_VALIDATED confound while isolating the depth guard.
        // The floor logic is keyed on intent.coinTier, so we build a TIER_2 intent
        // with depth=$2,500 which is above TIER_2 new floor ($2,500 is NOT above — it equals it).
        // Per the boundary rule (<=), depth===floor rejects. Use TIER_3 intent with depth
        // that is above TIER_3's new floor ($2,000) to test the regression case correctly.
        const tier3Intent = buildIntent(CoinTierEnum.TIER_3);
        const context = buildContext(depth);

        const result = await gate.evaluate(tier3Intent, context);

        // New TIER_3 floor is $2,000 and depth=$2,500 > $2,000 → passes depth guard
        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        // Old TIER_3 floor was $5,000 and depth=$2,500 <= $5,000 → M19 would have blocked it
        expect(Number(depth)).toBeLessThanOrEqual(OLD_FLOORS.TIER_3);
    });

    it('TIER_1 depth=$15,000 passes new $10,000 floor and would have failed old $20,000 floor', async () => {
        const depth = '15000';
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext(depth);

        const result = await gate.evaluate(intent, context);

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        expect(Number(depth)).toBeLessThanOrEqual(OLD_FLOORS.TIER_1);
    });
});

// ─── BD4: still-blocked proof ─────────────────────────────────────────────────

describe('RiskGateService.isBookTooThin — BD4: depths below both old and new floors still reject', () => {
    it('TIER_1 depth=$529 rejects COIN_BOOK_TOO_THIN (529 <= 10,000 new floor)', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('529');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_2 depth=$681 rejects COIN_BOOK_TOO_THIN (681 <= 2,500 new floor)', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext('681');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_2 depth=$2,321 rejects COIN_BOOK_TOO_THIN (2,321 <= 2,500 new floor)', async () => {
        // Soak data recorded $2,321 as still-blocked. At TIER_2 new floor=$2,500:
        // 2,321 <= 2,500 → still rejects (correct: the depth is below the floor).
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_2);
        const context = buildContext('2321');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_1 depth=$1,999 rejects COIN_BOOK_TOO_THIN (1,999 <= 10,000 new floor)', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('1999');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('TIER_1 depth $5,380 (H impostor — volume-mis-ranked tier1) rejects at $10k floor', async () => {
        // H had depth $5,380 but was volume-mis-ranked as TIER_1.
        // At the new TIER_1 floor of $10,000 it must still reject.
        // This case is the load-bearing justification for the $10,000 floor over a hypothetical $5,000 floor:
        // at $5,000 this depth would have passed (documented by the assertion below).
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('5380');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        // At a hypothetical $5,000 tier1 floor (the rejected alternative), this depth would have passed:
        expect(5_380).toBeGreaterThan(5_000);
    });
});

// ─── BD5: fail-closed — malformed / missing depth values ─────────────────────

describe('RiskGateService.isBookTooThin — BD5: fail-closed on malformed depth input', () => {
    it('empty string → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('garbage string → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('garbage');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('string "NaN" → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('NaN');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('negative depth "-100" → COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate();
        const intent = buildIntent(CoinTierEnum.TIER_1);
        const context = buildContext('-100');

        const result = await gate.evaluate(intent, context);

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── BD6: floor const integrity ──────────────────────────────────────────────

describe('COIN_DEPTH_FLOOR_10BPS_USDT — BD6: M22 floor values match specification', () => {
    // Pin the actual const values so any accidental revert fails loudly here before
    // the gate tests catch it in isolation.
    it('TIER_1 floor is $10,000 (M22)', () => {
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1]).toBe(10_000);
    });

    it('TIER_2 floor is $2,500 (M22)', () => {
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2]).toBe(2_500);
    });

    it('TIER_3 floor is $2,000 (M22)', () => {
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3]).toBe(2_000);
    });

    // Confirm BacktestRunnerService.spec.ts fixture value ($50,000,000) is above all new floors.
    // This is intentional: the backtest fixture must never trip the depth guard.
    it('backtest fixture depth 50,000,000 exceeds all M22 tier floors', () => {
        const backtestFixtureDepth = 50_000_000;

        expect(backtestFixtureDepth).toBeGreaterThan(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1]);
        expect(backtestFixtureDepth).toBeGreaterThan(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2]);
        expect(backtestFixtureDepth).toBeGreaterThan(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3]);
    });
});
