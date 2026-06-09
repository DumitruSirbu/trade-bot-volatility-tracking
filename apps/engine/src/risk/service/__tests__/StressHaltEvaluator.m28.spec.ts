/**
 * StressHaltEvaluator — M28 new method: isSameBarStillStressed
 *
 * Surfaces under test:
 *   SS1  — Clean at count=11 (< STRESS_SAME_BAR_RESUME_COUNT=12 → false)
 *   SS2  — Still-stressed at count=12 (>= 12 → true, exact lower boundary of hysteresis)
 *   SS3  — Still-stressed at count=20 (= STRESS_SAME_BAR_HALT_COUNT → predicate still true inside hysteresis)
 *   SS4  — NaN same_bar_trigger_count alone → true (fail-closed)
 *   SS5  — Infinity same_bar_trigger_count → true (fail-closed)
 *   SS6  — Multi-scalar malformed: clean same_bar (count=1) + NaN in another stress scalar → true
 *   SS7  — Hysteresis: count=15 (between resume-12 and engage-20) → true (not clean)
 *   SS8  — Engage decoupling regression lock: count=10 with strategy param=5 does NOT engage same_bar leg
 */

import { IMarketSnapshot, IStrategyParams } from '@bot/shared';

import { STRESS_SAME_BAR_HALT_COUNT, STRESS_SAME_BAR_RESUME_COUNT } from '../../const/riskConsts';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// Soak cascade peak observed on 2026-06-07 (same_bar_trigger_count), well above the engage
// threshold (STRESS_SAME_BAR_HALT_COUNT=20) — the calibration anchor for the upper-bound test.
const SAME_BAR_CASCADE_PEAK_JUN7 = 52;

// ─── snapshot / param factories ──────────────────────────────────────────────

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
        // Index-shock: calm — well below thresholds
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        // Breadth: neutral — far from engage threshold
        market_breadth_5m_up_pct: 50,
        same_bar_trigger_count: 0,
        // OI: calm
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.2,
        open_interest: '1000000',
        // Funding: calm
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        // Spread: calm
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
        // Low param — used only for classifyFlowType, NOT for the halt threshold
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
        ...overrides,
    } as IStrategyParams;
}

function buildEvaluator(): StressHaltEvaluator {
    return new StressHaltEvaluator();
}

// ─── SS1: clean at count=11 (strictly below resume threshold) ─────────────────

describe('StressHaltEvaluator.isSameBarStillStressed — SS1: count=11 (< STRESS_SAME_BAR_RESUME_COUNT=12) → false', () => {
    it('same_bar_trigger_count=11 is below the resume threshold → not still stressed', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_RESUME_COUNT - 1 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(false);
    });

    it('same_bar_trigger_count=0 → false (far below resume threshold)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 0 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(false);
    });

    it('same_bar_trigger_count=1 → false', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(false);
    });
});

// ─── SS2: still-stressed at count=12 (exact lower boundary of hysteresis) ────

describe('StressHaltEvaluator.isSameBarStillStressed — SS2: count=12 (= STRESS_SAME_BAR_RESUME_COUNT) → true', () => {
    it('same_bar_trigger_count=12 (exactly at resume boundary) → still stressed', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_RESUME_COUNT });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });
});

// ─── SS3: still-stressed at count=20 (engage value, inside hysteresis band) ──

describe('StressHaltEvaluator.isSameBarStillStressed — SS3: count=20 (= STRESS_SAME_BAR_HALT_COUNT) → true', () => {
    it('same_bar_trigger_count=20 (engage value) → still stressed (predicate correct inside hysteresis)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('same_bar_trigger_count > STRESS_SAME_BAR_HALT_COUNT (cascade spike=52) → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CASCADE_PEAK_JUN7 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });
});

// ─── SS4/SS5: NaN / Infinity fail-closed ─────────────────────────────────────

describe('StressHaltEvaluator.isSameBarStillStressed — SS4/SS5: NaN or Infinity in same_bar_trigger_count → true (fail-closed)', () => {
    it('NaN same_bar_trigger_count → true (fail-closed)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('Infinity same_bar_trigger_count → true (fail-closed)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: Infinity });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('-Infinity same_bar_trigger_count → true (fail-closed)', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: -Infinity });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });
});

// ─── SS6: multi-scalar malformed — NaN in non-same_bar scalar → still stressed ──

describe('StressHaltEvaluator.isSameBarStillStressed — SS6: clean same_bar count + NaN in another stress scalar → true (multi-scalar fail-closed)', () => {
    // same_bar_trigger_count=1 is below the resume threshold (1 < 12) — clean alone.
    // But hasInvalidStressInputs covers the full scalar list, so a NaN in any
    // other scalar causes the method to return true (fail-closed).

    it('count=1 + NaN btc_5m_move_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, btc_5m_move_pct: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=1 + NaN eth_5m_move_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, eth_5m_move_pct: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=1 + NaN market_breadth_5m_up_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, market_breadth_5m_up_pct: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=1 + NaN open_interest_change_5m_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, open_interest_change_5m_pct: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=1 + NaN funding_rate_annualized → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, funding_rate_annualized: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=1 + NaN bid_ask_spread_pct → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 1, bid_ask_spread_pct: NaN });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });
});

// ─── SS7: hysteresis — count in (12, 20) gap → still stressed ─────────────────

describe('StressHaltEvaluator.isSameBarStillStressed — SS7: count in hysteresis gap (>= 12, < 20) → true (does not count as clean)', () => {
    it('count=15 (inside hysteresis band between resume=12 and engage=20) → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 15 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=13 (just above resume threshold) → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 13 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });

    it('count=19 (just below engage threshold) → true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 19 });

        expect(evaluator.isSameBarStillStressed(snapshot)).toBe(true);
    });
});

// ─── SS8: engage decoupling regression lock ───────────────────────────────────

describe('StressHaltEvaluator — SS8: same_bar engage decoupling (M28 regression lock)', () => {
    // CRITICAL: same_bar leg engages on STRESS_SAME_BAR_HALT_COUNT (engine const=20),
    // NOT on params.stress_same_bar_trigger_count (=5). A count of 10 with param=5 must
    // NOT engage the same_bar leg. This prevents a re-coupling regression.

    it('count=10, params.stress_same_bar_trigger_count=5 → same_bar does NOT appear in activeStressLegs (isStressed=false)', () => {
        const evaluator = buildEvaluator();
        // count=10 is above the param value (5) but below the engine const (20)
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: 10 });
        const params = buildParams({ stress_same_bar_trigger_count: 5 });

        // isStressed false means same_bar leg did NOT engage (other legs calm)
        expect(evaluator.isStressed(snapshot, params, false)).toBe(false);
    });

    it('count=10, params.stress_same_bar_trigger_count=5 → classifyHaltLeg does NOT return "same_bar"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            same_bar_trigger_count: 10,
            market_breadth_5m_up_pct: 8, // breadth is stressed so classifyHaltLeg has something to return
        });
        const params = buildParams({ stress_same_bar_trigger_count: 5 });

        // breadth is the only active leg; same_bar at count=10 must NOT contribute
        expect(evaluator.classifyHaltLeg(snapshot, params, false)).toBe('breadth');
    });

    it('count=20 (= STRESS_SAME_BAR_HALT_COUNT, const threshold) → same_bar DOES engage', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT });
        const params = buildParams({ stress_same_bar_trigger_count: 5 });

        expect(evaluator.isStressed(snapshot, params, false)).toBe(true);
        expect(evaluator.classifyHaltLeg(snapshot, params, false)).toBe('same_bar');
    });
});

// ─── Verify constants ─────────────────────────────────────────────────────────

describe('M28 riskConsts — STRESS_SAME_BAR_HALT_COUNT / STRESS_SAME_BAR_RESUME_COUNT values', () => {
    it('STRESS_SAME_BAR_HALT_COUNT is 20', () => {
        expect(STRESS_SAME_BAR_HALT_COUNT).toBe(20);
    });

    it('STRESS_SAME_BAR_RESUME_COUNT is 12', () => {
        expect(STRESS_SAME_BAR_RESUME_COUNT).toBe(12);
    });

    it('resume threshold is strictly less than engage threshold (hysteresis gap exists)', () => {
        expect(STRESS_SAME_BAR_RESUME_COUNT).toBeLessThan(STRESS_SAME_BAR_HALT_COUNT);
    });
});
