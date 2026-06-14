/**
 * meanReversionCore — M35 degenerate-VWAP skip (Finding 3 strategy origin)
 *
 * Surfaces under test (all via pure evaluateMeanReversion):
 *
 *   DV1 — Degenerate SHORT: vwapSession >= referencePrice → SKIP / DEGENERATE_VWAP_GEOMETRY
 *   DV2 — Degenerate LONG:  vwapSession <= referencePrice → SKIP / DEGENERATE_VWAP_GEOMETRY
 *   DV3 — Valid SHORT geometry (vwapSession < referencePrice + exhaustion) → OPEN (not SKIP)
 *   DV4 — Valid LONG geometry  (vwapSession > referencePrice + exhaustion) → OPEN (not SKIP)
 *   DV5 — Boundary SHORT: vwapSession === referencePrice → SKIP (guard is <=)
 *
 * EDGE/USDT price band used throughout (entry near 0.415, VWAP varied).
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, SkipReasonEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IStrategyInput } from '../../interface';
import { evaluateMeanReversion } from '../meanReversionCore';

// ─── fixture helpers ──────────────────────────────────────────────────────────

// EDGE/USDT price range. referencePrice = vwapSession * (1 + deviationPct/100).
// For SHORT: side=ABOVE, deviationPct>0, so referencePrice > vwapSession.
// For LONG:  side=BELOW, deviationPct<0, so referencePrice < vwapSession.

const EDGE_VWAP = '0.400'; // session VWAP in USDT
const EDGE_ENTRY_ABOVE = 0.415 / 0.4 - 1; // ~3.75% above VWAP for SHORT scenario
const EDGE_ENTRY_BELOW = -(1 - 0.385 / 0.4); // ~-3.75% below VWAP for LONG scenario

// A SHORT setup: price deviated ABOVE VWAP. referencePrice = 0.400 * 1.0375 ≈ 0.415.
function buildShortEvent(vwapSession: string, overrides: Partial<ReturnType<typeof buildBaseEvent>> = {}): ReturnType<typeof buildBaseEvent> {
    return {
        ...buildBaseEvent(DeviationSideEnum.ABOVE, vwapSession, EDGE_ENTRY_ABOVE),
        ...overrides,
    };
}

// A LONG setup: price deviated BELOW VWAP. referencePrice = 0.400 * (1 - 0.0375) ≈ 0.385.
function buildLongEvent(vwapSession: string, overrides: Partial<ReturnType<typeof buildBaseEvent>> = {}): ReturnType<typeof buildBaseEvent> {
    return {
        ...buildBaseEvent(DeviationSideEnum.BELOW, vwapSession, EDGE_ENTRY_BELOW),
        ...overrides,
    };
}

function buildBaseEvent(side: DeviationSideEnum, vwapSession: string, vwapDeviationPct: number) {
    const vwap = new Money(vwapSession);
    const deviation = new Money(1).plus(new Money(vwapDeviationPct).dividedBy(100));
    const referencePrice = vwap.times(deviation);

    // Bollinger bands: put them so the price looks exhausted inside the band already
    // (bollingerPctB < BAND_REENTRY_UPPER_PCT_B=0.8 for ABOVE, or > 0.2 for BELOW).
    // Using 0.6 satisfies the exhaustion-via-band-reentry path for ABOVE,
    // and 0.4 for BELOW.
    const bollingerPctB = side === DeviationSideEnum.ABOVE ? 0.6 : 0.4;
    const bollingerUpper = referencePrice.plus(new Money('0.010')).toFixed(18);
    const bollingerLower = referencePrice.minus(new Money('0.010')).toFixed(18);

    return {
        symbol: 'EDGEUSDT',
        side,
        entryCandleOpenTime: 1_700_000_000_000,
        eventId: 'EDGEUSDT:1700000000000',
        vwapSession,
        vwap20bar: vwapSession,
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct,
        vwapDeviationSigma: 2.1,
        volumeRatio: 0.8, // <= VOLUME_DECELERATION_RATIO=1.0 → exhaustion confirmed
        volume20barAvg: new Money('500000').toFixed(18),
        atr14: new Money('0.010').toFixed(18),
        adx14: 25,
        adxDiPlus: 20,
        adxDiMinus: 12,
        rsi14: 65,
        bollingerUpper,
        bollingerLower,
        bollingerPctB,
        btc5mMovePct: 0.1,
        idiosyncrasyScore: 0.2, // below idiosyncrasy_min_score=0.3 → no idiosyncratic trap
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 10,
        symbolUniverseAgeHours: 200,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.1,
        openInterest: new Money('5000000').toFixed(18),
        openInterestChange5mPct: -0.1, // <= OI_NOT_RISING_THRESHOLD_PCT=0 → exhaustion confirmed
        openInterestChange15mPct: -0.2,
        aggTradeBuyVolumeRatio: 0.4,
        bidAskSpreadPct: 0.05,
        bookDepth10bpsUsdt: new Money('20000').toFixed(18),
        bookDepth50bpsUsdt: new Money('50000').toFixed(18),
        regimeLabel: RegimeLabelEnum.RANGING, // no regime suppression
        marketBreadth5mUpPct: 50,
        sameBarTriggerCount: 2,
        btc1mMovePct: 0.05,
        eth5mMovePct: 0.1,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

function buildSnapshot(vwapSession: string) {
    return {
        vwap_session: vwapSession,
        vwap_20bar: vwapSession,
        vwap_deviation_pct: 3.75,
        vwap_deviation_sigma: 2.1,
        volume_ratio: 0.8,
        volume_20bar_avg: '500000',
        atr_14: '0.010',
        adx_14: 25,
        adx_di_plus: 20,
        adx_di_minus: 12,
        rsi_14: 65,
        bollinger_upper: '0.425',
        bollinger_lower: '0.375',
        bollinger_pct_b: 0.6,
        btc_5m_move_pct: 0.1,
        btc_1m_move_pct: 0.05,
        eth_5m_move_pct: 0.1,
        market_breadth_5m_up_pct: 50,
        same_bar_trigger_count: 2,
        open_interest_change_5m_pct: -0.1,
        open_interest_change_15m_pct: -0.2,
        open_interest: '5000000',
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        bid_ask_spread_pct: 0.05,
        estimated_slippage_pct: 0.04,
        book_depth_10bps_usdt: '20000',
        book_depth_50bps_usdt: '50000',
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 10,
        correlation_mode: 'idiosyncratic',
        signal_score: 75,
        position_slot: 'A',
        active_positions_count: 0,
        regime_label: 'ranging',
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.4,
        idiosyncrasy_score: 0.2,
        vwap_anchor_type: 'session',
        symbol_universe_age_hours: 200,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
    } as any; // test boundary: partial snapshot fixture for pure-function unit test
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
        btc_correlated_move_threshold_pct: 1.5,
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

function buildInput(event: ReturnType<typeof buildBaseEvent>): IStrategyInput {
    return {
        event: event as any,
        snapshot: buildSnapshot(event.vwapSession),
        openPosition: null,
        params: buildParams() as any,
        nowMs: event.entryCandleOpenTime + 5 * 60_000,
    };
}

// ─── DV1: Degenerate SHORT — vwapSession >= referencePrice → SKIP ─────────────

describe('meanReversionCore M35 — DV1: degenerate SHORT (vwapSession >= referencePrice) → SKIP / DEGENERATE_VWAP_GEOMETRY', () => {
    it('SHORT geometry with vwapSession above entry → skips with DEGENERATE_VWAP_GEOMETRY', () => {
        // SHORT: referencePrice = vwapSession * (1 + deviationPct/100).
        // For degenerate: set vwapSession ABOVE the deviated price. We do this by using
        // deviationPct = -0.01 (very slight below) so referencePrice is BELOW vwapSession,
        // but the event side=ABOVE implies SHORT. The guard: SHORT is degenerate when
        // vwap.lessThanOrEqualTo(referencePrice), i.e. vwap <= entry.
        // Here we place vwapSession = entry exactly, so vwapSession=referencePrice → degenerate.

        // With deviationPct=3.75%, entry=0.415, vwap=0.400, referencePrice≈0.415.
        // Now set vwapSession=0.415 so vwap >= referencePrice → degenerate.
        const vwapAboveEntry = '0.415';
        const deviationPct = 0.0; // referencePrice = vwap * 1.000 = 0.415 exactly; vwap >= referencePrice

        const event = {
            ...buildBaseEvent(DeviationSideEnum.ABOVE, vwapAboveEntry, deviationPct),
            vwapDeviationPct: deviationPct,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('SHORT: vwapSession strictly above referencePrice (entry) → DEGENERATE_VWAP_GEOMETRY', () => {
        // vwapDeviationPct=-2% → referencePrice = 0.420 * 0.98 = 0.4116 < vwap=0.420 → degenerate for SHORT.
        const vwapHigher = '0.420';
        const negativeDeviation = -2.0; // price dumped BELOW vwap, but event.side=ABOVE → invalid pairing, guard fires

        const event = {
            ...buildBaseEvent(DeviationSideEnum.ABOVE, vwapHigher, negativeDeviation),
            vwapDeviationPct: negativeDeviation,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });
});

// ─── DV2: Degenerate LONG — vwapSession <= referencePrice → SKIP ─────────────

describe('meanReversionCore M35 — DV2: degenerate LONG (vwapSession <= referencePrice) → SKIP / DEGENERATE_VWAP_GEOMETRY', () => {
    it('LONG geometry with vwapSession below entry → skips with DEGENERATE_VWAP_GEOMETRY', () => {
        // LONG: side=BELOW, deviationPct negative, referencePrice = vwap*(1-3.75%) ≈ 0.385.
        // Degenerate: vwap.greaterThanOrEqualTo(referencePrice) → vwap >= entry.
        // We set vwapSession=0.385 so vwap ≤ referencePrice=0.385.
        const vwapBelowEntry = '0.385';
        const deviationPct = 0.0; // referencePrice = vwap exactly; vwap <= referencePrice → degenerate

        const event = {
            ...buildBaseEvent(DeviationSideEnum.BELOW, vwapBelowEntry, deviationPct),
            vwapDeviationPct: deviationPct,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('LONG: vwapSession strictly below referencePrice → DEGENERATE_VWAP_GEOMETRY', () => {
        // Corrected guard (post-fix): LONG is degenerate when vwap.lessThanOrEqualTo(referencePrice),
        // i.e., VWAP is at or below the entry price. The reversion TP is drawn from entry toward VWAP;
        // when VWAP sits below (or at) entry, the "toward VWAP" direction is downward — the opposite of
        // what a LONG position needs.
        //
        // Fixture: side=BELOW, deviationPct=+3% (anomalous pairing — price above VWAP but
        // the event was classified as a BELOW deviation). referencePrice = vwap * 1.03 > vwap.
        // vwap.lessThanOrEqualTo(referencePrice): 0.400 <= 0.412 → TRUE → DEGENERATE.
        const vwapSession = '0.400';
        const positiveDeviationWithBelowSide = 3.0; // referencePrice = 0.400 * 1.03 = 0.412 > vwap=0.400

        const event = {
            ...buildBaseEvent(DeviationSideEnum.BELOW, vwapSession, positiveDeviationWithBelowSide),
            vwapDeviationPct: positiveDeviationWithBelowSide,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });
});

// ─── DV3: Valid SHORT geometry → not SKIP ─────────────────────────────────────

describe('meanReversionCore M35 — DV3: valid SHORT geometry (vwapSession < referencePrice + exhaustion) → OPEN action', () => {
    it('SHORT: vwapSession clearly below deviated price with exhaustion confirmed → OPEN signal', () => {
        // Normal SHORT: vwap=0.400, deviation=3.75% → referencePrice=0.400*1.0375≈0.415.
        // vwap(0.400) < referencePrice(0.415) → NOT degenerate → valid.
        // Exhaustion: volumeRatio=0.8 <= 1.0 → confirmed.
        const event = buildShortEvent(EDGE_VWAP);
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.OPEN);
        expect(result.skipReason).toBeNull();
    });

    it('SHORT: TP target is below entry (valid direction for SHORT)', () => {
        const event = buildShortEvent(EDGE_VWAP);
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.OPEN);
        // TP = vwap + (referencePrice - vwap) * 0.5 = 0.400 + (0.415 - 0.400) * 0.5 = 0.4075
        // entry = 0.415, TP = 0.4075 → TP < entry (correct SHORT direction)
        if (result.proposedExit !== null) {
            const entry = new Money(EDGE_VWAP).times(new Money(1).plus(new Money(EDGE_ENTRY_ABOVE).dividedBy(100)));
            expect(result.proposedExit.takeProfitPrice.lessThan(entry)).toBe(true);
        }
    });
});

// ─── DV4: Valid LONG geometry → not SKIP ──────────────────────────────────────

describe('meanReversionCore M35 — DV4: valid LONG geometry (vwapSession > referencePrice + exhaustion) → OPEN action', () => {
    it('LONG: vwapSession clearly above deviated price with exhaustion confirmed → OPEN signal', () => {
        // Normal LONG: vwap=0.400, deviation=-3.75% → referencePrice=0.400*0.9625≈0.385.
        // vwap(0.400) > referencePrice(0.385) → NOT degenerate → valid.
        // Exhaustion: volumeRatio=0.8 → confirmed.
        const event = buildLongEvent(EDGE_VWAP);
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.OPEN);
        expect(result.skipReason).toBeNull();
    });

    it('LONG: TP target is above entry (valid direction for LONG)', () => {
        const event = buildLongEvent(EDGE_VWAP);
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.OPEN);
        if (result.proposedExit !== null) {
            const entry = new Money(EDGE_VWAP).times(new Money(1).plus(new Money(EDGE_ENTRY_BELOW).dividedBy(100)));
            expect(result.proposedExit.takeProfitPrice.greaterThan(entry)).toBe(true);
        }
    });
});

// ─── DV5: Boundary SHORT — vwapSession === referencePrice → SKIP ──────────────

describe('meanReversionCore M35 — DV5: boundary SHORT (vwapSession exactly equals referencePrice) → SKIP (guard uses <=)', () => {
    it('SHORT: vwapSession exactly equals referencePrice → SKIP / DEGENERATE_VWAP_GEOMETRY', () => {
        // isDegenerateReversionGeometry SHORT: vwap.lessThanOrEqualTo(referencePrice).
        // At equality: vwap === referencePrice → lessThanOrEqualTo returns true → degenerate.
        // Set deviationPct=0% → referencePrice = vwap * 1.000 = vwap exactly.
        const vwapSession = '0.415';
        const deviationPctZero = 0.0;

        const event = {
            ...buildBaseEvent(DeviationSideEnum.ABOVE, vwapSession, deviationPctZero),
            vwapDeviationPct: deviationPctZero,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('LONG: vwapSession exactly equals referencePrice → SKIP / DEGENERATE_VWAP_GEOMETRY', () => {
        // isDegenerateReversionGeometry LONG: vwap.greaterThanOrEqualTo(referencePrice).
        // At equality → degenerate.
        const vwapSession = '0.385';
        const deviationPctZero = 0.0;

        const event = {
            ...buildBaseEvent(DeviationSideEnum.BELOW, vwapSession, deviationPctZero),
            vwapDeviationPct: deviationPctZero,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        expect(result.action).toBe(SignalActionEnum.SKIP);
        expect(result.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('SHORT: vwapSession one tick below referencePrice (just valid) → OPEN, not SKIP', () => {
        // At vwapDeviationPct=0.01%, referencePrice = vwap * 1.0001 > vwap → valid SHORT geometry.
        const vwapSession = '0.415';
        const tinyPositiveDev = 0.01;

        const event = {
            ...buildBaseEvent(DeviationSideEnum.ABOVE, vwapSession, tinyPositiveDev),
            vwapDeviationPct: tinyPositiveDev,
        };
        const input = buildInput(event);
        const result = evaluateMeanReversion(input);

        // referencePrice = 0.415 * 1.0001 = 0.4150415 > vwap=0.415 → not degenerate → OPEN
        expect(result.action).toBe(SignalActionEnum.OPEN);
        expect(result.skipReason).toBeNull();
    });
});

// ─── DV6: Determinism — same input, same output ───────────────────────────────

describe('meanReversionCore M35 — DV6: determinism (pure function — no I/O, no randomness)', () => {
    it('identical input produces identical SKIP output on repeated calls', () => {
        const event = {
            ...buildBaseEvent(DeviationSideEnum.ABOVE, '0.415', 0.0),
            vwapDeviationPct: 0.0,
        };
        const input = buildInput(event);

        const first = evaluateMeanReversion(input);
        const second = evaluateMeanReversion(input);
        const third = evaluateMeanReversion(input);

        expect(first.action).toBe(second.action);
        expect(second.action).toBe(third.action);
        expect(first.skipReason).toBe(second.skipReason);
        expect(second.skipReason).toBe(third.skipReason);
    });

    it('identical input produces identical OPEN output with matching TP/SL prices on repeated calls', () => {
        const event = buildShortEvent(EDGE_VWAP);
        const input = buildInput(event);

        const first = evaluateMeanReversion(input);
        const second = evaluateMeanReversion(input);

        expect(first.action).toBe(second.action);
        expect(first.proposedExit?.takeProfitPrice.toFixed(18)).toBe(second.proposedExit?.takeProfitPrice.toFixed(18));
        expect(first.proposedExit?.stopLossPrice.toFixed(18)).toBe(second.proposedExit?.stopLossPrice.toFixed(18));
    });
});
