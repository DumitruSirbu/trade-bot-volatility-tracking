/**
 * momentumCore — M43 D2 + D1a adversarial edge-case coverage
 *
 * These tests cover failure modes the implementer's happy-path suite (momentumCore.d2.spec.ts)
 * and strategyExitFields.m38.spec.ts do NOT cover. Each test targets one specific
 * implementation risk and is named after exactly what breaks if it fails.
 *
 * Cases covered:
 *
 *   ADV-1 — D1a scope boundary: forced_exhaustion is NOT skipped by D1a (negative)
 *            Only catalyst_risk routes to FLOW_ROUTED_SKIP; forced_exhaustion must still
 *            reach OPEN in a trending regime. D1b (v3 promotion) owns the forced_exhaustion
 *            fade; D1a is subtractive-only and must not touch it.
 *
 *   ADV-2 — D1a fires before D2 TP logic: catalyst_risk skip is ATR-value-agnostic
 *            A catalyst_risk event skips regardless of whether atr14 is pathologically
 *            low ('0.001') or pathologically high ('10000'). If D1a were after buildMomentumExit
 *            (wrong order) a bad ATR could crash or produce a nonsensical TP before the skip.
 *
 *   ADV-3 — D2 max() branch at crossover: cost-floor leg wins just below, ATR leg wins just above
 *            The implementer tested ATR=1 (clearly floor) and ATR=1000 (clearly ATR). This tests
 *            the CROSSOVER POINT algebraically derived from the known constants:
 *              floor + margin = ref × 0.0048 = 60000 × 0.0048 = 288
 *              ATR crossover: atr × 3.5 = 288 → atr = 82.2857…
 *              atr=82 → 82 × 3.5 = 287 < 288 → floor wins
 *              atr=83 → 83 × 3.5 = 290.5 > 288 → ATR wins
 *
 *   ADV-4 — D2 short wrong-side guard: SHORT takeProfitPrice is strictly below referencePrice
 *            The short TP is referencePrice − atr×2.0. For any positive ATR this must be below
 *            entry. Asserting takeProfitPrice < referencePrice pins the direction invariant
 *            explicitly — the existing SC2 checks the distance magnitude but not the direction.
 *
 *   ADV-5 — D2 decimal / M38 parity: atrDistance == |takeProfitPrice − referencePrice| when
 *            the FLOOR leg wins (not only when the ATR leg wins as in B4)
 *            The highest-risk implementation mistake is threading the ATR leg into atrDistance
 *            while applying the floor to takeProfitPrice. This would silently break the M38
 *            rebase contract whenever the floor leg is the winning leg.
 *
 * Failure routing: if any test here fails and it is NOT a test-fixture issue, route to the
 * architect per dev-qa-cycle.md §2.2 — do NOT loop back to the developer.
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, SkipReasonEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT, MOMENTUM_TAKER_FEE_RATE } from '../../const';
import { IStrategyInput } from '../../interface';
import { evaluateMomentum } from '../momentumCore';

// ─── fixture primitives ───────────────────────────────────────────────────────

// deviationPct = 0 → referencePrice == vwapSession exactly.
// The momentum follow-side branches on `side` (ABOVE → LONG, BELOW → SHORT),
// so a 0% deviation still routes the correct trade side.
const VWAP = '60000';
const REFERENCE_PRICE = new Money(VWAP);

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
        // Tier1 slippage = 0.05% → slippage fraction = 0.0005
        // Round-trip cost = 2 × fee + 2 × slippage = 2×0.0004 + 2×0.0005 = 0.0018
        // costFloor leg = ref × 0.0018 + ref × 0.001 (margin) = ref × 0.0028
        // Wait — the spec uses 0.15% for tier1 slippage in the algebra; the .d2.spec.ts
        // uses 0.05. We keep 0.05 here (matching .d2.spec.ts) and re-derive precisely.
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

interface IFixtureOpts {
    side?: DeviationSideEnum;
    atr14?: string;
    coinTier?: CoinTierEnum;
    flowType?: FlowTypeEnum;
    regimeLabel?: RegimeLabelEnum;
}

function buildInput(opts: IFixtureOpts = {}): IStrategyInput {
    const side = opts.side ?? DeviationSideEnum.ABOVE;
    const atr14 = opts.atr14 ?? '100';
    const coinTier = opts.coinTier ?? CoinTierEnum.TIER_1;
    const flowType = opts.flowType ?? FlowTypeEnum.TREND_INITIATION;
    const regimeLabel = opts.regimeLabel ?? RegimeLabelEnum.TRENDING_UP;

    return {
        event: {
            symbol: 'BTCUSDT',
            side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'BTCUSDT:1700000000000',
            vwapSession: REFERENCE_PRICE.toFixed(18),
            vwap20bar: REFERENCE_PRICE.toFixed(18),
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: 0,
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
            regimeLabel,
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

// Independently derive the tier-aware cost-floor leg distance (mirrors resolveLongCostFloorLeg).
// slippage_tier1_pct = 0.05 → slippageFraction = 0.05/100 = 0.0005
// fee fraction per leg = 0.0004 → 2 × fee = 0.0008
// 2 × slippage = 0.001
// roundTripCostDistance = ref × (0.0008 + 0.001) = ref × 0.0018
// margin = ref × MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT = ref × 0.001
// floor leg = ref × (0.0018 + 0.001) = ref × 0.0028
function deriveTier1CostFloorLeg(): MoneyValue {
    const feeFraction = new Money(MOMENTUM_TAKER_FEE_RATE).times(2);
    const slippageFraction = new Money('0.05').dividedBy(100).times(2);
    const roundTripCostDistance = REFERENCE_PRICE.times(feeFraction.plus(slippageFraction));
    const margin = REFERENCE_PRICE.times(MOMENTUM_LONG_TP_COST_FLOOR_MARGIN_PCT);

    return roundTripCostDistance.plus(margin);
}

// ─── ADV-1 — forced_exhaustion is NOT skipped by D1a ─────────────────────────

describe('momentumCore D1a adversarial — ADV-1: forced_exhaustion is not routed to skip by D1a', () => {
    // D1a (M43) adds `catalyst_risk → FLOW_ROUTED_SKIP` to v2. The spec explicitly
    // excludes forced_exhaustion from D1a scope (it belongs to D1b via the mean-reversion
    // core). If the implementer accidentally extended the skip guard to forced_exhaustion,
    // these tests catch it.
    it('LONG forced_exhaustion in a trending regime returns OPEN, not SKIP', () => {
        // BUILD: forced_exhaustion is the second mis-route family but is NOT skipped in D1a
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }));

        // CHECK: must open, not skip
        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });

    it('LONG forced_exhaustion does not produce FLOW_ROUTED_SKIP (anti-coverage: skip reason absent)', () => {
        // BUILD
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }));

        // CHECK: skipReason is null on an OPEN signal, not FLOW_ROUTED_SKIP
        expect(signal.skipReason).toBeNull();
        expect(signal.skipReason).not.toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
    });

    it('SHORT forced_exhaustion in a trending-down regime returns OPEN, not SKIP', () => {
        // BUILD: deviation BELOW → SHORT follow signal
        const signal = evaluateMomentum(
            buildInput({
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                side: DeviationSideEnum.BELOW,
                regimeLabel: RegimeLabelEnum.TRENDING_DOWN,
            }),
        );

        // CHECK: D1a scope is catalyst_risk only — forced_exhaustion follows through on both sides
        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });
});

// ─── ADV-2 — D1a fires before D2 TP logic: skip is ATR-value-agnostic ─────────

describe('momentumCore D1a adversarial — ADV-2: catalyst_risk skip is ATR-value-agnostic (fires before buildMomentumExit)', () => {
    // If D1a's guard were placed AFTER buildMomentumExit (wrong order), a pathological
    // atr14 could crash or produce a nonsensical TP before the skip short-circuits.
    // These tests assert the skip path is reached regardless of ATR value, which is only
    // possible when the guard fires BEFORE the TP computation.

    it('catalyst_risk with pathologically low atr14=0.001 returns FLOW_ROUTED_SKIP (not a crash or bad TP)', () => {
        // BUILD: near-zero ATR would produce a ~zero TP distance if buildMomentumExit ran
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.CATALYST_RISK, atr14: '0.001' }));

        // CHECK: skip, never reaches TP logic
        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        expect(signal.proposedExit).toBeNull();
    });

    it('catalyst_risk with pathologically high atr14=10000 returns FLOW_ROUTED_SKIP (not a crash or bad TP)', () => {
        // BUILD: extreme ATR that would produce a TP 35,000 above entry if buildMomentumExit ran
        const signal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.CATALYST_RISK, atr14: '10000' }));

        // CHECK: skip regardless
        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        expect(signal.proposedExit).toBeNull();
    });

    it('catalyst_risk skip carries no proposedExit on either ATR extreme (proposedExit is null)', () => {
        // BUILD + OPERATE
        const lowAtrSignal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.CATALYST_RISK, atr14: '0.001' }));
        const highAtrSignal = evaluateMomentum(buildInput({ flowType: FlowTypeEnum.CATALYST_RISK, atr14: '10000' }));

        // CHECK: no TP, SL, or atrDistance on a skip signal — TP logic never ran
        expect(lowAtrSignal.proposedExit).toBeNull();
        expect(highAtrSignal.proposedExit).toBeNull();
    });
});

// ─── ADV-3 — D2 max() branch at crossover ────────────────────────────────────

describe('momentumCore D2 adversarial — ADV-3: max() branch picks the correct winner at the cost-floor crossover', () => {
    // Algebraic derivation of crossover ATR with params (ref=60000, slippage_tier1=0.05%):
    //   fee fraction = 2 × 0.0004 = 0.0008
    //   slippage fraction = 2 × (0.05/100) = 0.001
    //   roundTripCostDistance = 60000 × 0.0018 = 108
    //   margin = 60000 × 0.001 = 60
    //   floor leg = 108 + 60 = 168
    //   ATR crossover: atr × 3.5 = 168 → atr = 48
    //   atr=47 → 47 × 3.5 = 164.5 < 168 → FLOOR wins
    //   atr=48 → 48 × 3.5 = 168 = 168 → tied (floor wins by `greaterThan` — not strictly greater)
    //   atr=49 → 49 × 3.5 = 171.5 > 168 → ATR wins
    //
    // The implementation uses: atrLeg.greaterThan(costFloorLeg) ? atrLeg : costFloorLeg
    // So at equality (atr=48): greaterThan is false → cost-floor leg wins.

    const FLOOR_LEG = deriveTier1CostFloorLeg(); // = 168

    it('atr14=47 (ATR leg 164.5 < floor 168): floor leg wins and TP distance == floor leg', () => {
        // BUILD: one unit below crossover — ATR leg is strictly less than floor
        const signal = evaluateMomentum(buildInput({ atr14: '47', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // CHECK: floor leg wins
        expect(tpDistance.toFixed()).toBe(FLOOR_LEG.toFixed());
    });

    it('atr14=49 (ATR leg 171.5 > floor 168): ATR leg wins and TP distance == atr × 3.5', () => {
        // BUILD: one unit above crossover — ATR leg is strictly greater than floor
        const signal = evaluateMomentum(buildInput({ atr14: '49', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);
        const expectedAtrLeg = new Money('49').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);

        // CHECK: ATR leg wins (171.5 > 168)
        expect(tpDistance.toFixed()).toBe(expectedAtrLeg.toFixed());
    });

    it('atr14=48 (ATR leg 168 == floor 168): floor leg wins (greaterThan is strict; tied → floor)', () => {
        // BUILD: exactly at crossover — greaterThan(equal) = false → floor leg returned
        const signal = evaluateMomentum(buildInput({ atr14: '48', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // CHECK: tie goes to floor (implementation: atrLeg.greaterThan(costFloor) ? atrLeg : costFloor)
        expect(tpDistance.toFixed()).toBe(FLOOR_LEG.toFixed());
    });

    it('crossover: the floor-winner distance is strictly larger than the ATR leg at atr14=47', () => {
        // BUILD: confirm the floor leg is actually winning (not just equal)
        const signal = evaluateMomentum(buildInput({ atr14: '47', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);
        const atrLeg = new Money('47').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);

        // CHECK: floor (168) > ATR leg (164.5)
        expect(tpDistance.greaterThan(atrLeg)).toBe(true);
    });

    it('crossover: the ATR-winner distance is strictly larger than the floor at atr14=49', () => {
        // BUILD: confirm the ATR leg is actually winning (not just equal)
        const signal = evaluateMomentum(buildInput({ atr14: '49', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // CHECK: ATR leg (171.5) > floor (168)
        expect(tpDistance.greaterThan(FLOOR_LEG)).toBe(true);
    });
});

// ─── ADV-4 — D2 short wrong-side guard: SHORT TP must be strictly below entry ──

describe('momentumCore D2 adversarial — ADV-4: SHORT takeProfitPrice is strictly below referencePrice', () => {
    // The short TP = referencePrice − atr14 × 2.0. For any positive ATR this must produce
    // a price below entry. The existing SC2/B7 tests check the DISTANCE magnitude but not
    // whether the TP is on the correct SIDE of the reference. This test pins the direction.

    it('SHORT trend_initiation: takeProfitPrice < referencePrice (TP is below entry)', () => {
        // BUILD
        const signal = evaluateMomentum(buildInput({ side: DeviationSideEnum.BELOW, atr14: '100', flowType: FlowTypeEnum.TREND_INITIATION }));

        // CHECK: TP must be strictly below entry (correct SHORT direction)
        expect(new Money(signal.proposedExit!.takeProfitPrice).lessThan(REFERENCE_PRICE)).toBe(true);
    });

    it('SHORT with low atr14=0.01: takeProfitPrice is still below referencePrice (direction safe at tiny ATR)', () => {
        // BUILD: near-zero ATR — TP is barely below entry, but must not be at or above it
        const signal = evaluateMomentum(buildInput({ side: DeviationSideEnum.BELOW, atr14: '0.01', flowType: FlowTypeEnum.TREND_INITIATION }));

        // CHECK: even an infinitesimal ATR produces a TP that is strictly below entry
        expect(new Money(signal.proposedExit!.takeProfitPrice).lessThan(REFERENCE_PRICE)).toBe(true);
    });

    it('SHORT with high atr14=5000: takeProfitPrice is still below referencePrice (direction safe at huge ATR)', () => {
        // BUILD: ATR half the reference price — TP = 60000 − 10000 = 50000 (well below)
        const signal = evaluateMomentum(buildInput({ side: DeviationSideEnum.BELOW, atr14: '5000', flowType: FlowTypeEnum.TREND_INITIATION }));

        // CHECK: TP well below entry
        expect(new Money(signal.proposedExit!.takeProfitPrice).lessThan(REFERENCE_PRICE)).toBe(true);
    });
});

// ─── ADV-5 — D2 decimal / M38 parity: atrDistance == |TP − ref| when floor leg wins ─

describe('momentumCore D2 adversarial — ADV-5: atrDistance carries the floor-leg distance (M38 rebase parity when floor wins)', () => {
    // The highest-risk implementation mistake is threading the ATR leg value into atrDistance
    // while separately applying the floor leg to takeProfitPrice when the floor wins.
    // This would break the M38 rebase contract (ADR 0045 §D1.2): the live arm and
    // BacktestOrchestrator.buildPosition must consume atrDistance verbatim to re-anchor the TP
    // from the fill price. If atrDistance differs from |takeProfitPrice − referencePrice|, the
    // rebased TP will be wrong.
    //
    // The existing B4 in momentumCore.d2.spec.ts checks this for the ATR-leg-wins case (atr=100).
    // This suite checks the FLOOR-LEG-WINS case specifically — the implementer-error path.

    it('LONG at atr=47 (floor leg wins): atrDistance == takeProfitPrice − referencePrice (not the ATR leg)', () => {
        // BUILD: floor leg wins at atr=47 (ATR leg = 164.5, floor = 168)
        const signal = evaluateMomentum(buildInput({ atr14: '47', coinTier: CoinTierEnum.TIER_1 }));

        const expectedTpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);
        const atrDistance = new Money(signal.proposedExit!.atrDistance!);

        // CHECK: atrDistance == takeProfitPrice − referencePrice (the composite distance, not the ATR leg)
        expect(atrDistance.toFixed()).toBe(expectedTpDistance.toFixed());
    });

    it('LONG at atr=47 (floor leg wins): atrDistance is NOT the ATR-leg value (164.5)', () => {
        // BUILD: pin that the stale atr×3.5 value is NOT what atrDistance carries
        const signal = evaluateMomentum(buildInput({ atr14: '47', coinTier: CoinTierEnum.TIER_1 }));
        const staleAtrLeg = new Money('47').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);

        // CHECK: atrDistance is the floor leg (168), not the ATR leg (164.5)
        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).not.toBe(staleAtrLeg.toFixed());
    });

    it('LONG at crossover atr=48 (floor wins by tie-break): atrDistance == floor leg, not ATR leg (both equal in value)', () => {
        // BUILD: at the exact crossover, floor wins; atrDistance must be the floor value
        const signal = evaluateMomentum(buildInput({ atr14: '48', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // CHECK: atrDistance == composite distance (which equals the floor at tie)
        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(tpDistance.toFixed());
    });

    it('LONG at atr=49 (ATR leg wins): atrDistance still equals takeProfitPrice − referencePrice (consistency)', () => {
        // BUILD: ATR leg wins — this is the B4 mirror but at the crossover boundary
        const signal = evaluateMomentum(buildInput({ atr14: '49', coinTier: CoinTierEnum.TIER_1 }));
        const tpDistance = new Money(signal.proposedExit!.takeProfitPrice).minus(REFERENCE_PRICE);

        // CHECK: atrDistance == composite distance on the ATR-wins side too
        expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(tpDistance.toFixed());
    });

    it('LONG at low ATR (floor leg wins): tpRebaseEligible stays true (M38 contract not broken)', () => {
        // BUILD: when the floor leg wins, the TP is still reference-price-relative and rebase-eligible
        const signal = evaluateMomentum(buildInput({ atr14: '1', coinTier: CoinTierEnum.TIER_1 }));

        // CHECK: floor-leg win does not flip rebase eligibility off
        expect(signal.proposedExit!.tpRebaseEligible).toBe(true);
    });
});
