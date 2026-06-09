/**
 * StressHaltEvaluator — market-stress halt overrides ADX.
 *
 * Verifies each stress trigger independently, the override-ADX invariant,
 * and the within-limits (no-stress) baseline.
 *
 * M19: depth-collapse global stress removed (depth is now a per-coin eligibility
 * guard in RiskGateService.isBookTooThin). Breadth halt uses risk-only const
 * STRESS_BREADTH_DISTANCE_PCT=40; fires at breadth 10 (|10-50|=40) and 90
 * (|90-50|=40); silent at 15 (|15-50|=35 < 40) and 85 (|85-50|=35 < 40).
 *
 * M21: index-shock now reads btc_5m_move_pct (was btc_1m_move_pct) vs engine
 * const STRESS_BTC_5M_SHOCK_PCT=1.5; ETH threshold raised 2.0 -> 2.5
 * (STRESS_ETH_5M_SHOCK_PCT). btc_1m_move_pct remains on the snapshot for
 * telemetry only and no longer drives stress.
 */

import {
    STRESS_BREADTH_DISTANCE_PCT,
    STRESS_BTC_5M_SHOCK_PCT,
    STRESS_ETH_5M_SHOCK_PCT,
    STRESS_FUNDING_ANNUALIZED_PCT,
    STRESS_OI_CHANGE_5M_PCT,
    STRESS_SAME_BAR_HALT_COUNT,
    STRESS_SPREAD_PCT,
} from '../../../src/risk/const';
import { StressHaltEvaluator } from '../../../src/risk/service/StressHaltEvaluator';
import { buildParams, buildSnapshot } from '../../strategy/support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEvaluator(): StressHaltEvaluator {
    return new StressHaltEvaluator();
}

function calmSnapshot() {
    return buildSnapshot({
        btc_5m_move_pct: 0.5, // well below STRESS_BTC_5M_SHOCK_PCT=1.5
        btc_1m_move_pct: 0.1, // telemetry only — no longer a stress input (M21)
        eth_5m_move_pct: 0.2,
        market_breadth_5m_up_pct: 55, // |55-50|=5 — well under STRESS_BREADTH_DISTANCE_PCT=40
        same_bar_trigger_count: 1,
        open_interest_change_5m_pct: 1, // below STRESS_OI_CHANGE_5M_PCT=5
        funding_rate_annualized: 10, // below STRESS_FUNDING_ANNUALIZED_PCT=50
        bid_ask_spread_pct: 0.1, // below STRESS_SPREAD_PCT=0.6
        book_depth_10bps_usdt: '50000000', // depth is no longer a global stress input (M19)
    });
}

function calmParams() {
    return buildParams({
        stress_btc_1m_shock_pct: 1.0,
        stress_eth_1m_shock_pct: 1.5,
        stress_breadth_pct: 80.0, // param kept for classifyFlowType; breadth HALT uses STRESS_BREADTH_DISTANCE_PCT=40
        stress_same_bar_trigger_count: 5,
    });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('StressHaltEvaluator', () => {
    describe('no-stress baseline', () => {
        it('returns false when all inputs are within limits (calm market)', () => {
            const result = makeEvaluator().isStressed(calmSnapshot(), calmParams(), false);
            expect(result).toBe(false);
        });
    });

    describe('BTC 5m shock trigger', () => {
        it('triggers stress when btc_5m_move_pct >= STRESS_BTC_5M_SHOCK_PCT engine constant', () => {
            const stressed = { ...calmSnapshot(), btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT }; // exactly at threshold
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('triggers stress on a negative BTC shock (abs value check)', () => {
            const stressed = { ...calmSnapshot(), btc_5m_move_pct: -STRESS_BTC_5M_SHOCK_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('does NOT trigger when btc_5m_move_pct is just below the threshold', () => {
            const calm = { ...calmSnapshot(), btc_5m_move_pct: STRESS_BTC_5M_SHOCK_PCT - 0.01 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        // M21 boundary precision tests
        it('fires at exactly btc_5m_move_pct=1.5 (inclusive >= boundary)', () => {
            const stressed = { ...calmSnapshot(), btc_5m_move_pct: 1.5 };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('is silent at btc_5m_move_pct=1.49 (just below boundary)', () => {
            const calm = { ...calmSnapshot(), btc_5m_move_pct: 1.49 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });
    });

    describe('ETH 5m shock trigger', () => {
        it('triggers stress when eth_5m_move_pct >= STRESS_ETH_5M_SHOCK_PCT engine constant (not a strategy param)', () => {
            // ETH uses the engine-side constant STRESS_ETH_5M_SHOCK_PCT (2.5), NOT params.stress_eth_1m_shock_pct.
            const stressed = { ...calmSnapshot(), eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT }; // exactly at threshold
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('does NOT trigger ETH stress just below STRESS_ETH_5M_SHOCK_PCT (boundary)', () => {
            const calm = { ...calmSnapshot(), eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT - 0.1 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('triggers on negative ETH shock (abs value check)', () => {
            const stressed = { ...calmSnapshot(), eth_5m_move_pct: -STRESS_ETH_5M_SHOCK_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        // M21 boundary precision tests
        it('fires at exactly eth_5m_move_pct=2.5 (inclusive >= boundary, raised from 2.0)', () => {
            const stressed = { ...calmSnapshot(), eth_5m_move_pct: 2.5 };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('is silent at eth_5m_move_pct=2.49 (just below the raised 2.5 boundary)', () => {
            const calm = { ...calmSnapshot(), eth_5m_move_pct: 2.49 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('prior 2.12% ETH event no longer halts on the ETH leg alone (regression guard for false positive fixed in M21)', () => {
            // Before M21, ETH threshold was 2.0 so eth_5m_move_pct=2.12 would halt.
            // After M21 the threshold is 2.5 — 2.12% must be silent.
            const calm = { ...calmSnapshot(), eth_5m_move_pct: 2.12 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });
    });

    describe('horizon-contrast test (M21 critical — catches half-applied horizon swap)', () => {
        // CRITICAL: this test fails if the evaluator was left on btc_1m_move_pct.
        // A shocked 1m field with a calm 5m field must NOT trigger index stress.
        // A calm 1m field with a shocked 5m field MUST trigger index stress.

        it('shocked btc_1m_move_pct with calm btc_5m_move_pct does NOT trigger index stress', () => {
            // btc_1m_move_pct is telemetry only (M21); only btc_5m_move_pct drives the halt.
            const snapshot = { ...calmSnapshot(), btc_1m_move_pct: 5.0, btc_5m_move_pct: 0.5 };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(false);
        });

        it('calm btc_1m_move_pct with shocked btc_5m_move_pct DOES trigger index stress', () => {
            // btc_5m_move_pct=2.0 is above STRESS_BTC_5M_SHOCK_PCT=1.5 → stressed.
            const snapshot = { ...calmSnapshot(), btc_1m_move_pct: 0.5, btc_5m_move_pct: 2.0 };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(true);
        });
    });

    describe('fail-closed invalid inputs', () => {
        it('treats NaN in btc_5m_move_pct as stressed (fail-closed invariant — M21: guard covers the active field)', () => {
            // CRITICAL: this test fails if hasInvalidStressInputs was left guarding btc_1m_move_pct
            // instead of the active btc_5m_move_pct field (ADR 0004 §6 fail-closed atomicity).
            const snapshot = { ...calmSnapshot(), btc_5m_move_pct: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(true);
        });

        it('NaN in btc_1m_move_pct does NOT itself trigger fail-closed (1m field is telemetry only in M21)', () => {
            // btc_1m_move_pct is no longer in the stress contract. NaN there must NOT cause a halt
            // on its own — it is not in the hasInvalidStressInputs guard list.
            const snapshot = { ...calmSnapshot(), btc_1m_move_pct: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(false);
        });

        it('treats Infinity in funding_rate_annualized as stressed', () => {
            const snapshot = { ...calmSnapshot(), funding_rate_annualized: Infinity };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(true);
        });

        it('treats NaN in bid_ask_spread_pct as stressed', () => {
            const snapshot = { ...calmSnapshot(), bid_ask_spread_pct: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(true);
        });

        it('treats NaN in same_bar_trigger_count as stressed', () => {
            const snapshot = { ...calmSnapshot(), same_bar_trigger_count: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams(), false)).toBe(true);
        });
    });

    describe('breadth collapse/surge trigger — const STRESS_BREADTH_DISTANCE_PCT=40', () => {
        // The breadth halt now reads STRESS_BREADTH_DISTANCE_PCT (risk-only const = 40),
        // NOT params.stress_breadth_pct (= 80, used only by classifyFlowType for MARKET_BETA).
        // Fires when |breadth - 50| >= 40, i.e. breadth <= 10 (extreme selloff) or >= 90 (extreme melt-up).
        // Raised from 30 to 40 after soak data showed altcoin futures routinely reach 80-89%
        // breadth during normal correlated moves.

        it('triggers stress at breadth=10 (|10-50|=40 >= STRESS_BREADTH_DISTANCE_PCT=40)', () => {
            const stressed = { ...calmSnapshot(), market_breadth_5m_up_pct: 10 };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('triggers stress at breadth=90 (|90-50|=40 >= STRESS_BREADTH_DISTANCE_PCT=40)', () => {
            const stressed = { ...calmSnapshot(), market_breadth_5m_up_pct: 90 };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('is silent at breadth=15 (|15-50|=35 < STRESS_BREADTH_DISTANCE_PCT=40)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 15 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('is silent at breadth=85 (|85-50|=35 < STRESS_BREADTH_DISTANCE_PCT=40)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 85 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('is silent at breadth=55 — calm fixture (|55-50|=5 << 40)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 55 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('reflects STRESS_BREADTH_DISTANCE_PCT const value directly (const=40 means boundary fires at distance 40)', () => {
            // This pins the const value; if the const changes the test description must be updated.
            expect(STRESS_BREADTH_DISTANCE_PCT).toBe(40);
        });
    });

    describe('same_bar_trigger_count trigger', () => {
        it('triggers stress when same_bar_trigger_count >= STRESS_SAME_BAR_HALT_COUNT (M28: const-governed, not param)', () => {
            const stressed = { ...calmSnapshot(), same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('does NOT trigger at one below STRESS_SAME_BAR_HALT_COUNT', () => {
            const calm = { ...calmSnapshot(), same_bar_trigger_count: STRESS_SAME_BAR_HALT_COUNT - 1 };
            expect(makeEvaluator().isStressed(calm, calmParams(), false)).toBe(false);
        });

        it('does NOT trigger at old param value 5 when const is 20 (decoupling regression lock)', () => {
            const snapshot = { ...calmSnapshot(), same_bar_trigger_count: 5 };
            const params = calmParams(); // stress_same_bar_trigger_count=5 in params
            expect(makeEvaluator().isStressed(snapshot, params, false)).toBe(false);
        });
    });

    describe('OI shock trigger', () => {
        it('triggers stress when abs(open_interest_change_5m_pct) >= STRESS_OI_CHANGE_5M_PCT', () => {
            const stressed = { ...calmSnapshot(), open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('triggers on negative OI shock (abs value check)', () => {
            const stressed = { ...calmSnapshot(), open_interest_change_5m_pct: -STRESS_OI_CHANGE_5M_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });
    });

    describe('funding extreme trigger', () => {
        it('triggers stress when abs(funding_rate_annualized) >= STRESS_FUNDING_ANNUALIZED_PCT', () => {
            const stressed = { ...calmSnapshot(), funding_rate_annualized: STRESS_FUNDING_ANNUALIZED_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });

        it('triggers on deeply negative funding extreme', () => {
            const stressed = { ...calmSnapshot(), funding_rate_annualized: -STRESS_FUNDING_ANNUALIZED_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });
    });

    describe('spread widening trigger', () => {
        it('triggers stress when bid_ask_spread_pct >= STRESS_SPREAD_PCT', () => {
            const stressed = { ...calmSnapshot(), bid_ask_spread_pct: STRESS_SPREAD_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams(), false)).toBe(true);
        });
    });

    describe('depth is NO LONGER a global stress input (M19)', () => {
        // book_depth_10bps_usdt was removed from isLiquidityShock. Thin-depth coins
        // are now a per-coin skip (RiskGateService.isBookTooThin → COIN_BOOK_TOO_THIN),
        // not a market-wide halt. Asserting that even at depth=0 the evaluator itself
        // does NOT return stressed — the per-coin guard is elsewhere.
        it('does NOT trigger stress for any book_depth value — depth is handled per-coin by RiskGateService', () => {
            const thinDepth = { ...calmSnapshot(), book_depth_10bps_usdt: '1' };
            expect(makeEvaluator().isStressed(thinDepth, calmParams(), false)).toBe(false);
        });

        it('does NOT trigger stress when book_depth_10bps_usdt is zero string', () => {
            const zeroDepth = { ...calmSnapshot(), book_depth_10bps_usdt: '0' };
            expect(makeEvaluator().isStressed(zeroDepth, calmParams(), false)).toBe(false);
        });
    });

    describe('market-stress OVERRIDES ADX ranging label', () => {
        it('reports stressed=true even when snapshot would suggest ranging regime (ADX-override invariant)', () => {
            // The snapshot has a RANGING regime label but a stress trigger is active.
            // Uses btc_5m_move_pct (M21 active field) to trigger the BTC index shock.
            const snapshot = buildSnapshot({
                btc_5m_move_pct: 2.0, // above STRESS_BTC_5M_SHOCK_PCT=1.5 → stress
                btc_1m_move_pct: 0.1, // telemetry only
                same_bar_trigger_count: 1,
                market_breadth_5m_up_pct: 55,
                open_interest_change_5m_pct: 1,
                funding_rate_annualized: 10,
                bid_ask_spread_pct: 0.1,
                book_depth_10bps_usdt: '50000000',
                // regime_label would be RANGING normally
            });

            const result = makeEvaluator().isStressed(snapshot, calmParams(), false);

            // The stress evaluator does NOT read regime_label — it reports stress regardless
            expect(result).toBe(true);
        });
    });
});
