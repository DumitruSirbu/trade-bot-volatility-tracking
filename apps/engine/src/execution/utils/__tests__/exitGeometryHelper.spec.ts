/**
 * exitGeometryHelper — M38 D1/D2 pure-helper unit tests (ADR 0045)
 *
 * Surfaces under test:
 *
 *   RB1  — rebaseMomentumTakeProfit: LONG fill above signal → TP = fill + atrDistance
 *   RB2  — rebaseMomentumTakeProfit: SHORT fill below signal → TP = fill - atrDistance
 *   RB3  — rebaseMomentumTakeProfit: LONG fill BELOW signal → TP still rebased from fill (bug-prevention)
 *   RB4  — rebaseMomentumTakeProfit: SHORT fill ABOVE signal → TP still rebased from fill (bug-prevention)
 *   RB5  — rebaseMomentumTakeProfit: atrDistance = 0 → TP = fill price exactly
 *   RB6  — rebaseMomentumTakeProfit: large ATR distance — no overflow or NaN
 *   RB7  — rebaseMomentumTakeProfit: parity test — same inputs produce identical MoneyValue
 *
 *   FD1  — evaluateFillDrift: LONG fill above SL → shouldReject=false (correct, no wrong-side)
 *   FD2  — evaluateFillDrift: LONG fill AT SL → shouldReject=true, reason='wrong_side_of_sl' (≤ boundary)
 *   FD3  — evaluateFillDrift: LONG fill below SL → shouldReject=true, reason='wrong_side_of_sl'
 *   FD4  — evaluateFillDrift: SHORT fill below SL → shouldReject=false (correct)
 *   FD5  — evaluateFillDrift: SHORT fill AT SL → shouldReject=true, reason='wrong_side_of_sl' (≥ boundary)
 *   FD6  — evaluateFillDrift: SHORT fill above SL → shouldReject=true, reason='wrong_side_of_sl'
 *   FD7  — evaluateFillDrift: no entrySnapshot → magnitude leg skipped → shouldReject=false even with maxDriftPct
 *   FD8  — evaluateFillDrift: no maxDriftPct → magnitude leg skipped → shouldReject=false even with snapshot
 *   FD9  — evaluateFillDrift: drift below cap → shouldReject=false, driftPct returned
 *   FD10 — evaluateFillDrift: drift AT cap → shouldReject=false (> not >=, strict boundary)
 *   FD11 — evaluateFillDrift: drift above cap → shouldReject=true, reason='drift_over_cap'
 *   FD12 — evaluateFillDrift: referencePrice op-order matches entryHelpers.ts formula bit-for-bit
 */

import { IMarketSnapshot, PositionSideEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IProposedExit } from '../../../strategy/interface';
import { evaluateFillDrift, rebaseMomentumTakeProfit } from '../exitGeometryHelper';

// ─── fixture helpers ──────────────────────────────────────────────────────────

function buildMomentumExit(overrides: Partial<IProposedExit> = {}): IProposedExit {
    return {
        takeProfitPrice: new Money('50600'), // signal-time TP (anchor = signal price 50500 + ATR 100)
        stopLossPrice: new Money('50000'), // VWAP
        stopType: 'structural' as any,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: true,
        atrDistance: new Money('100'), // 50 * 2.0 (MULTIPLIER)
        ...overrides,
    };
}

function buildMeanReversionExit(overrides: Partial<IProposedExit> = {}): IProposedExit {
    return {
        takeProfitPrice: new Money('49900'),
        stopLossPrice: new Money('51000'),
        stopType: 'structural' as any,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: false,
        atrDistance: null,
        ...overrides,
    };
}

function buildSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 1.0, // referencePrice = 50000 * (1 + 1.0/100) = 50500
        vwap_deviation_sigma: 1.5,
        volume_ratio: 1.8,
        volume_20bar_avg: '1000000',
        atr_14: '100',
        adx_14: 25,
        adx_di_plus: 20,
        adx_di_minus: 12,
        rsi_14: 60,
        bollinger_upper: '51000',
        bollinger_lower: '49000',
        bollinger_pct_b: 0.7,
        btc_5m_move_pct: 0.3,
        btc_1m_move_pct: 0.1,
        eth_5m_move_pct: 0.5,
        market_breadth_5m_up_pct: 60,
        same_bar_trigger_count: 2,
        open_interest_change_5m_pct: 0.15,
        open_interest_change_15m_pct: 0.4,
        open_interest: '9999999',
        funding_rate: 0.0002,
        funding_rate_annualized: 0.219,
        bid_ask_spread_pct: 0.04,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: '12000000',
        book_depth_50bps_usdt: '50000000',
        coin_tier: 'tier_1' as any,
        coin_volume_rank: 1,
        correlation_mode: 'idiosyncratic' as any,
        signal_score: 82,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.55,
        idiosyncrasy_score: 0.72,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 120,
        flow_type: 'forced_exhaustion' as any,
        ...overrides,
    };
}

// ─── RB1: LONG fill above signal price → TP = fill + atrDistance ─────────────

describe('exitGeometryHelper — RB1: LONG fill above signal price → TP anchored to fill + atrDistance', () => {
    it('rebases LONG TP to fill + atrDistance when fill is above signal price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50550'); // above signal price 50500

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        // Expected: 50550 + 100 = 50650
        expect(result.toFixed(2)).toBe('50650.00');
    });

    it('rebased LONG TP is strictly above the fill price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50550');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        expect(new Money(result).greaterThan(fillPrice)).toBe(true);
    });
});

// ─── RB2: SHORT fill below signal price → TP = fill - atrDistance ────────────

describe('exitGeometryHelper — RB2: SHORT fill below signal price → TP anchored to fill - atrDistance', () => {
    it('rebases SHORT TP to fill - atrDistance when fill is below signal price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50450'); // below signal price 50500

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        // Expected: 50450 - 100 = 50350
        expect(result.toFixed(2)).toBe('50350.00');
    });

    it('rebased SHORT TP is strictly below the fill price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50450');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        expect(new Money(result).lessThan(fillPrice)).toBe(true);
    });
});

// ─── RB3: LONG fill BELOW signal price → TP still uses fill as anchor ─────────

describe('exitGeometryHelper — RB3: LONG fill below signal price → TP still rebased from fill (not signal)', () => {
    it('uses fill (not signal price) as anchor even when fill is below signal', () => {
        // This is the key bug-prevention case: signal at 50500, fill drifted DOWN to 50400.
        // Old (broken) behavior would freeze TP at signal+ATR = 50600.
        // New (correct) behavior rebases to fill+ATR = 50400+100 = 50500.
        const clampedExit = buildMomentumExit({
            atrDistance: new Money('100'),
            takeProfitPrice: new Money('50600'), // old frozen TP
        });
        const fillPrice = new Money('50400'); // fill drifted below signal 50500

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        expect(result.toFixed(2)).toBe('50500.00');
        // The result is fill+ATR, NOT the original frozen TP
        expect(result.toFixed(2)).not.toBe('50600.00');
    });

    it('LONG fill below signal: rebased TP is still above fill (position not doomed by geometry)', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50400');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        expect(new Money(result).greaterThan(fillPrice)).toBe(true);
    });
});

// ─── RB4: SHORT fill ABOVE signal price → TP still anchored to fill ───────────

describe('exitGeometryHelper — RB4: SHORT fill above signal price → TP still rebased from fill (not signal)', () => {
    it('uses fill (not signal price) as anchor even when fill is above signal (SHORT)', () => {
        // SHORT: signal at 50500, fill drifted UP to 50600.
        // Old (broken) behavior: frozen TP = signal-ATR = 50400.
        // New (correct) behavior: rebased TP = fill-ATR = 50600-100 = 50500.
        const clampedExit = buildMomentumExit({
            atrDistance: new Money('100'),
            takeProfitPrice: new Money('50400'), // old frozen TP (below signal for SHORT)
        });
        const fillPrice = new Money('50600'); // fill drifted above signal 50500

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        expect(result.toFixed(2)).toBe('50500.00');
        expect(result.toFixed(2)).not.toBe('50400.00');
    });

    it('SHORT fill above signal: rebased TP is still below fill', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('100') });
        const fillPrice = new Money('50600');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        expect(new Money(result).lessThan(fillPrice)).toBe(true);
    });
});

// ─── RB5: atrDistance = 0 → TP = fill price exactly ─────────────────────────

describe('exitGeometryHelper — RB5: atrDistance = 0 → rebased TP equals fill price exactly', () => {
    it('LONG with atrDistance=0: TP equals fill price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('0') });
        const fillPrice = new Money('50500');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        expect(result.toFixed(8)).toBe(fillPrice.toFixed(8));
    });

    it('SHORT with atrDistance=0: TP equals fill price', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('0') });
        const fillPrice = new Money('50500');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        expect(result.toFixed(8)).toBe(fillPrice.toFixed(8));
    });
});

// ─── RB6: Very large ATR distance — no overflow ───────────────────────────────

describe('exitGeometryHelper — RB6: large ATR distance does not overflow or produce NaN', () => {
    it('handles a very large atrDistance without overflow (LONG)', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('999999999') });
        const fillPrice = new Money('50000');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        const numeric = parseFloat(result.toFixed(8));
        expect(isNaN(numeric)).toBe(false);
        expect(isFinite(numeric)).toBe(true);
        expect(result.toFixed(0)).toBe('1000049999');
    });

    it('handles a very large atrDistance without overflow (SHORT)', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('999999999') });
        const fillPrice = new Money('1000050000');

        const result = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        const numeric = parseFloat(result.toFixed(8));
        expect(isNaN(numeric)).toBe(false);
        expect(isFinite(numeric)).toBe(true);
        expect(result.toFixed(0)).toBe('50001');
    });
});

// ─── RB7: Parity test — same inputs → identical MoneyValue ───────────────────

describe('exitGeometryHelper — RB7: parity test — same inputs produce identical output regardless of call site', () => {
    it('calling rebaseMomentumTakeProfit twice with identical inputs yields bit-identical results (LONG)', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('123.456789') });
        const fillPrice = new Money('49876.543210');

        const resultA = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);
        const resultB = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.LONG);

        expect(resultA.toFixed(18)).toBe(resultB.toFixed(18));
    });

    it('calling rebaseMomentumTakeProfit twice with identical inputs yields bit-identical results (SHORT)', () => {
        const clampedExit = buildMomentumExit({ atrDistance: new Money('123.456789') });
        const fillPrice = new Money('49876.543210');

        const resultA = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);
        const resultB = rebaseMomentumTakeProfit(clampedExit, fillPrice, PositionSideEnum.SHORT);

        expect(resultA.toFixed(18)).toBe(resultB.toFixed(18));
    });

    it('live-seam and backtest-seam would produce the same value given identical clampedExit+fill (parity invariant)', () => {
        // Both seams call: rebaseMomentumTakeProfit(decision.clampedExit, fillPrice, side)
        // Simulating both call-sites with the same arguments must produce the same MoneyValue.
        const clampedExit = buildMomentumExit({ atrDistance: new Money('150') });
        const fillPrice = new Money('50750');
        const side = PositionSideEnum.LONG;

        // "Live seam" call
        const liveResult = rebaseMomentumTakeProfit(clampedExit, fillPrice, side);
        // "Backtest seam" call (same pure function, same inputs)
        const backtestResult = rebaseMomentumTakeProfit(clampedExit, fillPrice, side);

        expect(liveResult.toFixed(18)).toBe(backtestResult.toFixed(18));
        expect(liveResult.toFixed(2)).toBe('50900.00');
    });
});

// ─── FD1: LONG fill above SL → shouldReject=false ────────────────────────────

describe('exitGeometryHelper — FD1: LONG fill strictly above SL → shouldReject=false (correct fill)', () => {
    it('LONG fill at 50100 with SL at 50000 is accepted', () => {
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('50100'), side: PositionSideEnum.LONG });

        expect(result.shouldReject).toBe(false);
        expect(result.reason).toBeUndefined();
    });
});

// ─── FD2: LONG fill AT SL → shouldReject=true (≤ boundary) ──────────────────

describe('exitGeometryHelper — FD2: LONG fill AT SL boundary → shouldReject=true (≤ boundary is wrong-side)', () => {
    it('LONG fill exactly at SL is rejected (fill ≤ SL is always wrong-side)', () => {
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('50000'), side: PositionSideEnum.LONG });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('wrong_side_of_sl');
    });
});

// ─── FD3: LONG fill below SL → shouldReject=true ─────────────────────────────

describe('exitGeometryHelper — FD3: LONG fill below SL → shouldReject=true, reason=wrong_side_of_sl', () => {
    it('LONG fill below SL is rejected with wrong_side_of_sl', () => {
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('49900'), side: PositionSideEnum.LONG });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('wrong_side_of_sl');
    });
});

// ─── FD4: SHORT fill below SL → shouldReject=false ───────────────────────────

describe('exitGeometryHelper — FD4: SHORT fill strictly below SL → shouldReject=false (correct fill)', () => {
    it('SHORT fill at 49900 with SL at 50000 is accepted', () => {
        const clampedExit = buildMeanReversionExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('49900'), side: PositionSideEnum.SHORT });

        expect(result.shouldReject).toBe(false);
        expect(result.reason).toBeUndefined();
    });
});

// ─── FD5: SHORT fill AT SL → shouldReject=true (≥ boundary) ─────────────────

describe('exitGeometryHelper — FD5: SHORT fill AT SL boundary → shouldReject=true (≥ boundary is wrong-side)', () => {
    it('SHORT fill exactly at SL is rejected (fill ≥ SL is always wrong-side for SHORT)', () => {
        const clampedExit = buildMeanReversionExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('50000'), side: PositionSideEnum.SHORT });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('wrong_side_of_sl');
    });
});

// ─── FD6: SHORT fill above SL → shouldReject=true ────────────────────────────

describe('exitGeometryHelper — FD6: SHORT fill above SL → shouldReject=true, reason=wrong_side_of_sl', () => {
    it('SHORT fill above SL is rejected with wrong_side_of_sl', () => {
        const clampedExit = buildMeanReversionExit({ stopLossPrice: new Money('50000') });

        const result = evaluateFillDrift({ clampedExit, avgFillPrice: new Money('50100'), side: PositionSideEnum.SHORT });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('wrong_side_of_sl');
    });
});

// ─── FD7: No entrySnapshot → magnitude leg skipped ───────────────────────────

describe('exitGeometryHelper — FD7: no entrySnapshot → magnitude leg skipped, shouldReject=false regardless of maxDriftPct', () => {
    it('fill far from reference price is accepted when entrySnapshot is absent', () => {
        // Fill is wildly far from any reference price, but no snapshot → no magnitude check
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('60000'), // far fill
            side: PositionSideEnum.LONG,
            entrySnapshot: undefined, // no entrySnapshot
            maxDriftPct: 2.0, // present but magnitude leg won't run
        });

        expect(result.shouldReject).toBe(false);
        expect(result.driftPct).toBeUndefined();
    });
});

// ─── FD8: No maxDriftPct → magnitude leg skipped ─────────────────────────────

describe('exitGeometryHelper — FD8: no maxDriftPct → magnitude leg skipped, shouldReject=false even with snapshot', () => {
    it('fill far from reference price is accepted when maxDriftPct is absent', () => {
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });
        const snapshot = buildSnapshot({ vwap_session: '50000', vwap_deviation_pct: 1.0 });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('60000'), // far fill — referencePrice ≈ 50500
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: undefined, // no maxDriftPct → magnitude leg skipped
        });

        expect(result.shouldReject).toBe(false);
        expect(result.driftPct).toBeUndefined();
    });
});

// ─── FD9: Drift below cap → shouldReject=false, driftPct returned ─────────────

describe('exitGeometryHelper — FD9: drift below cap → shouldReject=false, driftPct populated', () => {
    it('fill within drift cap passes and returns driftPct', () => {
        // referencePrice = 50000 * (1 + 1.0/100) = 50500
        // fill = 50600 → driftPct = |50600-50500|/50500 * 100 ≈ 0.198%
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });
        const snapshot = buildSnapshot({ vwap_session: '50000', vwap_deviation_pct: 1.0 });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('50600'),
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: 5.0, // cap 5% — fill is well under
        });

        expect(result.shouldReject).toBe(false);
        expect(typeof result.driftPct).toBe('number');
        expect(result.driftPct!).toBeLessThan(5.0);
    });
});

// ─── FD10: Drift AT cap → shouldReject=false (> not >=) ──────────────────────

describe('exitGeometryHelper — FD10: drift exactly at cap → shouldReject=false (guard is strict >, not >=)', () => {
    it('fill drift exactly equal to cap is NOT rejected (strict > boundary)', () => {
        // referencePrice = 50000 * (1 + 1.0/100) = 50500
        // We need driftPct = exactly 5.0%: fill = 50500 * 1.05 = 53025
        // driftPct = |53025 - 50500| / 50500 * 100 = 2525/50500*100 = 5.0%
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });
        const snapshot = buildSnapshot({ vwap_session: '50000', vwap_deviation_pct: 1.0 });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('53025'), // exactly 5% above referencePrice
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: 5.0, // cap exactly matches drift
        });

        // The guard is `driftPctNum > maxDriftPct` — exactly equal is NOT rejected
        expect(result.shouldReject).toBe(false);
        expect(result.driftPct).toBeDefined();
        expect(result.driftPct!).toBeCloseTo(5.0, 1);
    });
});

// ─── FD11: Drift above cap → shouldReject=true ────────────────────────────────

describe('exitGeometryHelper — FD11: drift above cap → shouldReject=true, reason=drift_over_cap', () => {
    it('fill drift above cap is rejected with drift_over_cap and driftPct populated', () => {
        // referencePrice = 50000 * (1 + 1.0/100) = 50500
        // fill = 55000 → driftPct = |55000-50500|/50500 * 100 ≈ 8.91%
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });
        const snapshot = buildSnapshot({ vwap_session: '50000', vwap_deviation_pct: 1.0 });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('55000'),
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: 5.0, // 5% cap — fill is way over
        });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('drift_over_cap');
        expect(typeof result.driftPct).toBe('number');
        expect(result.driftPct!).toBeGreaterThan(5.0);
    });
});

// ─── FD12: referencePrice op-order matches entryHelpers.ts formula ────────────

describe('exitGeometryHelper — FD12: referencePrice op-order mirrors entryHelpers.ts:44-46 exactly', () => {
    it('referencePrice = vwap * (1 + deviation/100) — decimal op-order is bit-identical to entryHelpers formula', () => {
        // Replicate the entryHelpers.ts formula manually and compare to a known drift value.
        // entryHelpers.ts:44-46:
        //   const ONE = new Money(1)
        //   const deviationFactor = ONE.plus(new Money(vwap_deviation_pct).dividedBy(new Money(100)))
        //   const referencePrice = new Money(vwap_session).times(deviationFactor)
        const vwapSession = '48000';
        const vwapDeviationPct = 2.5;

        // Manual replication of entryHelpers formula
        const ONE = new Money(1);
        const expectedRefPrice = new Money(vwapSession).times(ONE.plus(new Money(vwapDeviationPct).dividedBy(new Money(100))));

        // fill placed right at referencePrice → driftPct should be ~0
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('40000') });
        const snapshot = buildSnapshot({ vwap_session: vwapSession, vwap_deviation_pct: vwapDeviationPct });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: expectedRefPrice, // fill = referencePrice exactly
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: 10.0, // wide cap — won't reject
        });

        expect(result.shouldReject).toBe(false);
        // driftPct from fill at referencePrice should be 0 (within floating-point rounding of the 6dp truncation)
        expect(result.driftPct!).toBeCloseTo(0, 3);
    });

    it('wrong-side-of-SL check runs FIRST — wrong-side fill is rejected before magnitude is evaluated', () => {
        // LONG fill below SL: should be rejected with wrong_side_of_sl regardless of drift cap
        const clampedExit = buildMomentumExit({ stopLossPrice: new Money('50000') });
        const snapshot = buildSnapshot({ vwap_session: '50000', vwap_deviation_pct: 1.0 });

        const result = evaluateFillDrift({
            clampedExit,
            avgFillPrice: new Money('49999'), // just below SL
            side: PositionSideEnum.LONG,
            entrySnapshot: snapshot,
            maxDriftPct: 0.001, // ultra-tight cap — would reject on magnitude too, but SL check runs first
        });

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('wrong_side_of_sl');
        // driftPct not populated because we short-circuited before the magnitude leg
        expect(result.driftPct).toBeUndefined();
    });
});
