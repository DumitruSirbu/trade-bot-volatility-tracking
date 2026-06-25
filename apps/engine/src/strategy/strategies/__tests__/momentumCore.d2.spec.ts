/**
 * momentumCore — M43 D2 long-side-conditional TP anchor (architect adjudication 2026-06-21)
 *
 *   B1  — long RR lifted: long TP distance > old atr14 × 2.0 distance.
 *   B2  — SL untouched: stopLossPrice == event.vwapSession, stopType STRUCTURAL.
 *   B3  — cost-floor anchor: low-ATR long TP ≥ tier-aware costFloor + margin (tier1 + tier2).
 *   B4  — M38 rebase parity: tpRebaseEligible true; atrDistance == (takeProfitPrice − referencePrice).
 *   B7  — long-side-conditional: SHORT atrDistance == atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER, byte-for-byte.
 *   B8  — ATR extremes: high-ATR → atr×3.5 leg wins; low-ATR → cost-floor+margin leg wins.
 *   A1a — D1a regression: LONG trend_initiation opens; LONG catalyst_risk skips.
 *
 * B5g (gate unchanged) and B6 (determinism) are satisfied structurally — no risk-layer touch,
 * no clock/random/IO in buildMomentumExit — and are not exercised here.
 */

import {
    CoinTierEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    RegimeLabelEnum,
    SignalActionEnum,
    SkipReasonEnum,
    StopTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import {
    MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER,
    MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT,
    MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER,
    MOMENTUM_TAKER_FEE_RATE,
} from '../../const';
import { IStrategyInput } from '../../interface';
import { evaluateMomentum } from '../momentumCore';

// ─── fixture primitives ───────────────────────────────────────────────────────

// M47 Task 2: momentum now skips degenerate geometry where slDist == 0 (VWAP == reference).
// These cost-floor / ATR-leg characterizations therefore use a TINY non-zero deviation so the
// VWAP stop sits a non-zero distance from the reference (slDist > 0) while staying small enough
// that the rrFloor leg (slDist × min_rr) is inert — the ATR / cost-floor legs still dominate
// the max(), keeping the expected-distance algebra below exact.
//   reference = VWAP × (1 + DEVIATION_PCT/100); slDist = |reference − VWAP| = 0.6
//   rrFloor   = 0.6 × 1.5 = 0.9, far below the smallest base leg (SHORT atr14=1 → 2.0).
const VWAP = '60000';
const DEVIATION_PCT = 0.001;
const REFERENCE_PRICE = new Money(VWAP).times(new Money(1).plus(new Money(DEVIATION_PCT).dividedBy(100)));

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
        min_rr: 1.5,
        entry_pct_floor: 0.3,
        atr_floor_multiplier: 0.3,
        max_tp_dist_factor: 5.0,
    };
}

interface IFixtureOpts {
    side?: DeviationSideEnum;
    atr14?: string;
    coinTier?: CoinTierEnum;
    flowType?: FlowTypeEnum;
}

function buildInput(opts: IFixtureOpts = {}): IStrategyInput {
    const side = opts.side ?? DeviationSideEnum.ABOVE;
    const atr14 = opts.atr14 ?? '100';
    const coinTier = opts.coinTier ?? CoinTierEnum.TIER_1;
    const flowType = opts.flowType ?? FlowTypeEnum.TREND_INITIATION;

    return {
        event: {
            symbol: 'BTCUSDT',
            side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'BTCUSDT:1700000000000',
            vwapSession: new Money(VWAP).toFixed(18),
            vwap20bar: new Money(VWAP).toFixed(18),
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: DEVIATION_PCT,
            vwapDeviationSigma: 2.5,
            volumeRatio: 2.5,
            volume20barAvg: new Money('1000000').toFixed(18),
            atr14: new Money(atr14).toFixed(18),
            adx14: 35,
            adxDiPlus: 30,
            adxDiMinus: 10,
            rsi14: 65,
            bollingerUpper: new Money('61000').toFixed(18),
            bollingerLower: new Money('59000').toFixed(18),
            bollingerPctB: 0.9,
            btc5mMovePct: 0.5,
            idiosyncrasyScore: 0.6,
            coinTier,
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
            regimeLabel: RegimeLabelEnum.TRENDING_UP,
            marketBreadth5mUpPct: 65,
            sameBarTriggerCount: 2,
            btc1mMovePct: 0.2,
            eth5mMovePct: 0.6,
            flowType,
        } as any,
        snapshot: {
            vwap_session: VWAP,
            signal_score: 85,
            flow_type: flowType,
        } as any,
        openPosition: null,
        params: buildParams() as any,
        nowMs: 1_700_000_000_000 + 5 * 60_000,
    };
}

// Expected cost-floor leg, mirroring resolveLongCostFloorLeg (the gate's roundTripCostDistance
// + margin). Kept as an independent re-derivation so the test fails if the constants drift.
function expectedCostFloorLeg(coinTier: CoinTierEnum): MoneyValue {
    const slippagePct = coinTier === CoinTierEnum.TIER_1 ? 0.05 : coinTier === CoinTierEnum.TIER_2 ? 0.1 : 0.2;
    const slippageFraction = new Money(slippagePct).dividedBy(100);
    const feeFraction = new Money(MOMENTUM_TAKER_FEE_RATE).times(2);
    const roundTrip = REFERENCE_PRICE.times(feeFraction.plus(slippageFraction.times(2)));
    const margin = REFERENCE_PRICE.times(MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT);

    return roundTrip.plus(margin);
}

function longTpDistance(input: IStrategyInput): MoneyValue {
    const signal = evaluateMomentum(input);

    return new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);
}

// ─── B1 — long RR lifted ──────────────────────────────────────────────────────

describe('momentumCore D2 — B1: long TP distance exceeds the pre-fix atr14 × 2.0 distance', () => {
    it('tier1 LONG, atr14=100, price=60000 → TP distance > old 2.0× distance', () => {
        const distance = longTpDistance(buildInput({ atr14: '100' }));
        const oldDistance = new Money('100').times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(distance.greaterThan(oldDistance)).toBe(true);
        expect(distance.toFixed()).toBe(new Money('100').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER).toFixed());
    });
});

// ─── B2 — SL untouched ────────────────────────────────────────────────────────

describe('momentumCore D2 — B2: structural SL is unchanged by the long-TP fix', () => {
    it('LONG: stopLossPrice == event.vwapSession and stopType STRUCTURAL', () => {
        const input = buildInput();
        const signal = evaluateMomentum(input);

        expect(signal.proposedExit!.stopLossPrice.toFixed()).toBe(new Money(VWAP).toFixed());
        expect(signal.proposedExit!.stopType).toBe(StopTypeEnum.STRUCTURAL);
    });
});

// ─── B3 — cost-floor anchor ───────────────────────────────────────────────────

describe('momentumCore D2 — B3: low-ATR long TP is anchored at the tier cost floor + margin', () => {
    it('tier1 LONG, low ATR → TP distance == tier1 costFloor + margin', () => {
        const distance = longTpDistance(buildInput({ atr14: '1', coinTier: CoinTierEnum.TIER_1 }));

        expect(distance.toFixed()).toBe(expectedCostFloorLeg(CoinTierEnum.TIER_1).toFixed());
    });

    it('tier2 LONG, low ATR → TP distance == tier2 costFloor + margin (wider than tier1)', () => {
        const distance = longTpDistance(buildInput({ atr14: '1', coinTier: CoinTierEnum.TIER_2 }));
        const tier2Floor = expectedCostFloorLeg(CoinTierEnum.TIER_2);

        expect(distance.toFixed()).toBe(tier2Floor.toFixed());
        expect(tier2Floor.greaterThan(expectedCostFloorLeg(CoinTierEnum.TIER_1))).toBe(true);
    });
});

// ─── B4 — M38 rebase parity ───────────────────────────────────────────────────

describe('momentumCore D2 — B4: atrDistance carries the composite distance verbatim', () => {
    it('LONG: tpRebaseEligible false (M47 Option B); atrDistance == takeProfitPrice − referencePrice', () => {
        const input = buildInput({ atr14: '100' });
        const signal = evaluateMomentum(input);
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // M47 Task 0: rebase eligibility is off, but atrDistance still equals the composite TP distance.
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(tpDistance.toFixed());
    });

    it('LONG low-ATR (floor leg wins): atrDistance == the floor leg, not the stale 2.0× value', () => {
        const input = buildInput({ atr14: '1', coinTier: CoinTierEnum.TIER_1 });
        const signal = evaluateMomentum(input);
        const staleTwoX = new Money('1').times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(expectedCostFloorLeg(CoinTierEnum.TIER_1).toFixed());
        expect(new Money(signal.proposedExit!.atrDistance!).greaterThan(staleTwoX)).toBe(true);
    });
});

// ─── B7 — long-side-conditional (short byte-for-byte unchanged) ───────────────

describe('momentumCore D2 — B7: SHORT atrTarget/atrDistance is byte-for-byte unchanged', () => {
    it('SHORT: atrDistance == atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER exactly', () => {
        const input = buildInput({ side: DeviationSideEnum.BELOW, atr14: '100' });
        const signal = evaluateMomentum(input);
        const expected = new Money('100').times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(expected.toFixed());
    });

    it('SHORT low-ATR: cost floor does NOT lift the short distance (short ignores the floor leg)', () => {
        const input = buildInput({ side: DeviationSideEnum.BELOW, atr14: '1', coinTier: CoinTierEnum.TIER_2 });
        const signal = evaluateMomentum(input);
        const expected = new Money('1').times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(expected.toFixed());
    });
});

// ─── B8 — ATR extremes ────────────────────────────────────────────────────────

describe('momentumCore D2 — B8: long TP behaves per the ATR-extreme characterization', () => {
    it('high ATR (atr14=1000): the atr × 3.5 leg dominates → distance == atr14 × 3.5', () => {
        const distance = longTpDistance(buildInput({ atr14: '1000' }));

        expect(distance.toFixed()).toBe(new Money('1000').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER).toFixed());
        expect(distance.greaterThan(expectedCostFloorLeg(CoinTierEnum.TIER_1))).toBe(true);
    });

    it('low ATR (atr14=1): the cost-floor + margin leg dominates → distance == floor leg', () => {
        const distance = longTpDistance(buildInput({ atr14: '1' }));
        const atrLeg = new Money('1').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(distance.toFixed()).toBe(expectedCostFloorLeg(CoinTierEnum.TIER_1).toFixed());
        expect(distance.greaterThan(atrLeg)).toBe(true);
    });
});

// ─── A1a — D1a flow-routing regression ────────────────────────────────────────

describe('momentumCore D2 — A1a regression: catalyst_risk skip / trend_initiation open preserved', () => {
    it('LONG trend_initiation still opens', () => {
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.TREND_INITIATION }));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });

    it('LONG catalyst_risk skips with FLOW_ROUTED_SKIP', () => {
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.CATALYST_RISK }));

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
    });
});
