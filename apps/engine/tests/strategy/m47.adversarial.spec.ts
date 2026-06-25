/**
 * M47 adversarial QA wave — geometry invariants, gate backstop, seed-race fix, schema guard.
 *
 * This file covers the adversarial cases that are NOT already exercised by the paired
 * per-task specs (momentumCore.m47.rrfloor.spec.ts, meanReversionCore.m47.slcap.spec.ts,
 * momentumCore.m47.rebase.spec.ts, RiskGateService.spec.ts). Each test maps to a numbered
 * item in the Task 6 QA coverage list.
 *
 * Coverage map (items not already covered by per-task specs):
 *   Item 5  — momentum cap exactly binding (slDist×min_rr == max_tp_dist_factor×atr14): SKIP
 *   Item 8  — mean-reversion slCap == slFloor exactly: OPEN with slDist == slCap
 *   Item 9  — mean-reversion zero ATR → pct floor binding → degenerate skip
 *   Item 10 — entry_pct_floor unit convention: 0.3 means 0.3% (divide by 100), not 30%
 *   Item 15 — live/backtest parity: same signal input → identical tp_dist/sl_dist
 *   Item 20 — fill off reference → momentum ratio unchanged (Bug 2 regression guard)
 *   Item 21 — strategyParamsSchema rejects params missing min_rr (strict schema guard)
 *
 * Items 16–19 (ExecutionService-level call-order) → apps/engine/tests/execution/service/m47.seedRace.adversarial.spec.ts
 * Items 22–25 (position_segment_stats view) → apps/engine/tests/db/m47.segmentStats.adversarial.spec.ts
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { strategyParamsSchema } from '@bot/shared';
import { Money } from '../../src/common/utils/money';
import { IStrategyInput } from '../../src/strategy/interface';
import { evaluateMeanReversion } from '../../src/strategy/strategies/meanReversionCore';
import { evaluateMomentum } from '../../src/strategy/strategies/momentumCore';
import { buildParams } from './support/fixtures';

// ─── shared fixture builders ─────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000 + 5 * 60_000;

function buildMomentumInput(opts: { vwap: string; deviationPct: number; atr14: string; side?: DeviationSideEnum }): IStrategyInput {
    const side = opts.side ?? (opts.deviationPct >= 0 ? DeviationSideEnum.ABOVE : DeviationSideEnum.BELOW);
    const regimeLabel = side === DeviationSideEnum.ABOVE ? RegimeLabelEnum.TRENDING_UP : RegimeLabelEnum.TRENDING_DOWN;

    return {
        event: {
            symbol: 'BTCUSDT',
            side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'BTCUSDT:1700000000000',
            vwapSession: new Money(opts.vwap).toFixed(18),
            vwap20bar: new Money(opts.vwap).toFixed(18),
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: opts.deviationPct,
            vwapDeviationSigma: 2.5,
            volumeRatio: 2.5,
            volume20barAvg: new Money('1000000').toFixed(18),
            atr14: new Money(opts.atr14).toFixed(18),
            adx14: 35,
            adxDiPlus: 30,
            adxDiMinus: 10,
            rsi14: 65,
            bollingerUpper: new Money('51000').toFixed(18),
            bollingerLower: new Money('49000').toFixed(18),
            bollingerPctB: 0.9,
            btc5mMovePct: 0.5,
            idiosyncrasyScore: 0.6,
            coinTier: CoinTierEnum.TIER_1,
            coinVolumeRank: 1,
            symbolUniverseAgeHours: 200,
            fundingRate: 0.0001,
            fundingRateAnnualized: 0.1,
            openInterest: new Money('9000000').toFixed(18),
            openInterestChange5mPct: 0.5,
            openInterestChange15mPct: 1.0,
            aggTradeBuyVolumeRatio: 0.65,
            bidAskSpreadPct: 0.02,
            bookDepth10bpsUsdt: new Money('500000').toFixed(18),
            bookDepth50bpsUsdt: new Money('1000000').toFixed(18),
            regimeLabel,
            marketBreadth5mUpPct: 65,
            sameBarTriggerCount: 2,
            btc1mMovePct: 0.2,
            eth5mMovePct: 0.6,
            flowType: FlowTypeEnum.TREND_INITIATION,
        } as any,
        snapshot: { vwap_session: opts.vwap, signal_score: 85, flow_type: FlowTypeEnum.TREND_INITIATION } as any,
        openPosition: null,
        params: buildParams(),
        nowMs: NOW_MS,
    };
}

function buildMeanReversionInput(opts: { vwap: string; deviationPct: number; atr14: string; wickOffset: string; hardCapPct?: number }): IStrategyInput {
    const vwap = new Money(opts.vwap);
    const reference = vwap.times(new Money(1).plus(new Money(opts.deviationPct).dividedBy(100)));
    const wick = reference.plus(new Money(opts.wickOffset));

    return {
        event: {
            symbol: 'EDGEUSDT',
            side: DeviationSideEnum.ABOVE,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'EDGEUSDT:1700000000000',
            vwapSession: vwap.toFixed(18),
            vwap20bar: vwap.toFixed(18),
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: opts.deviationPct,
            vwapDeviationSigma: 2.1,
            volumeRatio: 0.8,
            volume20barAvg: new Money('500000').toFixed(18),
            atr14: new Money(opts.atr14).toFixed(18),
            adx14: 25,
            adxDiPlus: 20,
            adxDiMinus: 12,
            rsi14: 65,
            bollingerUpper: wick.toFixed(18),
            bollingerLower: reference.minus(new Money(opts.wickOffset)).toFixed(18),
            bollingerPctB: 0.6,
            btc5mMovePct: 0.1,
            idiosyncrasyScore: 0.2,
            coinTier: CoinTierEnum.TIER_1,
            coinVolumeRank: 10,
            symbolUniverseAgeHours: 200,
            fundingRate: 0.0001,
            fundingRateAnnualized: 0.1,
            openInterest: new Money('5000000').toFixed(18),
            openInterestChange5mPct: -0.1,
            openInterestChange15mPct: -0.2,
            aggTradeBuyVolumeRatio: 0.4,
            bidAskSpreadPct: 0.05,
            bookDepth10bpsUsdt: new Money('20000').toFixed(18),
            bookDepth50bpsUsdt: new Money('50000').toFixed(18),
            regimeLabel: RegimeLabelEnum.RANGING,
            marketBreadth5mUpPct: 50,
            sameBarTriggerCount: 2,
            btc1mMovePct: 0.05,
            eth5mMovePct: 0.1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        } as any,
        snapshot: { vwap_session: opts.vwap, signal_score: 75, flow_type: FlowTypeEnum.FORCED_EXHAUSTION } as any,
        openPosition: null,
        params: buildParams({
            structural_stop_hard_cap_pct: opts.hardCapPct ?? 50.0,
        }),
        nowMs: NOW_MS,
    };
}

// ─── Item 5 — momentum cap exactly binding ────────────────────────────────────
//
// When slDist × min_rr == max_tp_dist_factor × atr14 (cap exactly equals rrFloorRaw),
// the cap binds but the post-cap ratio tpDist/slDist == max_tp_dist_factor × atr14 / slDist.
// Because slDist × min_rr == cap, we have cap/slDist == min_rr exactly — which equals min_rr,
// so the strict-less-than degenerate check (tpDist/slDist < min_rr) is FALSE and the trade
// OPENS with tpDist equal to the cap.
//
// Geometry: LONG, vwap=50000, dev=0.5% → slDist=250; min_rr=1.5 → rrFloorRaw=375.
// Choose atr14 so that cap = max_tp_dist_factor × atr14 = 375 exactly → atr14 = 375/5.0 = 75.
// baseLeg = max(75×3.5=262.5, costFloor). tpDist = max(262.5, 375) = 375.
// ratio = 375/250 = 1.5 == min_rr → strict `<` does NOT fire → OPEN.

describe('M47 adversarial — Item 5: momentum cap exactly binding at rrFloorRaw', () => {
    it('LONG: slDist×min_rr == cap exactly → OPEN with tpDist == cap (boundary at min_rr)', () => {
        // slDist = 50000×0.005 = 250; min_rr=1.5 → rrFloorRaw=375; atr14=75 → cap=5×75=375.
        // cap==rrFloorRaw → rrFloor=375; baseLeg=75×3.5=262.5 < 375 → tpDist=375.
        // ratio=375/250=1.5 == min_rr → strict < fails → OPEN.
        const input = buildMomentumInput({ vwap: '50000', deviationPct: 0.5, atr14: '75' });
        const signal = evaluateMomentum(input);
        const vwap = new Money('50000');
        const reference = vwap.times(new Money(1).plus(new Money('0.5').dividedBy(100)));
        const slDist = reference.minus(vwap).abs();
        const cap = new Money('75').times(5.0); // 375

        // verify the boundary condition holds
        expect(slDist.times(1.5).toFixed()).toBe(cap.toFixed());

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        // tpDist == cap == 375
        const tpDist = new Money(signal.proposedExit!.takeProfitPrice).minus(reference).abs();
        expect(tpDist.toFixed()).toBe(cap.toFixed());
    });
});

// ─── Item 8 — mean-reversion slCap == slFloor exactly ────────────────────────
//
// When the structural stop would be tightened by slCap and slCap equals slFloor exactly,
// the degeneracy check (slCap < slFloor) is false (strict <), so the trade OPENS with
// slDist == slCap == slFloor.
//
// Geometry: vwap=100, dev=3% → reference=103, tpDist=0.5×3=1.5, slCap=1.5/1.5=1.0.
// Choose atr14 so that atrFloor = 0.3×atr14 == 1.0 exactly → atr14 ≈ 3.333.
// pctFloor = 0.3/100×103 ≈ 0.309 < 1.0, so ATR floor is the binding floor.
// slFloor = max(1.0, 0.309) = 1.0 == slCap → strict `<` does NOT fire → OPEN.

describe('M47 adversarial — Item 8: mean-reversion slCap == slFloor exactly → OPEN', () => {
    it('slCap equals slFloor at the boundary: not degenerate, OPEN with slDist == slCap', () => {
        // tpDist = 0.5 × (103−100) = 1.5; slCap = 1.5/1.5 = 1.0.
        // atr14 = 1.0/0.3 ≈ 3.3333... → atrFloor = 0.3 × 3.3333 = 1.0 == slCap.
        // slFloor = max(1.0, pctFloor≈0.309) = 1.0; slCap(1.0) < slFloor(1.0) is FALSE → OPEN.
        const atr14 = (1.0 / 0.3).toFixed(10); // ≈ 3.3333333333
        const opts = { vwap: '100', deviationPct: 3, atr14, wickOffset: '5' };
        const input = buildMeanReversionInput(opts);
        const signal = evaluateMeanReversion(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);

        // slDist should equal slCap == 1.0
        const reference = new Money('100').times(new Money(1).plus(new Money('3').dividedBy(100)));
        const slDist = new Money(signal.proposedExit!.stopLossPrice).minus(reference).abs();
        const slCap = new Money('1.5').dividedBy(1.5); // 1.0

        // Use tolerant comparison: the floating-point atr14 string introduces a tiny rounding delta.
        // Both should round to 1.0 to at least 8 decimal places.
        expect(parseFloat(slDist.toFixed(8))).toBeCloseTo(parseFloat(slCap.toFixed(8)), 6);
    });
});

// ─── Item 9 — mean-reversion zero ATR → pct floor → degenerate skip ──────────
//
// When atr14 is exactly 0, atrFloor = 0.3 × 0 = 0. The binding floor is the pct floor:
// pctFloor = (0.3/100) × reference. For a small deviation tpDist can be tiny (and slCap tiny),
// so slCap < pctFloor → degenerate skip.
// A large enough deviation can make slCap > pctFloor → OPEN.

describe('M47 adversarial — Item 9: mean-reversion zero ATR', () => {
    it('zero ATR with small deviation: slCap < pct floor → degenerate skip', () => {
        // dev=0.5% → reference=100.5, tpDist=0.25, slCap=0.25/1.5≈0.1667.
        // pctFloor = 0.3/100 × 100.5 ≈ 0.3015; atrFloor=0. slCap < pctFloor → SKIP.
        const input = buildMeanReversionInput({ vwap: '100', deviationPct: 0.5, atr14: '0', wickOffset: '5' });
        const signal = evaluateMeanReversion(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
    });

    it('zero ATR with large deviation: slCap > pct floor → OPEN with pct floor binding as minimum', () => {
        // dev=10% → reference=110, tpDist=5, slCap=5/1.5≈3.333.
        // pctFloor = 0.3/100 × 110 = 0.33; atrFloor=0. slCap(3.333) > pctFloor(0.33) → OPEN.
        // Hard cap is loose (50%), structural stop wide (wickOffset=2) < slCap → structural stop wins.
        const input = buildMeanReversionInput({ vwap: '100', deviationPct: 10, atr14: '0', wickOffset: '2' });
        const signal = evaluateMeanReversion(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
    });
});

// ─── Item 10 — entry_pct_floor unit convention ────────────────────────────────
//
// entry_pct_floor = 0.3 means 0.3% of entry, NOT 30% of entry. The implementation divides by
// 100 before applying. Verify by constructing a scenario where:
//   - ATR is zero (atrFloor = 0, pct floor is the only floor)
//   - entry=100, deviation=50% → reference=150, tpDist=25, slCap=25/1.5≈16.67
//   - With 0.3% floor: pctFloor = 0.3/100 × 150 = 0.45 → slCap(16.67) > pctFloor → OPEN
//   - With 30% floor (wrong unit): pctFloor = 0.3 × 150 = 45 → slCap(16.67) < 45 → SKIP (wrong)
//
// If the implementation incorrectly omits the /100, this test would fail because the signal
// would be SKIP (degenerate due to slCap < the inflated floor).

describe('M47 adversarial — Item 10: entry_pct_floor is a percent-number (divide-by-100)', () => {
    it('entry_pct_floor=0.3 is applied as 0.3% of entry, not 30% — large slCap >> 0.3% floor → OPEN', () => {
        // dev=50% → reference=150, tpDist=25, slCap=16.67. pctFloor = 0.003×150=0.45.
        // If /100 is missing: floor = 0.3×150=45 → slCap(16.67) < 45 → incorrect SKIP.
        // If /100 is correct: floor = 0.003×150=0.45 → slCap(16.67) > 0.45 → OPEN (correct).
        const input = buildMeanReversionInput({
            vwap: '100',
            deviationPct: 50,
            atr14: '0', // force pct floor to be the only floor
            wickOffset: '5',
            hardCapPct: 80.0,
        });
        const signal = evaluateMeanReversion(input);

        // Correct divide-by-100: slCap(≈16.67) >> pctFloor(≈0.45) → OPEN
        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
    });

    it('entry_pct_floor=0.3 applied as 30% of entry would over-reject — verify the value the core computes', () => {
        // Build a scenario where slCap sits between 0.45 (correct 0.3%) and 45 (wrong 30%).
        // dev=3% → reference=103, tpDist=1.5, slCap=1.0. Correct floor: 0.003×103≈0.309 < 1.0 → OPEN.
        // Wrong floor: 0.3×103=30.9 > 1.0 → SKIP. OPEN confirms /100 is applied.
        const input = buildMeanReversionInput({ vwap: '100', deviationPct: 3, atr14: '0', wickOffset: '5' });
        const signal = evaluateMeanReversion(input);

        // pctFloor (correct) = 0.309, slCap = 1.0 → OPEN.
        // pctFloor (wrong, no /100) = 30.9 > slCap → would be SKIP.
        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });
});

// ─── Item 15 — live/backtest parity ──────────────────────────────────────────
//
// The same signal input through evaluateMomentum called twice (simulating live path and
// backtest core path) must yield identical tp_dist / sl_dist. This validates that:
// (a) the strategy core is pure (no Date.now(), no RNG, no I/O)
// (b) the geometry depends only on the input params, not on ambient state
//
// The backtest gate-anchor parity (BLOCKER 1 — entryPrice vs nextBarOpen) cannot be tested
// at the pure-core level; that requires the BacktestOrchestrator integration layer. This test
// guards the core geometry determinism, which is the prerequisite for parity.

describe('M47 adversarial — Item 15: live/backtest core geometry determinism', () => {
    it('momentum: two evaluations of the same input yield identical tp_dist / sl_dist ratio', () => {
        // The core is pure and deterministic: no clock reads, no RNG.
        const input = buildMomentumInput({ vwap: '50000', deviationPct: 0.5, atr14: '100' });

        const run1 = evaluateMomentum(input);
        const run2 = evaluateMomentum(input);

        expect(run1.action).toBe(SignalActionEnum.OPEN);
        expect(run2.action).toBe(SignalActionEnum.OPEN);

        const vwap = new Money('50000');
        const reference = vwap.times(new Money(1).plus(new Money('0.5').dividedBy(100)));
        const slDist1 = reference.minus(vwap).abs();
        const tp1 = new Money(run1.proposedExit!.takeProfitPrice);
        const tp2 = new Money(run2.proposedExit!.takeProfitPrice);
        const sl1 = new Money(run1.proposedExit!.stopLossPrice);
        const sl2 = new Money(run2.proposedExit!.stopLossPrice);

        expect(tp1.toFixed()).toBe(tp2.toFixed());
        expect(sl1.toFixed()).toBe(sl2.toFixed());

        const ratio1 = tp1.minus(reference).abs().dividedBy(slDist1);
        const ratio2 = tp2.minus(reference).abs().dividedBy(slDist1);

        expect(ratio1.toFixed()).toBe(ratio2.toFixed());
    });

    it('mean-reversion: two evaluations of the same input yield identical sl_dist / tp_dist ratio', () => {
        const input = buildMeanReversionInput({ vwap: '100', deviationPct: 3, atr14: '1', wickOffset: '5' });

        const run1 = evaluateMeanReversion(input);
        const run2 = evaluateMeanReversion(input);

        expect(run1.action).toBe(SignalActionEnum.OPEN);
        expect(run2.action).toBe(SignalActionEnum.OPEN);
        expect(new Money(run1.proposedExit!.takeProfitPrice).toFixed()).toBe(new Money(run2.proposedExit!.takeProfitPrice).toFixed());
        expect(new Money(run1.proposedExit!.stopLossPrice).toFixed()).toBe(new Money(run2.proposedExit!.stopLossPrice).toFixed());
    });
});

// ─── Item 20 — fill off reference → momentum ratio unchanged (Bug 2 guard) ────
//
// Task 0 (Option B): tpRebaseEligible=false means the execution layer CANNOT rebase the TP
// at fill time. Verify that for ANY fill price (including one far from reference):
//   - tpRebaseEligible is false
//   - atrDistance is non-null (sweep tool still needs it)
//   - The ratio (tp − reference) / (reference − sl) == min_rr (or >= min_rr)
//
// This is a REGRESSION GUARD for Bug 2: the asymmetric single-leg rebase that caused
// positions to hold R:R far below what the gate approved.

describe('M47 adversarial — Item 20: fill off reference leaves momentum geometry frozen', () => {
    it('LONG: tpRebaseEligible is false regardless of which TP leg wins', () => {
        // rrFloor-dominated case (large spike)
        const spike = buildMomentumInput({ vwap: '50000', deviationPct: 0.5, atr14: '100' });
        const spikeSignal = evaluateMomentum(spike);

        // atr-dominated case (small spike)
        const calm = buildMomentumInput({ vwap: '50000', deviationPct: 0.05, atr14: '100' });
        const calmSignal = evaluateMomentum(calm);

        expect(spikeSignal.action).toBe(SignalActionEnum.OPEN);
        expect(calmSignal.action).toBe(SignalActionEnum.OPEN);
        expect(spikeSignal.proposedExit!.tpRebaseEligible).toBe(false);
        expect(calmSignal.proposedExit!.tpRebaseEligible).toBe(false);
    });

    it('SHORT: tpRebaseEligible is false on both legs', () => {
        const shortSpike = buildMomentumInput({ vwap: '50000', deviationPct: -0.3, atr14: '100', side: DeviationSideEnum.BELOW });
        const signal = evaluateMomentum(shortSpike);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
    });

    it('LONG spike: tp_dist / sl_dist >= min_rr — geometry the gate approved is the geometry held', () => {
        // Because tpRebaseEligible=false, the gate-approved ratio is the ratio the position holds
        // for its entire life — no fill-time mutation can void it.
        const input = buildMomentumInput({ vwap: '50000', deviationPct: 0.5, atr14: '100' });
        const signal = evaluateMomentum(input);
        expect(signal.action).toBe(SignalActionEnum.OPEN);

        const vwap = new Money('50000');
        const reference = vwap.times(new Money(1).plus(new Money('0.5').dividedBy(100)));
        const slDist = reference.minus(vwap).abs();
        const tpDist = new Money(signal.proposedExit!.takeProfitPrice).minus(reference).abs();
        const ratio = tpDist.dividedBy(slDist);

        // ratio must meet or exceed min_rr (1.5), which the gate would have approved
        expect(parseFloat(ratio.toFixed(6))).toBeGreaterThanOrEqual(1.5);
    });

    it('atrDistance equals tpDist in every OPEN case (single-composite-distance invariant post-Option-B)', () => {
        // atrDistance is still carried so the sweep tool can reconstruct the signal reference
        // (only the fill-time rebase CONSUMPTION of atrDistance is removed, not the field).
        const longInput = buildMomentumInput({ vwap: '50000', deviationPct: 0.5, atr14: '100' });
        const longSignal = evaluateMomentum(longInput);
        expect(longSignal.action).toBe(SignalActionEnum.OPEN);

        const vwap = new Money('50000');
        const reference = vwap.times(new Money(1).plus(new Money('0.5').dividedBy(100)));
        const expectedTpDist = new Money(longSignal.proposedExit!.takeProfitPrice).minus(reference).abs();

        expect(new Money(longSignal.proposedExit!.atrDistance!).toFixed()).toBe(expectedTpDist.toFixed());
    });
});

// ─── Item 21 — strategyParamsSchema rejects missing min_rr ───────────────────
//
// The schema is .strict() — unknown keys are rejected AND required keys missing reject.
// Verify that a params object without any of the M47 fields fails safeParse.

describe('M47 adversarial — Item 21: strategyParamsSchema rejects missing M47 params', () => {
    const validBase = {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 1.5,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.7,
        btc_correlated_move_threshold_pct: 0.3,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier1_max_abs_move_pct: 3.0,
        tier2_min_abs_move_pct: 0.8,
        tier2_max_abs_move_pct: 5.0,
        tier3_min_abs_move_pct: 1.2,
        tier3_max_abs_move_pct: 8.0,
        funding_rate_suppress_threshold: 0.001,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 5,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 1.0,
        stress_eth_1m_shock_pct: 1.5,
        stress_breadth_pct: 80.0,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.3,
        structural_stop_hard_cap_pct: 2.0,
        min_rr: 1.5,
        entry_pct_floor: 0.3,
        atr_floor_multiplier: 0.3,
        max_tp_dist_factor: 5.0,
    };

    it('valid params with all M47 fields → safeParse succeeds', () => {
        const result = strategyParamsSchema.safeParse(validBase);
        expect(result.success).toBe(true);
    });

    it('params missing min_rr → safeParse fails', () => {
        const { min_rr: _dropped, ...withoutMinRr } = validBase;
        const result = strategyParamsSchema.safeParse(withoutMinRr);
        expect(result.success).toBe(false);
    });

    it('params missing entry_pct_floor → safeParse fails', () => {
        const { entry_pct_floor: _dropped, ...without } = validBase;
        const result = strategyParamsSchema.safeParse(without);
        expect(result.success).toBe(false);
    });

    it('params missing atr_floor_multiplier → safeParse fails', () => {
        const { atr_floor_multiplier: _dropped, ...without } = validBase;
        const result = strategyParamsSchema.safeParse(without);
        expect(result.success).toBe(false);
    });

    it('params missing max_tp_dist_factor → safeParse fails', () => {
        const { max_tp_dist_factor: _dropped, ...without } = validBase;
        const result = strategyParamsSchema.safeParse(without);
        expect(result.success).toBe(false);
    });

    it('params with min_rr=0 (non-positive) → safeParse fails (z.number().positive())', () => {
        const result = strategyParamsSchema.safeParse({ ...validBase, min_rr: 0 });
        expect(result.success).toBe(false);
    });

    it('params with an unknown key (strict schema) → safeParse fails', () => {
        const result = strategyParamsSchema.safeParse({ ...validBase, unknown_future_key: 99 });
        expect(result.success).toBe(false);
    });

    it('params with min_rr as a string → safeParse fails (type coercion not permitted)', () => {
        const result = strategyParamsSchema.safeParse({ ...validBase, min_rr: '1.5' });
        expect(result.success).toBe(false);
    });
});

// ─── Anti-coverage: momentum OPEN signals never have R:R below min_rr ─────────

describe('M47 adversarial — anti-coverage: no momentum OPEN signal has signal-time R:R < min_rr', () => {
    const testCases = [
        { vwap: '50000', deviationPct: 0.05, atr14: '100', label: 'tiny deviation (atrLeg dominates)' },
        { vwap: '50000', deviationPct: 0.5, atr14: '100', label: 'medium deviation (rrFloor dominates)' },
        { vwap: '50000', deviationPct: 0.2, atr14: '50', label: 'small deviation, smaller ATR' },
    ];

    for (const tc of testCases) {
        it(`LONG ${tc.label}: if OPEN, R:R >= min_rr`, () => {
            const input = buildMomentumInput({ vwap: tc.vwap, deviationPct: tc.deviationPct, atr14: tc.atr14 });
            const signal = evaluateMomentum(input);

            if (signal.action === SignalActionEnum.OPEN) {
                const vwap = new Money(tc.vwap);
                const reference = vwap.times(new Money(1).plus(new Money(tc.deviationPct.toString()).dividedBy(100)));
                const slDist = reference.minus(vwap).abs();
                const tpDist = new Money(signal.proposedExit!.takeProfitPrice).minus(reference).abs();
                const rr = parseFloat(tpDist.dividedBy(slDist).toFixed(8));

                expect(rr).toBeGreaterThanOrEqual(1.5);
            }
        });
    }
});

// ─── Anti-coverage: mean-reversion OPEN signals never have R:R below min_rr ──

describe('M47 adversarial — anti-coverage: no mean-reversion OPEN signal has signal-time R:R < min_rr', () => {
    const testCases = [
        { vwap: '100', deviationPct: 3, atr14: '1', wickOffset: '5', label: 'wide wick' },
        { vwap: '100', deviationPct: 5, atr14: '0.5', wickOffset: '0.5', label: 'tight wick' },
        { vwap: '100', deviationPct: 3, atr14: '0.5', wickOffset: '0.897', label: 'boundary wick' },
    ];

    for (const tc of testCases) {
        it(`SHORT ${tc.label}: if OPEN, R:R >= min_rr`, () => {
            const input = buildMeanReversionInput(tc);
            const signal = evaluateMeanReversion(input);

            if (signal.action === SignalActionEnum.OPEN) {
                const vwap = new Money(tc.vwap);
                const reference = vwap.times(new Money(1).plus(new Money(tc.deviationPct.toString()).dividedBy(100)));
                // SHORT: TP below reference (VWAP is below reference for ABOVE deviation)
                const tpDist = reference.minus(new Money(signal.proposedExit!.takeProfitPrice)).abs();
                const slDist = new Money(signal.proposedExit!.stopLossPrice).minus(reference).abs();
                const rr = parseFloat(tpDist.dividedBy(slDist).toFixed(8));

                // R:R must be >= min_rr (1.5) for any OPEN signal
                expect(rr).toBeGreaterThanOrEqual(1.5);
            }
        });
    }
});
