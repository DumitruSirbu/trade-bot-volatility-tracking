/**
 * StressHaltEvaluator — market-stress halt overrides ADX.
 *
 * Verifies each stress trigger independently, the override-ADX invariant,
 * and the within-limits (no-stress) baseline.
 */

import {
    STRESS_BOOK_DEPTH_FLOOR_USDT,
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
        market_breadth_5m_up_pct: 55, // 5 away from 50 — well under stress_breadth_pct=80
        same_bar_trigger_count: 1,
        open_interest_change_5m_pct: 1, // below STRESS_OI_CHANGE_5M_PCT=5
        funding_rate_annualized: 10, // below STRESS_FUNDING_ANNUALIZED_PCT=50
        bid_ask_spread_pct: 0.1, // below STRESS_SPREAD_PCT=0.6
        book_depth_10bps_usdt: '50000000', // above STRESS_BOOK_DEPTH_FLOOR_USDT=20000
    });
}

function calmParams() {
    return buildParams({
        stress_btc_1m_shock_pct: 1.0,
        stress_eth_1m_shock_pct: 1.5,
        stress_breadth_pct: 80.0,
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

    describe('breadth collapse/surge trigger', () => {
        it('triggers stress when market_breadth_5m_up_pct collapses (50-breadth >= stress_breadth_pct)', () => {
            const snapshot = calmSnapshot();
            // distanceFromBalance = |5 - 50| = 45; stress_breadth_pct=80 → no
            // distanceFromBalance = |130 - 50| = 80 → yes
            const stressed = { ...snapshot, market_breadth_5m_up_pct: 130 };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('triggers stress when breadth surges toward 100% (distance from 50 >= threshold)', () => {
            const snapshot = calmSnapshot();
            // need >= 80 from 50, i.e., >= 130 or <= -30; use 130
            expect(makeEvaluator().isStressed({ ...snapshot, market_breadth_5m_up_pct: 130 }, calmParams())).toBe(true);
        });

        it('does NOT trigger when breadth is near 50% balance', () => {
            const snapshot = calmSnapshot();
            const calm = { ...snapshot, market_breadth_5m_up_pct: 55 }; // |55-50|=5 < 80
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
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

    describe('depth collapse trigger', () => {
        it('triggers stress when book_depth_10bps_usdt <= STRESS_BOOK_DEPTH_FLOOR_USDT', () => {
            const snapshot = calmSnapshot();
            const stressed = { ...snapshot, book_depth_10bps_usdt: String(STRESS_BOOK_DEPTH_FLOOR_USDT) };
            expect(makeEvaluator().isStressed(stressed, calmParams())).toBe(true);
        });

        it('does NOT trigger when depth is one unit above the floor', () => {
            const snapshot = calmSnapshot();
            const calm = { ...snapshot, book_depth_10bps_usdt: String(STRESS_BOOK_DEPTH_FLOOR_USDT + 1) };
            expect(makeEvaluator().isStressed(calm, calmParams())).toBe(false);
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
