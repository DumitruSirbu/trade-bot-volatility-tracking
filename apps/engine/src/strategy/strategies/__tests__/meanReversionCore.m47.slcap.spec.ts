/**
 * meanReversionCore — M47 Task 3: SL cap (slCap = tpDist / min_rr) + ATR-relative noise floor.
 *
 * The half-retrace TP is never widened. Instead the structural stop is additionally bounded by
 * slCap = tpDist / min_rr (tightened toward entry when geometry demands), while the noise floor
 * slFloor = max(atr_floor_multiplier × atr14, (entry_pct_floor/100) × entry) prevents a
 * hair-trigger stop: when slCap < slFloor the signal is skipped as degenerate.
 *
 * Geometry: reference = vwap × (1 + dev/100); TP = vwap + (reference − vwap) × 0.5 (half-retrace),
 * so tpDist = |TP − reference| = 0.5 × |reference − vwap|. SHORT: deviation ABOVE (reference > vwap).
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, SkipReasonEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { TAKE_PROFIT_VWAP_SIGMA_OFFSET } from '../../const';
import { IStrategyInput } from '../../interface';
import { evaluateMeanReversion } from '../meanReversionCore';

const MIN_RR = 1.5;
const ATR_FLOOR_MULTIPLIER = 0.3;
const ENTRY_PCT_FLOOR = 0.3; // percent-number → 0.3%
const NOW_MS = 1_700_000_000_000 + 5 * 60_000;

interface IOpts {
    vwap: string;
    deviationPct: number; // ABOVE (positive) → SHORT fade
    atr14: string;
    // wick distance from reference; controls the raw structural stop width.
    wickOffset: string;
}

function buildShortInput(opts: IOpts): IStrategyInput {
    const vwap = new Money(opts.vwap);
    const reference = vwap.times(new Money(1).plus(new Money(opts.deviationPct).dividedBy(100)));
    const wick = reference.plus(new Money(opts.wickOffset)); // upper band above reference for a SHORT

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
            volumeRatio: 0.8, // ≤ deceleration ratio → exhaustion confirmed
            volume20barAvg: new Money('500000').toFixed(18),
            atr14: new Money(opts.atr14).toFixed(18),
            adx14: 25,
            adxDiPlus: 20,
            adxDiMinus: 12,
            rsi14: 65,
            bollingerUpper: wick.toFixed(18),
            bollingerLower: reference.minus(new Money(opts.wickOffset)).toFixed(18),
            bollingerPctB: 0.6, // < BAND_REENTRY_UPPER_PCT_B → exhaustion confirmed
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
        params: {
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
            structural_stop_hard_cap_pct: 50.0, // very loose hard cap so slCap is the binding bound under test
            min_rr: MIN_RR,
            entry_pct_floor: ENTRY_PCT_FLOOR,
            atr_floor_multiplier: ATR_FLOOR_MULTIPLIER,
            max_tp_dist_factor: 5.0,
        } as any,
        nowMs: NOW_MS,
    };
}

function reference(opts: IOpts): MoneyValue {
    return new Money(opts.vwap).times(new Money(1).plus(new Money(opts.deviationPct).dividedBy(100)));
}

function slDistanceOf(input: IStrategyInput, opts: IOpts): MoneyValue {
    const signal = evaluateMeanReversion(input);

    return new Money(signal.proposedExit!.stopLossPrice).minus(reference(opts)).abs();
}

function tpDistanceOf(opts: IOpts): MoneyValue {
    const ref = reference(opts);
    const vwap = new Money(opts.vwap);
    const tp = vwap.plus(ref.minus(vwap).times(TAKE_PROFIT_VWAP_SIGMA_OFFSET));

    return tp.minus(ref).abs();
}

describe('meanReversionCore M47 Task 3 — SL cap + noise floor', () => {
    it('wide wick (structuralStopDist > slCap > slFloor): slDist == slCap (cap binds, R:R == min_rr)', () => {
        // vwap=100, dev=3% → reference=103, tpDist = 0.5 × 3 = 1.5, slCap = 1.5/1.5 = 1.0.
        // wickOffset=5 → structural raw stop ≈ 108 × 1.001, distance ≈ 8 ≫ slCap. hard cap is loose (50%).
        // slFloor = max(0.3×atr14, 0.3/100×103) = max(0.3×1, 0.309) = 0.309 < slCap 1.0 → not degenerate.
        const opts: IOpts = { vwap: '100', deviationPct: 3, atr14: '1', wickOffset: '5' };
        const input = buildShortInput(opts);
        const slCap = tpDistanceOf(opts).dividedBy(MIN_RR);

        expect(slDistanceOf(input, opts).toFixed()).toBe(slCap.toFixed());
    });

    it('tight wick (structuralStopDist < slCap): structural stop unchanged (cap inert)', () => {
        // vwap=100, dev=3% → reference=103, slCap = 1.0. wickOffset=0.2 → raw stop ≈ 103.2 × 1.001,
        // structural distance ≈ 0.303 < slCap 1.0, and ≥ slFloor 0.309? 0.303 < 0.309 would be degenerate.
        // Use atr14=0.5 → slFloor = max(0.15, 0.309) = 0.309; raw structural distance must exceed it.
        // wickOffset=0.5 → wick=103.5, raw = 103.5×1.001 ≈ 103.6035, distance ≈ 0.6035 (cap 1.0 inert, floor ok).
        const opts: IOpts = { vwap: '100', deviationPct: 3, atr14: '0.5', wickOffset: '0.5' };
        const input = buildShortInput(opts);

        const slDist = slDistanceOf(input, opts);
        const slCap = tpDistanceOf(opts).dividedBy(MIN_RR);

        expect(slDist.lessThan(slCap)).toBe(true);
        // Structural raw stop = (reference + wickOffset) × (1 + buffer%); distance > 0 and below the cap.
        const ref = reference(opts);
        const rawStop = ref.plus(new Money('0.5')).times(new Money(1).plus(new Money('0.1').dividedBy(100)));
        expect(slDist.toFixed()).toBe(rawStop.minus(ref).abs().toFixed());
    });

    it('tiny tpDist (slCap < slFloor): skipped as degenerate (no hair-trigger stop)', () => {
        // vwap=100, dev=0.1% → reference=100.1, tpDist = 0.5 × 0.1 = 0.05, slCap = 0.0333.
        // slFloor = max(0.3×1, 0.3/100×100.1) = max(0.3, 0.3003) = 0.3003 > slCap → degenerate.
        const opts: IOpts = { vwap: '100', deviationPct: 0.1, atr14: '1', wickOffset: '5' };
        const signal = evaluateMeanReversion(buildShortInput(opts));

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
        expect(signal.proposedExit).toBeNull();
    });

    it('ATR-binding floor: atr_floor_multiplier × atr14 > (entry_pct_floor/100) × entry, ATR floor binds', () => {
        // atr14=10 → atrFloor = 3.0; pctFloor = 0.3/100 × reference. reference≈103 → pctFloor ≈ 0.309 < 3.0.
        // slCap must fall below 3.0 to trigger the degenerate skip driven by the ATR floor.
        // dev=3% → tpDist = 1.5, slCap = 1.0 < atrFloor 3.0 → degenerate via the ATR-binding floor.
        const opts: IOpts = { vwap: '100', deviationPct: 3, atr14: '10', wickOffset: '5' };
        const signal = evaluateMeanReversion(buildShortInput(opts));

        const atrFloor = new Money('10').times(ATR_FLOOR_MULTIPLIER); // 3.0
        const pctFloor = reference(opts).times(new Money(ENTRY_PCT_FLOOR).dividedBy(100));
        expect(atrFloor.greaterThan(pctFloor)).toBe(true);
        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('pct-binding floor: near-zero ATR → (entry_pct_floor/100) × entry is the binding floor', () => {
        // atr14=0.0001 → atrFloor ≈ 0.00003; pctFloor = 0.3/100 × 103 ≈ 0.309 (the larger floor).
        // dev=0.5% → reference=100.5, tpDist = 0.25, slCap = 0.1667 < pctFloor 0.30 → degenerate via pct floor.
        const opts: IOpts = { vwap: '100', deviationPct: 0.5, atr14: '0.0001', wickOffset: '5' };
        const signal = evaluateMeanReversion(buildShortInput(opts));

        const atrFloor = new Money('0.0001').times(ATR_FLOOR_MULTIPLIER);
        const pctFloor = reference(opts).times(new Money(ENTRY_PCT_FLOOR).dividedBy(100));
        expect(pctFloor.greaterThan(atrFloor)).toBe(true);
        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('boundary: structuralStopDist == slCap exactly → cap binds and passes (not degenerate)', () => {
        // Build a wick so the raw structural distance equals slCap exactly. dev=3% → reference=103,
        // tpDist=1.5, slCap=1.0. raw stop = (reference + wickOffset) × 1.001; distance = wickOffset + reference×0.001.
        // Want distance == 1.0 → wickOffset = 1.0 − 103×0.001 = 1.0 − 0.103 = 0.897.
        const opts: IOpts = { vwap: '100', deviationPct: 3, atr14: '0.5', wickOffset: '0.897' };
        const input = buildShortInput(opts);

        const signal = evaluateMeanReversion(input);
        const slCap = tpDistanceOf(opts).dividedBy(MIN_RR);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        // At the boundary the structural distance equals slCap, so min(structural, slCap) == slCap.
        expect(slDistanceOf(input, opts).toFixed()).toBe(slCap.toFixed());
    });

    it('does not widen the half-retrace TP — only the SL is tightened', () => {
        const opts: IOpts = { vwap: '100', deviationPct: 3, atr14: '1', wickOffset: '5' };
        const signal = evaluateMeanReversion(buildShortInput(opts));
        const expectedTp = (() => {
            const ref = reference(opts);
            const vwap = new Money(opts.vwap);
            return vwap.plus(ref.minus(vwap).times(TAKE_PROFIT_VWAP_SIGMA_OFFSET));
        })();

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(new Money(signal.proposedExit!.takeProfitPrice).toFixed()).toBe(expectedTp.toFixed());
    });
});
