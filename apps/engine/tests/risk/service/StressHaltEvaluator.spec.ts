/**
 * StressHaltEvaluator — market-stress halt overrides ADX.
 *
 * Verifies each stress trigger independently, the override-ADX invariant,
 * and the within-limits (no-stress) baseline.
 *
 * M19: depth-collapse global stress removed (depth is now a per-coin eligibility
 * guard in RiskGateService.isBookTooThin). Breadth halt uses risk-only const
 * STRESS_BREADTH_DISTANCE_PCT=30; fires at breadth 20 (|20-50|=30) and 80
 * (|80-50|=30); silent at 25 (|25-50|=25 < 30) and 75 (|75-50|=25 < 30).
 */

import {
    STRESS_BREADTH_DISTANCE_PCT,
    STRESS_ETH_5M_SHOCK_PCT,
    STRESS_FUNDING_ANNUALIZED_PCT,
    STRESS_OI_CHANGE_5M_PCT,
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
        btc_1m_move_pct: 0.1,
        eth_5m_move_pct: 0.2,
        market_breadth_5m_up_pct: 55, // |55-50|=5 — well under STRESS_BREADTH_DISTANCE_PCT=30
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
        stress_breadth_pct: 80.0, // param kept for classifyFlowType; breadth HALT uses STRESS_BREADTH_DISTANCE_PCT=30
        stress_same_bar_trigger_count: 5,
    });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('StressHaltEvaluator', () => {
    describe('no-stress baseline', () => {
        it('returns false when all inputs are within limits (calm market)', () => {
            const result = makeEvaluator().isStressed(calmSnapshot(), calmParams());
            expect(result).toBe(false);
        });
    });

    describe('BTC 1m shock trigger', () => {
        it('triggers stress when btc_1m_move_pct >= stress_btc_1m_shock_pct', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, btc_1m_move_pct: 1.0 }; // exactly at threshold
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('triggers stress on a negative BTC shock (abs value check)', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, btc_1m_move_pct: -1.5 };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('does NOT trigger when btc_1m_move_pct is just below the threshold', () => {
            const snapshot = calmSnapshot();
            const calm = { ...snapshot, btc_1m_move_pct: 0.99 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });
    });

    describe('ETH 5m shock trigger', () => {
        it('triggers stress when eth_5m_move_pct >= STRESS_ETH_5M_SHOCK_PCT engine constant (not a strategy param)', () => {
            // ETH uses the engine-side constant STRESS_ETH_5M_SHOCK_PCT (2.0), NOT params.stress_eth_1m_shock_pct.
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT }; // exactly at threshold
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('does NOT trigger ETH stress just below STRESS_ETH_5M_SHOCK_PCT (boundary)', () => {
            const snapshot = calmSnapshot();
            const calm = { ...snapshot, eth_5m_move_pct: STRESS_ETH_5M_SHOCK_PCT - 0.1 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });

        it('triggers on negative ETH shock (abs value check)', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, eth_5m_move_pct: -STRESS_ETH_5M_SHOCK_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });
    });

    describe('fail-closed invalid inputs', () => {
        it('treats NaN in btc_1m_move_pct as stressed (fail-closed invariant)', () => {
            const snapshot = { ...calmSnapshot(), btc_1m_move_pct: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams())).toBe(true);
        });

        it('treats Infinity in funding_rate_annualized as stressed', () => {
            const snapshot = { ...calmSnapshot(), funding_rate_annualized: Infinity };
            expect(makeEvaluator().isStressed(snapshot, calmParams())).toBe(true);
        });

        it('treats NaN in bid_ask_spread_pct as stressed', () => {
            const snapshot = { ...calmSnapshot(), bid_ask_spread_pct: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams())).toBe(true);
        });

        it('treats NaN in same_bar_trigger_count as stressed', () => {
            const snapshot = { ...calmSnapshot(), same_bar_trigger_count: NaN };
            expect(makeEvaluator().isStressed(snapshot, calmParams())).toBe(true);
        });
    });

    describe('breadth collapse/surge trigger — const STRESS_BREADTH_DISTANCE_PCT=30', () => {
        // The breadth halt now reads STRESS_BREADTH_DISTANCE_PCT (risk-only const = 30),
        // NOT params.stress_breadth_pct (= 80, used only by classifyFlowType for MARKET_BETA).
        // Fires when |breadth - 50| >= 30, i.e. breadth <= 20 (broad selloff) or >= 80 (melt-up).

        it('triggers stress at breadth=20 (|20-50|=30 >= STRESS_BREADTH_DISTANCE_PCT=30)', () => {
            const stressed = { ...calmSnapshot(), market_breadth_5m_up_pct: 20 };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('triggers stress at breadth=80 (|80-50|=30 >= STRESS_BREADTH_DISTANCE_PCT=30)', () => {
            const stressed = { ...calmSnapshot(), market_breadth_5m_up_pct: 80 };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('is silent at breadth=25 (|25-50|=25 < STRESS_BREADTH_DISTANCE_PCT=30)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 25 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });

        it('is silent at breadth=75 (|75-50|=25 < STRESS_BREADTH_DISTANCE_PCT=30)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 75 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });

        it('is silent at breadth=55 — calm fixture (|55-50|=5 << 30)', () => {
            const calm = { ...calmSnapshot(), market_breadth_5m_up_pct: 55 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });

        it('reflects STRESS_BREADTH_DISTANCE_PCT const value directly (const=30 means boundary fires at distance 30)', () => {
            // This pins the const value; if the const changes the test description must be updated.
            expect(STRESS_BREADTH_DISTANCE_PCT).toBe(30);
        });
    });

    describe('same_bar_trigger_count trigger', () => {
        it('triggers stress when same_bar_trigger_count >= stress_same_bar_trigger_count', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, same_bar_trigger_count: 5 };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('does NOT trigger at one below the threshold', () => {
            const snapshot = calmSnapshot();
            const calm = { ...snapshot, same_bar_trigger_count: 4 };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
        });
    });

    describe('OI shock trigger', () => {
        it('triggers stress when abs(open_interest_change_5m_pct) >= STRESS_OI_CHANGE_5M_PCT', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, open_interest_change_5m_pct: STRESS_OI_CHANGE_5M_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('triggers on negative OI shock (abs value check)', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, open_interest_change_5m_pct: -STRESS_OI_CHANGE_5M_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });
    });

    describe('funding extreme trigger', () => {
        it('triggers stress when abs(funding_rate_annualized) >= STRESS_FUNDING_ANNUALIZED_PCT', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, funding_rate_annualized: STRESS_FUNDING_ANNUALIZED_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('triggers on deeply negative funding extreme', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, funding_rate_annualized: -STRESS_FUNDING_ANNUALIZED_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });
    });

    describe('spread widening trigger', () => {
        it('triggers stress when bid_ask_spread_pct >= STRESS_SPREAD_PCT', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, bid_ask_spread_pct: STRESS_SPREAD_PCT };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });
    });

    describe('depth is NO LONGER a global stress input (M19)', () => {
        // book_depth_10bps_usdt was removed from isLiquidityShock. Thin-depth coins
        // are now a per-coin skip (RiskGateService.isBookTooThin → COIN_BOOK_TOO_THIN),
        // not a market-wide halt. Asserting that even at depth=0 the evaluator itself
        // does NOT return stressed — the per-coin guard is elsewhere.
        it('does NOT trigger stress for any book_depth value — depth is handled per-coin by RiskGateService', () => {
            const thinDepth = { ...calmSnapshot(), book_depth_10bps_usdt: '1' };
            expect(makeEvaluator().isStressed(thinDepth, calmParams())).toBe(false);
        });

        it('does NOT trigger stress when book_depth_10bps_usdt is zero string', () => {
            const zeroDepth = { ...calmSnapshot(), book_depth_10bps_usdt: '0' };
            expect(makeEvaluator().isStressed(zeroDepth, calmParams())).toBe(false);
        });
    });

    describe('market-stress OVERRIDES ADX ranging label', () => {
        it('reports stressed=true even when snapshot would suggest ranging regime (ADX-override invariant)', () => {
            // The snapshot has RANGING regime label but a stress trigger is active
            const snapshot = buildSnapshot({
                btc_1m_move_pct: 2.0, // BTC shock → stress
                same_bar_trigger_count: 1,
                market_breadth_5m_up_pct: 55,
                open_interest_change_5m_pct: 1,
                funding_rate_annualized: 10,
                bid_ask_spread_pct: 0.1,
                book_depth_10bps_usdt: '50000000',
                // regime_label would be RANGING normally
            });

            const result = makeEvaluator().isStressed(snapshot, calmParams());

            // The stress evaluator does NOT read regime_label — it reports stress regardless
            expect(result).toBe(true);
        });
    });
});
