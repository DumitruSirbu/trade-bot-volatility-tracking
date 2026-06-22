/**
 * Strategy exit fields — M38 D1 contract (ADR 0045)
 *
 * Verifies that each strategy producer sets the M38 IProposedExit fields correctly:
 *
 *   SC1 — momentumCore: tpRebaseEligible=true on an OPEN signal
 *   SC2 — momentumCore: atrDistance = atr14 * MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER (exact value)
 *   SC3 — momentumCore: atrDistance is the SAME object as the TP distance used inside the strategy
 *          (not re-derived — single source of truth)
 *   SC4 — momentumCore: tpRebaseEligible=true and atrDistance != null on both LONG and SHORT opens
 *   SC5 — momentumCore: SKIP signal has proposedExit=null (fields not set on skip)
 *   SC6 — meanReversionCore: tpRebaseEligible=false on an OPEN signal
 *   SC7 — meanReversionCore: atrDistance=null on an OPEN signal
 *   SC8 — meanReversionCore: SKIP signal has proposedExit=null (fields not set on skip)
 *   SC9 — meanReversionCore: tpRebaseEligible=false + atrDistance=null on both LONG and SHORT opens
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER } from '../../const';
import { IStrategyInput } from '../../interface';
import { evaluateMomentum } from '../momentumCore';
import { evaluateMeanReversion } from '../meanReversionCore';

// ─── shared params fixture ────────────────────────────────────────────────────

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

// ─── momentumCore fixtures ────────────────────────────────────────────────────

const MOMENTUM_VWAP = '50000';
const MOMENTUM_ATR14 = '100';
const MOMENTUM_DEVIATION_PCT = 1.5; // ABOVE → LONG momentum (follow the breakout)

function buildMomentumEvent(side: DeviationSideEnum = DeviationSideEnum.ABOVE, deviationPct = MOMENTUM_DEVIATION_PCT) {
    return {
        symbol: 'BTCUSDT',
        side,
        entryCandleOpenTime: 1_700_000_000_000,
        eventId: 'BTCUSDT:1700000000000',
        vwapSession: new Money(MOMENTUM_VWAP).toFixed(18),
        vwap20bar: new Money(MOMENTUM_VWAP).toFixed(18),
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: deviationPct,
        vwapDeviationSigma: 2.5,
        volumeRatio: 2.5,
        volume20barAvg: new Money('1000000').toFixed(18),
        atr14: new Money(MOMENTUM_ATR14).toFixed(18),
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
        regimeLabel: RegimeLabelEnum.TRENDING_UP, // Trending: momentum not suppressed
        marketBreadth5mUpPct: 65,
        sameBarTriggerCount: 2,
        btc1mMovePct: 0.2,
        eth5mMovePct: 0.6,
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildMomentumSnapshot() {
    return {
        vwap_session: MOMENTUM_VWAP,
        vwap_20bar: MOMENTUM_VWAP,
        vwap_deviation_pct: MOMENTUM_DEVIATION_PCT,
        vwap_deviation_sigma: 2.5,
        volume_ratio: 2.5,
        volume_20bar_avg: '1000000',
        atr_14: MOMENTUM_ATR14,
        adx_14: 35,
        adx_di_plus: 30,
        adx_di_minus: 10,
        rsi_14: 65,
        bollinger_upper: '51000',
        bollinger_lower: '49000',
        bollinger_pct_b: 0.9,
        btc_5m_move_pct: 0.5,
        btc_1m_move_pct: 0.2,
        eth_5m_move_pct: 0.6,
        market_breadth_5m_up_pct: 65,
        same_bar_trigger_count: 2,
        open_interest_change_5m_pct: 0.5,
        open_interest_change_15m_pct: 1.0,
        open_interest: '9000000',
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        bid_ask_spread_pct: 0.02,
        estimated_slippage_pct: 0.03,
        book_depth_10bps_usdt: '500000',
        book_depth_50bps_usdt: '1000000',
        coin_tier: 'tier_1' as any,
        coin_volume_rank: 1,
        correlation_mode: 'idiosyncratic' as any,
        signal_score: 85,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.65,
        idiosyncrasy_score: 0.6,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 200,
        flow_type: 'trend_initiation' as any,
    };
}

function buildMomentumInput(side = DeviationSideEnum.ABOVE, deviationPct = MOMENTUM_DEVIATION_PCT): IStrategyInput {
    return {
        event: buildMomentumEvent(side, deviationPct) as any,
        snapshot: buildMomentumSnapshot() as any,
        openPosition: null,
        params: buildParams() as any,
        nowMs: 1_700_000_000_000 + 5 * 60_000,
    };
}

// ─── meanReversionCore fixtures ───────────────────────────────────────────────

const MR_VWAP = '0.400';
const MR_DEVIATION_ABOVE = 3.75; // ~3.75% above VWAP → SHORT fade
const MR_DEVIATION_BELOW = -3.75; // ~3.75% below VWAP → LONG fade

function buildMeanReversionInput(side: DeviationSideEnum): IStrategyInput {
    const deviationPct = side === DeviationSideEnum.ABOVE ? MR_DEVIATION_ABOVE : MR_DEVIATION_BELOW;
    const vwap = new Money(MR_VWAP);
    const deviation = new Money(1).plus(new Money(deviationPct).dividedBy(100));
    const referencePrice = vwap.times(deviation);

    // bollingerPctB to trigger band-reentry exhaustion
    const bollingerPctB = side === DeviationSideEnum.ABOVE ? 0.6 : 0.4;

    return {
        event: {
            symbol: 'EDGEUSDT',
            side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'EDGEUSDT:1700000000000',
            vwapSession: MR_VWAP,
            vwap20bar: MR_VWAP,
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: deviationPct,
            vwapDeviationSigma: 2.1,
            volumeRatio: 0.8, // ≤ VOLUME_DECELERATION_RATIO → exhaustion confirmed
            volume20barAvg: new Money('500000').toFixed(18),
            atr14: new Money('0.010').toFixed(18),
            adx14: 25,
            adxDiPlus: 20,
            adxDiMinus: 12,
            rsi14: 65,
            bollingerUpper: referencePrice.plus(new Money('0.010')).toFixed(18),
            bollingerLower: referencePrice.minus(new Money('0.010')).toFixed(18),
            bollingerPctB,
            btc5mMovePct: 0.1,
            idiosyncrasyScore: 0.2, // below idiosyncrasy_min_score=0.3
            coinTier: CoinTierEnum.TIER_1,
            coinVolumeRank: 10,
            symbolUniverseAgeHours: 200,
            fundingRate: 0.0001,
            fundingRateAnnualized: 0.1,
            openInterest: new Money('5000000').toFixed(18),
            openInterestChange5mPct: -0.1, // ≤ 0 → OI not rising → exhaustion confirmed
            openInterestChange15mPct: -0.2,
            aggTradeBuyVolumeRatio: 0.4,
            bidAskSpreadPct: 0.05,
            bookDepth10bpsUsdt: new Money('20000').toFixed(18),
            bookDepth50bpsUsdt: new Money('50000').toFixed(18),
            regimeLabel: RegimeLabelEnum.RANGING, // no regime suppression in ranging
            marketBreadth5mUpPct: 50,
            sameBarTriggerCount: 2,
            btc1mMovePct: 0.05,
            eth5mMovePct: 0.1,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        } as any,
        snapshot: {
            vwap_session: MR_VWAP,
            signal_score: 75,
            flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        } as any,
        openPosition: null,
        params: buildParams() as any,
        nowMs: 1_700_000_000_000 + 5 * 60_000,
    };
}

// ─── SC1: momentumCore sets tpRebaseEligible=true ────────────────────────────

describe('strategyExitFields M38 — SC1: momentumCore OPEN signal has tpRebaseEligible=true', () => {
    it('LONG momentum open: proposedExit.tpRebaseEligible is true', () => {
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.ABOVE));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.tpRebaseEligible).toBe(true);
    });

    it('SHORT momentum open: proposedExit.tpRebaseEligible is true', () => {
        // SHORT momentum: price fell below VWAP (BELOW deviation), follow down
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.BELOW, -MOMENTUM_DEVIATION_PCT));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.tpRebaseEligible).toBe(true);
    });
});

// ─── SC2: momentumCore atrDistance = atr14 * MULTIPLIER (exact value) ─────────

describe('strategyExitFields M38 — SC2: momentumCore atrDistance equals atr14 * MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER exactly', () => {
    it('LONG momentum: atrDistance = atr14 * LONG MULTIPLIER (exact decimal comparison)', () => {
        // M43 D2: the LONG side uses MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER (3.5). With this
        // fixture (atr14=100, ref≈50750) the atr×3.5 leg (350) dominates the tier1 cost floor,
        // so atrDistance is the ATR leg. SHORT-side 2.0× parity is asserted in SC2's SHORT case
        // below and in momentumCore.d2.spec.ts (B7).
        const atr14 = '100';
        const input = buildMomentumInput(DeviationSideEnum.ABOVE);
        // Ensure the event carries our known ATR
        (input.event as any).atr14 = new Money(atr14).toFixed(18);

        const signal = evaluateMomentum(input);

        expect(signal.proposedExit).not.toBeNull();

        const expectedDistance = new Money(atr14).times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);
        const actualDistance = signal.proposedExit!.atrDistance;

        expect(actualDistance).not.toBeNull();
        expect(actualDistance!.toFixed(18)).toBe(expectedDistance.toFixed(18));
    });

    it('SHORT momentum: atrDistance = atr14 * MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER (2.0×, unchanged by D2)', () => {
        const atr14 = '100';
        const input = buildMomentumInput(DeviationSideEnum.BELOW, -MOMENTUM_DEVIATION_PCT);
        (input.event as any).atr14 = new Money(atr14).toFixed(18);

        const signal = evaluateMomentum(input);
        const expectedDistance = new Money(atr14).times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(signal.proposedExit!.atrDistance!.toFixed(18)).toBe(expectedDistance.toFixed(18));
    });

    it('atrDistance is non-null for momentum open (required for D1 rebase at arm seam)', () => {
        const signal = evaluateMomentum(buildMomentumInput());

        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.atrDistance).not.toBeNull();
    });

    it('atrDistance is the ATR distance ONLY — NOT the full TP price', () => {
        const atr14 = '100';
        const input = buildMomentumInput();
        (input.event as any).atr14 = new Money(atr14).toFixed(18);

        const signal = evaluateMomentum(input);

        const distance = signal.proposedExit!.atrDistance!;
        const tp = signal.proposedExit!.takeProfitPrice;

        // Distance should be much smaller than TP price (TP is near VWAP+ATR, distance is just ATR*multiplier)
        expect(new Money(distance).lessThan(new Money(tp))).toBe(true);
        // M43 D2 LONG: distance = atr14 * LONG MULTIPLIER = 100 * 3.5 = 350 (not the ~50700 TP price)
        expect(distance.toFixed(2)).toBe('350.00');
    });
});

// ─── SC3: momentumCore atrDistance is the same as the TP-offset distance ──────

describe('strategyExitFields M38 — SC3: momentumCore atrDistance is consistent with takeProfitPrice offset from VWAP reference', () => {
    it('LONG: takeProfitPrice - referencePrice equals atrDistance (same distance, different anchors)', () => {
        // The strategy computes: TP = referencePrice + atrDistance.
        // Therefore: TP - referencePrice = atrDistance.
        const input = buildMomentumInput(DeviationSideEnum.ABOVE);
        const vwapSession = (input.event as any).vwapSession;
        const deviationPct = (input.event as any).vwapDeviationPct;

        const signal = evaluateMomentum(input);
        expect(signal.proposedExit).not.toBeNull();

        // Reconstruct referencePrice the same way momentumCore does
        const referencePrice = new Money(vwapSession).times(new Money(1).plus(new Money(deviationPct).dividedBy(100)));

        const tp = new Money(signal.proposedExit!.takeProfitPrice);
        const distance = new Money(signal.proposedExit!.atrDistance!);

        // For LONG: TP = referencePrice + distance → distance = TP - referencePrice
        const impliedDistance = tp.minus(referencePrice);
        expect(impliedDistance.toFixed(6)).toBe(distance.toFixed(6));
    });
});

// ─── SC4: momentumCore sets fields on both LONG and SHORT opens ───────────────

describe('strategyExitFields M38 — SC4: momentumCore sets tpRebaseEligible=true and non-null atrDistance on both sides', () => {
    it('LONG open has tpRebaseEligible=true and non-null atrDistance', () => {
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.ABOVE));

        expect(signal.proposedExit!.tpRebaseEligible).toBe(true);
        expect(signal.proposedExit!.atrDistance).not.toBeNull();
    });

    it('SHORT open has tpRebaseEligible=true and non-null atrDistance', () => {
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.BELOW, -MOMENTUM_DEVIATION_PCT));

        expect(signal.proposedExit!.tpRebaseEligible).toBe(true);
        expect(signal.proposedExit!.atrDistance).not.toBeNull();
    });
});

// ─── SC5: momentumCore SKIP has proposedExit=null ────────────────────────────

describe('strategyExitFields M38 — SC5: momentumCore SKIP signal has proposedExit=null (no fields to check)', () => {
    it('SKIP from RANGING regime has proposedExit=null', () => {
        const input = buildMomentumInput();
        // Override regime to RANGING → momentum suppressed
        (input.event as any).regimeLabel = RegimeLabelEnum.RANGING;

        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.proposedExit).toBeNull();
    });
});

// ─── SC6: meanReversionCore sets tpRebaseEligible=false ───────────────────────

describe('strategyExitFields M38 — SC6: meanReversionCore OPEN signal has tpRebaseEligible=false', () => {
    it('SHORT reversion open: proposedExit.tpRebaseEligible is false', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.ABOVE));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
    });

    it('LONG reversion open: proposedExit.tpRebaseEligible is false', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.BELOW));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
    });
});

// ─── SC7: meanReversionCore sets atrDistance=null ─────────────────────────────

describe('strategyExitFields M38 — SC7: meanReversionCore OPEN signal has atrDistance=null', () => {
    it('SHORT reversion open: proposedExit.atrDistance is null', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.ABOVE));

        expect(signal.proposedExit!.atrDistance).toBeNull();
    });

    it('LONG reversion open: proposedExit.atrDistance is null', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.BELOW));

        expect(signal.proposedExit!.atrDistance).toBeNull();
    });
});

// ─── SC8: meanReversionCore SKIP has proposedExit=null ────────────────────────

describe('strategyExitFields M38 — SC8: meanReversionCore SKIP signal has proposedExit=null', () => {
    it('regime-suppressed SHORT in TRENDING_UP has proposedExit=null', () => {
        const input = buildMeanReversionInput(DeviationSideEnum.ABOVE);
        // SHORT fade suppressed in uptrend
        (input.event as any).regimeLabel = RegimeLabelEnum.TRENDING_UP;

        const signal = evaluateMeanReversion(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.proposedExit).toBeNull();
    });
});

// ─── SC9: meanReversionCore fields on both sides ──────────────────────────────

describe('strategyExitFields M38 — SC9: meanReversionCore tpRebaseEligible=false + atrDistance=null on both LONG and SHORT', () => {
    it('SHORT fade has tpRebaseEligible=false and atrDistance=null', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.ABOVE));

        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
        expect(signal.proposedExit!.atrDistance).toBeNull();
    });

    it('LONG fade has tpRebaseEligible=false and atrDistance=null', () => {
        const signal = evaluateMeanReversion(buildMeanReversionInput(DeviationSideEnum.BELOW));

        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
        expect(signal.proposedExit!.atrDistance).toBeNull();
    });
});
