/**
 * momentumCore — M47 Task 0: asymmetric fill-rebase fix (Bug 2, ADR 0045 Option B)
 *
 * Bug 2 (pre-fix): buildMomentumExit returned `tpRebaseEligible: true`, so the execution
 * layer re-anchored the TP from the signal-time reference to the actual fill price while the
 * SL (VWAP) stayed pinned. A fill landing off-reference therefore moved only the TP, voiding
 * the signal-time R:R geometry the risk gate approved (the gate runs pre-fill on
 * intent.proposedExit and cannot see the post-fill rebase).
 *
 * Option B (the M47 fix, MANDATORY — Option A rejected): freeze BOTH legs at signal time.
 * buildMomentumExit must now return `tpRebaseEligible: false` for every OPEN signal, so the
 * geometry the gate approves is the geometry the position holds for its whole life.
 *
 * Pre-fix vs post-fix:
 *   - PRE-FIX behavior (the bug): an OPEN momentum signal carried tpRebaseEligible === true,
 *     making the TP eligible for a single-leg fill-time rebase (TP moves, SL frozen).
 *   - POST-FIX behavior (asserted below): an OPEN momentum signal carries
 *     tpRebaseEligible === false on BOTH LONG and SHORT, so no rebase path can fire.
 *
 * This spec asserts only the one-field contract change (Task 0). The TP/SL price math is
 * unchanged here (that coupling is Task 2); atrDistance remains non-null because the sweep
 * tool still reconstructs the signal reference from it.
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IStrategyInput } from '../../interface';
import { evaluateMomentum } from '../momentumCore';

const VWAP = '50000';
const ATR14 = '100';
// M47 Task 2: small deviation → slDist (100) below the coupled-TP target, so the trade opens
// with R:R ≥ min_rr (the old 1.5% deviation gave slDist=750 vs atr=100, now a degenerate skip).
const DEVIATION_PCT = 0.2;
const NOW_MS = 1_700_000_000_000 + 5 * 60_000;

function buildMomentumInput(side: DeviationSideEnum, deviationPct: number): IStrategyInput {
    return {
        event: {
            symbol: 'BTCUSDT',
            side,
            entryCandleOpenTime: 1_700_000_000_000,
            eventId: 'BTCUSDT:1700000000000',
            vwapSession: new Money(VWAP).toFixed(18),
            vwap20bar: new Money(VWAP).toFixed(18),
            vwapAnchorType: VwapAnchorTypeEnum.SESSION,
            vwapDeviationPct: deviationPct,
            vwapDeviationSigma: 2.5,
            volumeRatio: 2.5,
            volume20barAvg: new Money('1000000').toFixed(18),
            atr14: new Money(ATR14).toFixed(18),
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
            regimeLabel: RegimeLabelEnum.TRENDING_UP,
            marketBreadth5mUpPct: 65,
            sameBarTriggerCount: 2,
            btc1mMovePct: 0.2,
            eth5mMovePct: 0.6,
            flowType: FlowTypeEnum.TREND_INITIATION,
        } as any,
        snapshot: {
            vwap_session: VWAP,
            signal_score: 85,
            flow_type: FlowTypeEnum.TREND_INITIATION,
        } as any,
        openPosition: null,
        params: {
            time_stop_minutes: 15,
            slippage_tier1_pct: 0.15,
            slippage_tier2_pct: 0.5,
            slippage_tier3_pct: 1.0,
            min_rr: 1.5,
            max_tp_dist_factor: 5.0,
        } as any,
        nowMs: NOW_MS,
    };
}

describe('momentumCore M47 Task 0 — momentum TP is NOT rebase-eligible (ADR 0045 Option B)', () => {
    it('LONG open: proposedExit.tpRebaseEligible is false (was true pre-fix — the Bug 2 single-leg rebase)', () => {
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.ABOVE, DEVIATION_PCT));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        // POST-FIX: frozen at signal time. PRE-FIX this read `true` and the TP rebased on fill.
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
    });

    it('SHORT open: proposedExit.tpRebaseEligible is false (was true pre-fix)', () => {
        const signal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.BELOW, -DEVIATION_PCT));

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit).not.toBeNull();
        expect(signal.proposedExit!.tpRebaseEligible).toBe(false);
    });

    it('atrDistance is still non-null under Option B (sweep-tool reference reconstruction is preserved)', () => {
        const longSignal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.ABOVE, DEVIATION_PCT));
        const shortSignal = evaluateMomentum(buildMomentumInput(DeviationSideEnum.BELOW, -DEVIATION_PCT));

        expect(longSignal.proposedExit!.atrDistance).not.toBeNull();
        expect(shortSignal.proposedExit!.atrDistance).not.toBeNull();
    });
});
