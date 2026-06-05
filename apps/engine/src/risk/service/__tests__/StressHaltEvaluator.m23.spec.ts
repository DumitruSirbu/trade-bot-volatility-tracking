/**
 * StressHaltEvaluator — M23 new methods: classifyHaltLeg + isGlobalStressed
 *
 * Surfaces under test:
 *   CL1 — classifyHaltLeg: single-leg engage returns canonical suffix
 *   CL2 — classifyHaltLeg: NaN in any input returns 'invalid' (checked first, before leg enumeration)
 *   CL3 — classifyHaltLeg: two or more legs engage → 'multi'
 *   CL4 — classifyHaltLeg: all legs engage → 'multi' (not 'invalid' — valid inputs, just many legs)
 *   GS1 — isGlobalStressed: breadth values in outer band (|b-50| > 30) → true
 *   GS2 — isGlobalStressed: breadth values exactly at or inside inner band (|b-50| <= 30) → false
 *   GS3 — isGlobalStressed: NaN/Infinity in any guarded field → true (fail-closed)
 *
 * Only `breadth` is resume-eligible. Every other suffix (btc_shock, eth_shock, oi, funding,
 * spread, same_bar, multi, invalid) keeps the full-day lock.
 */

import { IMarketSnapshot, IStrategyParams } from '@bot/shared';

import {
    MARKET_BREADTH_NEUTRAL_PCT,
    MARKET_STRESS_RESUME_BREADTH_DISTANCE,
    MARKET_STRESS_RESUME_ELIGIBLE_LEG,
    STRESS_BREADTH_DISTANCE_PCT,
} from '../../const/riskConsts';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── snapshot factories ───────────────────────────────────────────────────────

/**
 * Builds a calm snapshot where no stress leg is engaged. Every field is set to
 * a value clearly below its threshold so only the overridden field(s) can trigger.
 */
function buildCalmSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
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
        // Index-shock: well below STRESS_BTC_5M_SHOCK_PCT=1.5 / STRESS_ETH_5M_SHOCK_PCT=2.5
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        // Breadth: neutral (50), far from STRESS_BREADTH_DISTANCE_PCT=40
        market_breadth_5m_up_pct: 50,
        same_bar_trigger_count: 0,
        // OI: calm (below STRESS_OI_CHANGE_5M_PCT=5)
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.2,
        open_interest: '1000000',
        // Funding: calm (below STRESS_FUNDING_ANNUALIZED_PCT=50)
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        // Spread: calm (below STRESS_SPREAD_PCT=0.6)
        bid_ask_spread_pct: 0.01,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: '50000000',
        book_depth_50bps_usdt: '999999999',
        coin_tier: 'TIER_1' as any,
        coin_volume_rank: 1,
        correlation_mode: 'IDIOSYNCRATIC' as any,
        signal_score: 80,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 100,
        flow_type: 'FORCED_EXHAUSTION' as any,
        ...overrides,
    } as IMarketSnapshot;
}

/**
 * Builds params where same_bar_trigger_count threshold is very high so it never
 * fires unless the snapshot.same_bar_trigger_count is explicitly set above this value.
 */
function buildParams(overrides: Partial<IStrategyParams> = {}): IStrategyParams {
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
        consecutive_loss_halt: 5,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        // High threshold: only fires when same_bar_trigger_count is set to exactly 100+ in test
        stress_same_bar_trigger_count: 100,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
        ...overrides,
    } as IStrategyParams;
}

function buildEvaluator(): StressHaltEvaluator {
    return new StressHaltEvaluator();
}

// ─── CL1: classifyHaltLeg — single-leg engage ─────────────────────────────────

describe('StressHaltEvaluator.classifyHaltLeg — CL1: single-leg sole engage returns canonical suffix', () => {
    it('breadth sole-engage (breadth=8%, |8-50|=42 >= 40) → returns "breadth"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 8 });
        const params = buildParams();

        const result = evaluator.classifyHaltLeg(snapshot, params);

        expect(result).toBe(MARKET_STRESS_RESUME_ELIGIBLE_LEG);
        expect(result).toBe('breadth');
    });

    it('BTC shock sole-engage (btc_5m=2.0%, >= STRESS_BTC_5M_SHOCK_PCT=1.5) → returns "btc_shock"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: 2.0 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('btc_shock');
    });

    it('ETH shock sole-engage (eth_5m=3.0%, >= STRESS_ETH_5M_SHOCK_PCT=2.5) → returns "eth_shock"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ eth_5m_move_pct: 3.0 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('eth_shock');
    });

    it('OI sole-engage (oi_change_5m=6%, >= STRESS_OI_CHANGE_5M_PCT=5) → returns "oi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ open_interest_change_5m_pct: 6 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('oi');
    });

    it('funding sole-engage (funding_rate_annualized=60%, >= STRESS_FUNDING_ANNUALIZED_PCT=50) → returns "funding"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ funding_rate_annualized: 60 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('funding');
    });

    it('spread sole-engage (bid_ask_spread_pct=0.7%, >= STRESS_SPREAD_PCT=0.6) → returns "spread"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ bid_ask_spread_pct: 0.7 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('spread');
    });

    it('same_bar sole-engage (same_bar_trigger_count=5, threshold=5) → returns "same_bar"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 5 });
        const params = buildParams({ stress_same_bar_trigger_count: 5 });

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('same_bar');
    });
});

// ─── CL2: classifyHaltLeg — NaN short-circuits to 'invalid' ──────────────────

describe('StressHaltEvaluator.classifyHaltLeg — CL2: NaN in any stress input returns "invalid" before other legs are evaluated', () => {
    it('NaN btc_5m_move_pct → "invalid"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: NaN });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('invalid');
    });

    it('NaN eth_5m_move_pct → "invalid"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ eth_5m_move_pct: NaN });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('invalid');
    });

    it('NaN market_breadth_5m_up_pct → "invalid"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: NaN });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('invalid');
    });

    it('NaN funding_rate_annualized → "invalid"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ funding_rate_annualized: NaN });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('invalid');
    });

    it('Infinity bid_ask_spread_pct → "invalid"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ bid_ask_spread_pct: Infinity });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('invalid');
    });
});

// ─── CL3: classifyHaltLeg — multi-leg engage ─────────────────────────────────

describe('StressHaltEvaluator.classifyHaltLeg — CL3: two or more legs engage → "multi"', () => {
    it('breadth + BTC shock both engage → "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8, // |8-50|=42 >= 40 → breadth
            btc_5m_move_pct: 2.0, // 2.0 >= 1.5 → btc_shock
        });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('multi');
    });

    it('breadth + OI both engage → "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8, // breadth collapse
            open_interest_change_5m_pct: 6, // OI shock
        });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('multi');
    });

    it('BTC shock + ETH shock both engage → "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            btc_5m_move_pct: 2.0,
            eth_5m_move_pct: 3.0,
        });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('multi');
    });

    it('OI + funding both engage → "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            open_interest_change_5m_pct: 6,
            funding_rate_annualized: 60,
        });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(snapshot, params)).toBe('multi');
    });
});

// ─── CL4: classifyHaltLeg — all legs engage → still 'multi' ─────────────────

describe('StressHaltEvaluator.classifyHaltLeg — CL4: all legs engage simultaneously → "multi" (not "invalid" — inputs are finite)', () => {
    it('all finite legs engaged at once → "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            btc_5m_move_pct: 2.0,
            eth_5m_move_pct: 3.0,
            market_breadth_5m_up_pct: 8,
            same_bar_trigger_count: 5,
            open_interest_change_5m_pct: 6,
            funding_rate_annualized: 60,
            bid_ask_spread_pct: 0.7,
        });
        const params = buildParams({ stress_same_bar_trigger_count: 5 });

        const result = evaluator.classifyHaltLeg(snapshot, params);

        // All inputs are finite (NaN check passes), but 7 legs fire → multi, not invalid
        expect(result).toBe('multi');
        expect(result).not.toBe('invalid');
    });
});

// ─── GS1: isGlobalStressed — outer-band breadth → stressed ───────────────────

describe('StressHaltEvaluator.isGlobalStressed — GS1: outer-band breadth (|b-50| > 30) returns true', () => {
    it('breadth=8% (|8-50|=42 > 30) → true (collapse zone)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 8 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('breadth=15% (|15-50|=35 > 30) → true (gap zone (10,20): below engage threshold but above resume threshold)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 15 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('breadth=85% (|85-50|=35 > 30) → true (gap zone (80,90) on the surge side)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 85 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('breadth=92% (|92-50|=42 > 30) → true (surge zone)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 92 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    // Verify engage boundary is still stress=true; resume boundary is different
    it('breadth=11% (|11-50|=39 > 30) → true (outer gap, resume counter must NOT advance)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 11 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('breadth=19% (|19-50|=31 > 30) → true (just outside inner band)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 19 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('breadth=81% (|81-50|=31 > 30) → true (just outside inner band, upper side)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 81 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });
});

// ─── GS2: isGlobalStressed — inner-band breadth → not stressed ───────────────

describe('StressHaltEvaluator.isGlobalStressed — GS2: inner-band breadth (|b-50| <= 30) returns false', () => {
    it('breadth=20% (|20-50|=30, NOT > 30) → false (exactly at inner band lower boundary)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 20 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });

    it('breadth=50% (balanced, |50-50|=0) → false', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 50 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });

    it('breadth=80% (|80-50|=30, NOT > 30) → false (exactly at inner band upper boundary)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 80 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });

    it('breadth=45% (|45-50|=5 <= 30) → false (well inside inner band)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 45 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });

    it('breadth=30% (|30-50|=20 <= 30) → false', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 30 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });
});

// ─── GS3: isGlobalStressed — NaN/Infinity fail-closed ────────────────────────

describe('StressHaltEvaluator.isGlobalStressed — GS3: NaN or Infinity in any guarded field returns true (fail-closed)', () => {
    it('NaN market_breadth_5m_up_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: NaN });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('Infinity market_breadth_5m_up_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: Infinity });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('NaN btc_5m_move_pct → true (fail-closed even when breadth is clean)', () => {
        const evaluator = buildEvaluator();
        // breadth=50 is clean, but btc field is NaN
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 50, btc_5m_move_pct: NaN });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('NaN eth_5m_move_pct → true (fail-closed even when breadth is clean)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 50, eth_5m_move_pct: NaN });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });

    it('-Infinity btc_5m_move_pct → true (fail-closed)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: -Infinity });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(true);
    });
});

// ─── Verify exported constant ─────────────────────────────────────────────────

describe('MARKET_STRESS_RESUME_ELIGIBLE_LEG — exported constant matches the breadth suffix', () => {
    it('MARKET_STRESS_RESUME_ELIGIBLE_LEG equals "breadth"', () => {
        expect(MARKET_STRESS_RESUME_ELIGIBLE_LEG).toBe('breadth');
    });

    it('isGlobalStressed(clean snapshot) + classifyHaltLeg(sole breadth) = resume-eligible leg matches exported constant', () => {
        const evaluator = buildEvaluator();
        const breadthOnlyStressed = buildCalmSnapshot({ market_breadth_5m_up_pct: 8 });
        const calmSnapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 45 });
        const params = buildParams();

        expect(evaluator.classifyHaltLeg(breadthOnlyStressed, params)).toBe(MARKET_STRESS_RESUME_ELIGIBLE_LEG);
        expect(evaluator.isGlobalStressed(calmSnapshot)).toBe(false);
    });
});

// ─── Verify resume distance constant ─────────────────────────────────────────

describe('MARKET_STRESS_RESUME_BREADTH_DISTANCE constant', () => {
    it('MARKET_STRESS_RESUME_BREADTH_DISTANCE is 30 — the inner hysteresis band distance', () => {
        expect(MARKET_STRESS_RESUME_BREADTH_DISTANCE).toBe(30);
    });

    it('isGlobalStressed uses strict > at 30 (not >= engage at 40): breadth at exactly 20 is clean', () => {
        const evaluator = buildEvaluator();
        // |20 - 50| = 30, which is NOT > 30 → not globally stressed → clean tick counts toward resume
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 20 });

        expect(evaluator.isGlobalStressed(snapshot)).toBe(false);
    });

    it('engage threshold (STRESS_BREADTH_DISTANCE_PCT=40) is wider than resume threshold (30): a gap exists in (10,20)', () => {
        // This verifies the intentional hysteresis gap: engage fires at |b-50| >= 40,
        // resume requires |b-50| <= 30. The region (10,20) is in the gap.
        expect(STRESS_BREADTH_DISTANCE_PCT).toBe(40);
        expect(MARKET_STRESS_RESUME_BREADTH_DISTANCE).toBe(30);
        expect(MARKET_STRESS_RESUME_BREADTH_DISTANCE).toBeLessThan(STRESS_BREADTH_DISTANCE_PCT);
    });

    it('MARKET_BREADTH_NEUTRAL_PCT is 50 — the reference midpoint for both engage and resume', () => {
        expect(MARKET_BREADTH_NEUTRAL_PCT).toBe(50);
    });
});
