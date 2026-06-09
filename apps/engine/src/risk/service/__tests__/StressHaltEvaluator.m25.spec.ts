/**
 * StressHaltEvaluator — M25 paper exploration profile (ADR 0042 §2)
 *
 * Surfaces under test (all via the public isStressed / classifyHaltLeg API):
 *
 *   PR1  — P2 relax ON: BTC shock → not stressed (skipped)
 *   PR2  — P2 relax ON: ETH shock → not stressed (skipped)
 *   PR3  — P2 relax ON: OI shock → not stressed (skipped)
 *   PR4  — P2 relax ON: funding extreme → not stressed (skipped)
 *   PR5  — P2 relax ON: spread blowout → not stressed (skipped)
 *   PR6  — P2 relax ON: breadth engage → STILL stressed (breadth is never relaxed)
 *   PR7  — P2 relax ON: same_bar engage → STILL stressed (governed by strategy param, not the flag)
 *   PR8  — P2 relax ON: hasInvalidStressInputs → STILL fail-closed (NaN/Infinity halts regardless)
 *
 *   VC1  — Verdict / suffix consistency: breadth + BTC (paperRelax=true) → isStressed true,
 *           classifyHaltLeg returns "breadth" (BTC dropped) — NOT "multi" — keeps M23 resume-eligible
 *   VC2  — Verdict / suffix consistency: BTC + ETH (paperRelax=true) → both relaxed → isStressed false
 *   VC3  — Verdict / suffix consistency: breadth + BTC (paperRelax=false) → isStressed true, classifyHaltLeg "multi"
 *
 *   RG1  — Regression guard OFF: fixture table of all leg combinations with paperRelax=false
 *           produces identical results to pre-M25 (live / testnet / backtest byte-identical)
 *
 *   MD1  — multi derivation: 2+ active legs → "multi"; 1 active leg → specific leg name
 */

import { IMarketSnapshot, IStrategyParams } from '@bot/shared';

import {
    HALT_LEG_BTC_SHOCK,
    HALT_LEG_ETH_SHOCK,
    HALT_LEG_MULTI,
    HALT_LEG_BREADTH,
    HALT_LEG_SAME_BAR,
    HALT_LEG_OI,
    HALT_LEG_FUNDING,
    HALT_LEG_SPREAD,
    HALT_LEG_INVALID,
    STRESS_BTC_5M_SHOCK_PCT,
    STRESS_ETH_5M_SHOCK_PCT,
    STRESS_OI_CHANGE_5M_PCT,
    STRESS_FUNDING_ANNUALIZED_PCT,
    STRESS_SPREAD_PCT,
    MARKET_BREADTH_NEUTRAL_PCT,
    STRESS_SAME_BAR_HALT_COUNT,
} from '../../const';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── snapshot / param factories ──────────────────────────────────────────────

/**
 * Calm snapshot: every stress field is well below its threshold.
 * Override only the fields under test so each case is independent.
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
        // Index-shock: calm — well below thresholds
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        // Breadth: neutral (50), far from STRESS_BREADTH_DISTANCE_PCT=40
        market_breadth_5m_up_pct: MARKET_BREADTH_NEUTRAL_PCT,
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

/**
 * Calm params: same_bar threshold set very high so it never fires unless the
 * snapshot.same_bar_trigger_count is explicitly set at or above this value.
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
        // Very high: only fires when same_bar_trigger_count is set to 100+ in a test
        stress_same_bar_trigger_count: 100,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
        ...overrides,
    } as IStrategyParams;
}

function buildEvaluator(): StressHaltEvaluator {
    return new StressHaltEvaluator();
}

// ─── PR1–PR5: P2 relax ON — relaxed legs are skipped ─────────────────────────

describe('StressHaltEvaluator M25 — PR1–PR5: P2 relax ON skips non-breadth legs', () => {
    it('PR1 — BTC shock above threshold → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });

    it('PR2 — ETH shock above threshold → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT + 0.5 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });

    it('PR3 — OI shock above threshold → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT + 1 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });

    it('PR4 — funding extreme above threshold → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ funding_rate_annualized: STRESS_FUNDING_ANNUALIZED_PCT + 10 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });

    it('PR5 — spread above threshold → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ bid_ask_spread_pct: STRESS_SPREAD_PCT + 0.1 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });
});

// ─── PR6: P2 relax ON — breadth is NEVER relaxed ─────────────────────────────

describe('StressHaltEvaluator M25 — PR6: breadth engage is NEVER relaxed by paperRelax=true', () => {
    it('breadth at engage threshold (|breadth-50|=40) → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        // breadth=10: |10-50|=40 >= STRESS_BREADTH_DISTANCE_PCT=40 → engage
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 10 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('breadth surge (breadth=90, |90-50|=40) → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 90 });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('breadth just below engage threshold (|breadth-50|=35) → NOT stressed with paperRelax=true', () => {
        // Confirms the engage boundary; 35 < 40 → should not engage
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 15 }); // |15-50|=35

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });
});

// ─── PR7: P2 relax ON — same_bar governed by strategy param only ──────────────

describe('StressHaltEvaluator M25 — PR7: same_bar_trigger_count governed by engine const (M28), not paperRelax flag', () => {
    it('same_bar_trigger_count at STRESS_SAME_BAR_HALT_COUNT → STILL stressed when paperRelax=true (paperRelax never relaxes same_bar)', () => {
        // M28: halt threshold is STRESS_SAME_BAR_HALT_COUNT (20), not the strategy param.
        // paperRelax=true still does NOT relax same_bar — it is not in PAPER_RELAXABLE_LEGS.
        const evaluator = buildEvaluator();
        const params = buildParams({ stress_same_bar_trigger_count: 5 }); // param stays 5 for classifyFlowType only
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT });

        expect(evaluator.isStressed(snapshot, params, true)).toBe(true);
    });

    it('same_bar_trigger_count below STRESS_SAME_BAR_HALT_COUNT → not stressed (threshold correctly raised from 5 to 20)', () => {
        const evaluator = buildEvaluator();
        const params = buildParams({ stress_same_bar_trigger_count: 5 });
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT - 1 });

        expect(evaluator.isStressed(snapshot, params, true)).toBe(false);
    });
});

// ─── PR8: P2 relax ON — hasInvalidStressInputs is NEVER relaxed ──────────────

describe('StressHaltEvaluator M25 — PR8: invalid inputs fail-closed regardless of paperRelax', () => {
    it('NaN in btc_5m_move_pct → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: NaN });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('Infinity in eth_5m_move_pct → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ eth_5m_move_pct: Infinity });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('NaN in funding_rate_annualized → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ funding_rate_annualized: NaN });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('NaN in bid_ask_spread_pct → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ bid_ask_spread_pct: NaN });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('NaN in market_breadth_5m_up_pct → stressed=true even when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: NaN });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('invalid inputs → classifyHaltLeg returns "invalid" regardless of paperRelax', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: NaN });

        expect(evaluator.classifyHaltLeg(snapshot, buildParams(), true)).toBe(HALT_LEG_INVALID);
    });
});

// ─── VC1: verdict / suffix consistency — breadth + BTC with relax ON ─────────

describe('StressHaltEvaluator M25 — VC1: breadth+BTC with paperRelax=true → breadth sole active leg (resume-eligible)', () => {
    it('isStressed returns true (breadth alone is enough to halt)', () => {
        // ADR 0042 §2 worked example: BTC is relaxed, breadth is not.
        // breadth=8: |8-50|=42 >= 40 → breadth engages; BTC shock skipped
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
        });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
    });

    it('classifyHaltLeg returns "breadth" (not "multi") — BTC relaxed, so only one active leg', () => {
        // With BTC relaxed, only breadth is active → single-leg → "breadth", not "multi".
        // This keeps the halt_reason resume-eligible under M23 (market_stress:breadth).
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
        });

        const leg = evaluator.classifyHaltLeg(snapshot, buildParams(), true);

        expect(leg).toBe(HALT_LEG_BREADTH);
        expect(leg).not.toBe(HALT_LEG_MULTI);
    });
});

// ─── VC2: BTC + ETH both relaxed → not stressed ───────────────────────────────

describe('StressHaltEvaluator M25 — VC2: BTC+ETH both relaxed → isStressed false when paperRelax=true', () => {
    it('BTC shock + ETH shock both above thresholds → NOT stressed when paperRelax=true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
            eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT + 0.5,
        });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(false);
    });
});

// ─── VC3: breadth + BTC with relax OFF → multi ────────────────────────────────

describe('StressHaltEvaluator M25 — VC3: breadth+BTC with paperRelax=false → "multi" (pre-M25 behavior)', () => {
    it('isStressed returns true', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
        });

        expect(evaluator.isStressed(snapshot, buildParams(), false)).toBe(true);
    });

    it('classifyHaltLeg returns "multi" — both legs active when BTC is not relaxed', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
        });

        expect(evaluator.classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_MULTI);
    });
});

// ─── RG1: regression guard — paperRelax=false is byte-identical to pre-M25 ───

describe('StressHaltEvaluator M25 — RG1: paperRelax=false produces identical results to pre-M25 (live/testnet/backtest guard)', () => {
    it('calm snapshot → not stressed (baseline unchanged)', () => {
        expect(buildEvaluator().isStressed(buildCalmSnapshot(), buildParams(), false)).toBe(false);
    });

    it('BTC shock alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_BTC_SHOCK);
    });

    it('ETH shock alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_ETH_SHOCK);
    });

    it('breadth collapse alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ market_breadth_5m_up_pct: 8 });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_BREADTH);
    });

    it('OI shock alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_OI);
    });

    it('funding extreme alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ funding_rate_annualized: STRESS_FUNDING_ANNUALIZED_PCT });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_FUNDING);
    });

    it('spread blowout alone → stressed', () => {
        const snapshot = buildCalmSnapshot({ bid_ask_spread_pct: STRESS_SPREAD_PCT });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_SPREAD);
    });

    it('same_bar at STRESS_SAME_BAR_HALT_COUNT alone → stressed (M28: const-governed)', () => {
        const params = buildParams({ stress_same_bar_trigger_count: 5 }); // param no longer governs halt
        const snapshot = buildCalmSnapshot({ same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT });

        expect(buildEvaluator().isStressed(snapshot, params, false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, params, false)).toBe(HALT_LEG_SAME_BAR);
    });

    it('BTC + ETH combined → multi', () => {
        const snapshot = buildCalmSnapshot({
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT,
            eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT,
        });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_MULTI);
    });

    it('breadth + OI combined → multi', () => {
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT,
        });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_MULTI);
    });

    it('NaN in any input → stressed and classifies as "invalid" (fail-closed)', () => {
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: NaN });

        expect(buildEvaluator().isStressed(snapshot, buildParams(), false)).toBe(true);
        expect(buildEvaluator().classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_INVALID);
    });
});

// ─── MD1: multi derivation ────────────────────────────────────────────────────

describe('StressHaltEvaluator M25 — MD1: multi derivation under paper relax', () => {
    it('two legs still active with paperRelax=true (breadth + same_bar) → "multi"', () => {
        // breadth and same_bar are both NOT in the relaxable set.
        // When both engage simultaneously, the result is "multi".
        // M28: same_bar engage threshold is STRESS_SAME_BAR_HALT_COUNT (20), not the param.
        const evaluator = buildEvaluator();
        const params = buildParams({ stress_same_bar_trigger_count: 5 }); // param stays 5 (classifyFlowType only)
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8, // breadth engage
            same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT, // same_bar engage at const (20)
        });

        expect(evaluator.isStressed(snapshot, params, true)).toBe(true);
        expect(evaluator.classifyHaltLeg(snapshot, params, true)).toBe(HALT_LEG_MULTI);
    });

    it('only one active leg (OI relaxed by paperRelax; breadth not) → "breadth" not "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT + 1, // OI above threshold but relaxed
        });

        expect(evaluator.classifyHaltLeg(snapshot, buildParams(), true)).toBe(HALT_LEG_BREADTH);
    });

    it('one leg only (single BTC, paperRelax=false) → "btc_shock" not "multi"', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({ btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5 });

        expect(evaluator.classifyHaltLeg(snapshot, buildParams(), false)).toBe(HALT_LEG_BTC_SHOCK);
    });

    it('all non-breadth legs relaxed (paperRelax=true) plus breadth engaging → single "breadth" leg', () => {
        const evaluator = buildEvaluator();
        const snapshot = buildCalmSnapshot({
            market_breadth_5m_up_pct: 8,
            btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT + 0.5,
            eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT + 0.5,
            open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT + 1,
            funding_rate_annualized: STRESS_FUNDING_ANNUALIZED_PCT + 10,
            bid_ask_spread_pct: STRESS_SPREAD_PCT + 0.1,
        });

        expect(evaluator.isStressed(snapshot, buildParams(), true)).toBe(true);
        expect(evaluator.classifyHaltLeg(snapshot, buildParams(), true)).toBe(HALT_LEG_BREADTH);
    });
});
