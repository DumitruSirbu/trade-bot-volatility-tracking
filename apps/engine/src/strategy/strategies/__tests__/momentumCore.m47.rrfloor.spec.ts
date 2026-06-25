/**
 * momentumCore — M47 Task 2: TP hybrid floor (rrFloor) coupling.
 *
 * The momentum TP distance is now max(baseLeg, rrFloor) where rrFloor = min(slDist × min_rr,
 * max_tp_dist_factor × atr14). The VWAP stop is never tightened — only the TP is widened to meet
 * the core R:R target. A capped sub-min_rr geometry (or slDist == 0) is skipped as degenerate.
 *
 * Geometry: reference = vwap × (1 + dev/100); slDist = |reference − vwap|. For a LONG (ABOVE)
 * the base leg is max(atr × 3.5, costFloor); for a SHORT (BELOW) it is atr × 2.0.
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, SkipReasonEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER, MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER } from '../../const';
import { IStrategyInput } from '../../interface';
import { evaluateMomentum } from '../momentumCore';

const VWAP = '50000';
const MIN_RR = 1.5;
const MAX_TP_DIST_FACTOR = 5.0;
const NOW_MS = 1_700_000_000_000 + 5 * 60_000;

interface IOpts {
    side: DeviationSideEnum;
    deviationPct: number;
    atr14: string;
}

function buildInput(opts: IOpts): IStrategyInput {
    const regimeLabel = opts.side === DeviationSideEnum.ABOVE ? RegimeLabelEnum.TRENDING_UP : RegimeLabelEnum.TRENDING_DOWN;

    return {
        event: {
            symbol: 'BTCUSDT',
            side: opts.side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'BTCUSDT:1700000000000',
            vwapSession: new Money(VWAP).toFixed(18),
            vwap20bar: new Money(VWAP).toFixed(18),
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
        snapshot: { vwap_session: VWAP, signal_score: 85, flow_type: FlowTypeEnum.TREND_INITIATION } as any,
        openPosition: null,
        params: {
            time_stop_minutes: 15,
            slippage_tier1_pct: 0.05,
            slippage_tier2_pct: 0.1,
            slippage_tier3_pct: 0.2,
            min_rr: MIN_RR,
            max_tp_dist_factor: MAX_TP_DIST_FACTOR,
        } as any,
        nowMs: NOW_MS,
    };
}

function referencePrice(deviationPct: number): MoneyValue {
    return new Money(VWAP).times(new Money(1).plus(new Money(deviationPct).dividedBy(100)));
}

function tpDistanceOf(input: IStrategyInput): MoneyValue {
    const signal = evaluateMomentum(input);
    const ref = referencePrice(input.event.vwapDeviationPct as number);

    return new Money(signal.proposedExit!.takeProfitPrice).minus(ref).abs();
}

describe('momentumCore M47 Task 2 — rrFloor TP coupling', () => {
    it('large spike (atrLeg / slDist < min_rr): rrFloor binds → tpDist == slDist × min_rr', () => {
        // LONG, dev=0.5% → slDist = 250; atrLeg = atr×3.5 = 50×3.5 = 175; atrLeg/slDist = 0.7 < 1.5.
        // rrFloorRaw = 250 × 1.5 = 375; cap = 5 × 50 = 250 ... cap would bind, so pick atr so cap > rrFloorRaw.
        // Use atr=100 → cap = 500 > 375; baseLeg = max(350, costFloor) = 350 < 375 → rrFloor wins.
        const input = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 0.5, atr14: '100' });
        const slDist = referencePrice(0.5).minus(new Money(VWAP)).abs(); // 250

        expect(tpDistanceOf(input).toFixed()).toBe(slDist.times(MIN_RR).toFixed());
    });

    it('small spike (atrLeg / slDist >= min_rr): rrFloor inert → tpDist == atrLeg', () => {
        // LONG, dev=0.05% → slDist = 25; atrLeg = 100×3.5 = 350; rrFloorRaw = 25×1.5 = 37.5 < 350.
        const input = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 0.05, atr14: '100' });
        const atrLeg = new Money('100').times(MOMENTUM_LONG_TAKE_PROFIT_ATR_MULTIPLIER);

        expect(tpDistanceOf(input).toFixed()).toBe(atrLeg.toFixed());
    });

    it('extreme spike (slDist × min_rr > cap): cap binds and the cap-bound sub-target is skipped (BLOCKER 5)', () => {
        // Whenever the cap STRICTLY binds (rrFloorRaw = slDist × min_rr > cap = 5 × atr14), the post-cap
        // ratio cap/slDist = 5×atr / slDist is necessarily < min_rr (since slDist × min_rr > 5×atr means
        // 5×atr/slDist < min_rr). So a strictly-capped momentum trade is always a degenerate skip — there
        // is no "cap binds AND opens" geometry. This is BLOCKER 5's invariant for the momentum core.
        // SHORT, dev=-0.4% → slDist = 200; rrFloorRaw = 300; atr=50 → cap = 250 < 300 (cap binds);
        // baseLeg SHORT = 100; tpDist = max(100, 250) = 250; ratio = 250/200 = 1.25 < 1.5 → SKIP.
        const input = buildInput({ side: DeviationSideEnum.BELOW, deviationPct: -0.4, atr14: '50' });
        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('cap-bound sub-min_rr geometry is skipped (BLOCKER 5): capped tpDist / slDist < min_rr → SKIP', () => {
        // LONG, dev=1.0% → slDist = 500; rrFloorRaw = 750; atr=80 → cap = 400; rrFloor = min(750,400)=400.
        // baseLeg = max(80×3.5=280, costFloor) = 280; tpDist = max(280, 400) = 400; ratio = 400/500 = 0.8 < 1.5.
        const input = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 1.0, atr14: '80' });
        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
        expect(signal.proposedExit).toBeNull();
    });

    it('SHORT direction: rrFloor coupling applies (not LONG-only)', () => {
        // SHORT, dev=-0.3% → slDist = 150; baseLeg = atr×2.0 = 100×2.0 = 200; rrFloorRaw = 150×1.5 = 225.
        // cap = 5×100 = 500; rrFloor = 225 > baseLeg 200 → tpDist = 225 (rrFloor binds on the SHORT side).
        const input = buildInput({ side: DeviationSideEnum.BELOW, deviationPct: -0.3, atr14: '100' });
        const slDist = referencePrice(-0.3).minus(new Money(VWAP)).abs(); // 150
        const baseLeg = new Money('100').times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER); // 200

        const dist = tpDistanceOf(input);

        expect(dist.toFixed()).toBe(slDist.times(MIN_RR).toFixed()); // 225
        expect(dist.greaterThan(baseLeg)).toBe(true);
    });

    it('atrDistance equals tpDist in every non-skip case (single-composite invariant)', () => {
        const longInput = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 0.5, atr14: '100' }); // rrFloor binds
        const shortInput = buildInput({ side: DeviationSideEnum.BELOW, deviationPct: -0.05, atr14: '100' }); // atrLeg wins

        for (const input of [longInput, shortInput]) {
            const signal = evaluateMomentum(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(new Money(signal.proposedExit!.atrDistance!).toFixed()).toBe(tpDistanceOf(input).toFixed());
        }
    });

    it('slDist == 0 (VWAP == reference) is skipped as degenerate', () => {
        const input = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 0, atr14: '100' });
        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('SHORT extreme spike (TP price ≤ 0): explicit non-positive price guard fires → SKIP', () => {
        // SHORT, atr=25000, dev=-0.3% → reference≈49850, slDist=150; baseLeg=atr×2=50000 > rrFloor=225;
        // tpDist=50000; ratio=333>>min_rr (ratio check alone would OPEN); TP price = 49850−50000 = −150 ≤ 0 → SKIP.
        const input = buildInput({ side: DeviationSideEnum.BELOW, deviationPct: -0.3, atr14: '25000' });
        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.DEGENERATE_VWAP_GEOMETRY);
    });

    it('boundary: capped tpDist / slDist == min_rr exactly → opens (not degenerate)', () => {
        // LONG, dev=0.5% → slDist = 250; rrFloorRaw = 375; atr large so cap inert. baseLeg dominated by rrFloor.
        // tpDist = 375; ratio = 375/250 = 1.5 == min_rr → strict-less check passes → OPEN.
        const input = buildInput({ side: DeviationSideEnum.ABOVE, deviationPct: 0.5, atr14: '100' });
        const signal = evaluateMomentum(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });
});
