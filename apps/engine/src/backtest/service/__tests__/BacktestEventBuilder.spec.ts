/**
 * BacktestEventBuilder — adversarial unit tests.
 *
 * Surfaces under test:
 *   R1 — resolveDeviationSide: positive → ABOVE; zero → BELOW; negative → BELOW
 *   R2 — computeIdiosyncrasyScore: btc=0 → 0; identical → near 0; opposite → near 1; clamped [0,1]
 *   R3 — deriveRegimeLabel: ADX>25+diPlus>diMinus → TRENDING_UP; ADX>25+diMinus>diPlus → TRENDING_DOWN;
 *         ADX<25 → RANGING; ADX==25 (boundary) → RANGING
 *   R4 — buildBacktestEvent: flowType placeholder is LOW_QUALITY_NOISE; eventId format; field mapping
 *
 * All tests are pure (no I/O, no mocks needed — the builder is a pure function).
 */

import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, VwapAnchorTypeEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { IIndicatorSnapshot } from '../../../market-data/interface';
import { buildBacktestEvent, IBacktestEventContext } from '../BacktestEventBuilder';

// ─── factories ────────────────────────────────────────────────────────────────

function buildSnapshot(overrides: Partial<IIndicatorSnapshot> = {}): IIndicatorSnapshot {
    return {
        symbol: 'ETHUSDT',
        closedBarOpenTimeMs: 1_700_000_000_000,
        vwapSession: new Money('2000'),
        vwap20bar: new Money('2000'),
        vwap24h: new Money('2000'),
        vwapEventAnchored: new Money('2000'),
        activeVwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 2.5,
        vwapDeviationSigma: 1.2,
        volumeRatio: 1.8,
        volume20barAvg: new Money('500000'),
        atr14: new Money('50'),
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 60,
        bollingerUpper: new Money('2100'),
        bollingerLower: new Money('1900'),
        bollingerPctB: 0.7,
        close: new Money('2050'),
        fiveMinMovePct: 1.0,
        ...overrides,
    };
}

function buildContext(overrides: Partial<IBacktestEventContext> = {}): IBacktestEventContext {
    return {
        coinTier: CoinTierEnum.TIER_1,
        universeAgeHours: 24,
        coinVolumeRank: 2,
        oiValue: new Money('1000000'),
        oiChange5mPct: 0.1,
        oiChange15mPct: 0.3,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.1,
        btc5mMovePct: 0.5,
        eth5mMovePct: 0.4,
        btc1mMovePct: 0.1,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: new Money('200000'),
        bookDepth50bpsUsdt: new Money('500000'),
        marketBreadth5mUpPct: 60,
        sameBarTriggerCount: 3,
        aggTradeBuyVolumeRatio: 0.55,
        ...overrides,
    };
}

// ─── R1: resolveDeviationSide ─────────────────────────────────────────────────

describe('buildBacktestEvent — resolveDeviationSide', () => {
    it('returns ABOVE when vwapDeviationPct is strictly positive', () => {
        const snapshot = buildSnapshot({ vwapDeviationPct: 2.5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.side).toBe(DeviationSideEnum.ABOVE);
    });

    it('returns BELOW when vwapDeviationPct is exactly zero (boundary)', () => {
        const snapshot = buildSnapshot({ vwapDeviationPct: 0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.side).toBe(DeviationSideEnum.BELOW);
    });

    it('returns BELOW when vwapDeviationPct is negative', () => {
        const snapshot = buildSnapshot({ vwapDeviationPct: -1.5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.side).toBe(DeviationSideEnum.BELOW);
    });

    it('returns BELOW for very small negative deviation (near-zero adversarial)', () => {
        const snapshot = buildSnapshot({ vwapDeviationPct: -0.000001 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.side).toBe(DeviationSideEnum.BELOW);
    });
});

// ─── R2: computeIdiosyncrasyScore ─────────────────────────────────────────────

describe('buildBacktestEvent — computeIdiosyncrasyScore', () => {
    it('returns 0 when btc5mMovePct is exactly zero (no reference)', () => {
        const snapshot = buildSnapshot({ fiveMinMovePct: 3.0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: 0 }));

        expect(event.idiosyncrasyScore).toBe(0);
    });

    it('approaches 0 when symbol move is identical to BTC move', () => {
        const snapshot = buildSnapshot({ fiveMinMovePct: 1.0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: 1.0 }));

        // numerator = |1.0 - 1.0| = 0 → score ≈ 0 (only epsilon prevents 0/0)
        expect(event.idiosyncrasyScore).toBeCloseTo(0, 5);
    });

    it('approaches 1 when symbol moves in the opposite direction to BTC', () => {
        const snapshot = buildSnapshot({ fiveMinMovePct: 5.0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: -5.0 }));

        // numerator = |5 - (-5)| = 10; denominator ≈ |5| + |-5| + epsilon ≈ 10
        // raw ≈ 10/10.0001 ≈ 0.99999 → clamped to [0,1]
        expect(event.idiosyncrasyScore).toBeGreaterThan(0.99);
        expect(event.idiosyncrasyScore).toBeLessThanOrEqual(1);
    });

    it('clamps result to maximum 1 (no overflow above unit interval)', () => {
        // Extreme inputs: giant symbol move, tiny BTC move — raw could exceed 1 without clamping
        const snapshot = buildSnapshot({ fiveMinMovePct: 100 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: 0.001 }));

        expect(event.idiosyncrasyScore).toBeLessThanOrEqual(1);
    });

    it('clamps result to minimum 0 (never negative)', () => {
        const snapshot = buildSnapshot({ fiveMinMovePct: 0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: 5.0 }));

        expect(event.idiosyncrasyScore).toBeGreaterThanOrEqual(0);
    });

    it('returns a mid-range score when moves partially diverge', () => {
        // symbol=3, btc=1 → numerator=|2|=2; denominator≈|3|+|1|+eps≈4; raw≈0.5
        const snapshot = buildSnapshot({ fiveMinMovePct: 3.0 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext({ btc5mMovePct: 1.0 }));

        expect(event.idiosyncrasyScore).toBeGreaterThan(0.4);
        expect(event.idiosyncrasyScore).toBeLessThan(0.6);
    });
});

// ─── R3: regime label classification (delegates to live computeRegimeLabel) ──
//
// R1-H3 fix: BacktestEventBuilder now delegates to `market-data/indicator/computeRegimeLabel`
// to guarantee backtest replays classify identically to the live engine. The live
// taxonomy: ADX < 20 → RANGING; ADX > 25 → TRENDING_{UP,DOWN} by DI ordering with
// diPlus >= diMinus (note >=, not >); 20 <= ADX <= 25 → TRANSITIONING.

describe('buildBacktestEvent — regime classification matches live', () => {
    it('returns TRENDING_UP when ADX>25 and diPlus>diMinus', () => {
        const snapshot = buildSnapshot({ adx14: 30, adxDiPlus: 28, adxDiMinus: 15 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRENDING_UP);
    });

    it('returns TRENDING_DOWN when ADX>25 and diMinus>diPlus', () => {
        const snapshot = buildSnapshot({ adx14: 40, adxDiPlus: 10, adxDiMinus: 35 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRENDING_DOWN);
    });

    it('returns RANGING when ADX<20 (live classifier strict lower bound)', () => {
        const snapshot = buildSnapshot({ adx14: 19, adxDiPlus: 30, adxDiMinus: 5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.RANGING);
    });

    it('returns TRANSITIONING at ADX=20 boundary (live classifier — used to collapse to RANGING in backtest)', () => {
        // R1-H3 regression: BacktestEventBuilder used to return RANGING for ADX in [20, 25].
        // Live computeRegimeLabel returns TRANSITIONING. Backtest must match.
        const snapshot = buildSnapshot({ adx14: 20, adxDiPlus: 30, adxDiMinus: 5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRANSITIONING);
    });

    it('returns TRANSITIONING at ADX=22 mid-band (live classifier — was RANGING in backtest pre-fix)', () => {
        const snapshot = buildSnapshot({ adx14: 22, adxDiPlus: 30, adxDiMinus: 5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRANSITIONING);
    });

    it('returns TRANSITIONING at ADX=25 boundary (live classifier uses ADX > 25 strict)', () => {
        const snapshot = buildSnapshot({ adx14: 25, adxDiPlus: 30, adxDiMinus: 5 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRANSITIONING);
    });

    it('R1-H3 paired boundary: ADX=22 with diPlus=diMinus classifies identically to live computeRegimeLabel', () => {
        // The exact divergence flagged in the R1 review: backtest used strict > on DI
        // ordering and collapsed 20..25 into RANGING. With the live classifier this is
        // TRANSITIONING (the 20..25 band) — DI ordering only matters when ADX > 25 and
        // there it uses >= (diPlus >= diMinus → TRENDING_UP on tie). At ADX=22 the band
        // dominates → TRANSITIONING.
        const snapshot = buildSnapshot({ adx14: 22, adxDiPlus: 20, adxDiMinus: 20 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRANSITIONING);
    });

    it('returns TRENDING_UP when ADX>25 and diPlus equals diMinus (live uses diPlus >= diMinus)', () => {
        // R1-H3 paired regression: backtest used strict > so this used to fall through
        // to RANGING. Live uses diPlus >= diMinus → TRENDING_UP on ties.
        const snapshot = buildSnapshot({ adx14: 30, adxDiPlus: 20, adxDiMinus: 20 });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.regimeLabel).toBe(RegimeLabelEnum.TRENDING_UP);
    });
});

// ─── R4: buildBacktestEvent field contracts ──────────────────────────────────

describe('buildBacktestEvent — field contracts', () => {
    it('stamps flowType as LOW_QUALITY_NOISE (orchestrator must overwrite)', () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext());

        expect(event.flowType).toBe(FlowTypeEnum.LOW_QUALITY_NOISE);
    });

    it('builds eventId as symbol:barOpenTimeMs', () => {
        const snapshot = buildSnapshot({ symbol: 'SOLUSDT' });
        const barOpenTimeMs = 1_700_123_456_789;
        const event = buildBacktestEvent(snapshot, barOpenTimeMs, buildContext());

        expect(event.eventId).toBe(`SOLUSDT:${barOpenTimeMs}`);
    });

    it('sets entryCandleOpenTime from barOpenTimeMs argument', () => {
        const barOpenTimeMs = 1_700_987_654_321;
        const event = buildBacktestEvent(buildSnapshot(), barOpenTimeMs, buildContext());

        expect(event.entryCandleOpenTime).toBe(barOpenTimeMs);
    });

    it('maps btc5mMovePct from context, not snapshot', () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext({ btc5mMovePct: 3.7 }));

        expect(event.btc5mMovePct).toBe(3.7);
    });

    it('serializes openInterest as fixed-18 string when oiValue is non-null', () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext({ oiValue: new Money('1234567.89') }));

        expect(event.openInterest).toBe(new Money('1234567.89').toFixed(18));
    });

    it("serializes openInterest as '0' when oiValue is null", () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext({ oiValue: null }));

        expect(event.openInterest).toBe('0');
    });

    it("serializes bookDepth10bpsUsdt as '0' when bookDepth10bpsUsdt context field is null", () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext({ bookDepth10bpsUsdt: null }));

        expect(event.bookDepth10bpsUsdt).toBe('0');
    });

    it("serializes bookDepth50bpsUsdt as '0' when bookDepth50bpsUsdt context field is null", () => {
        const event = buildBacktestEvent(buildSnapshot(), 1_700_000_000_000, buildContext({ bookDepth50bpsUsdt: null }));

        expect(event.bookDepth50bpsUsdt).toBe('0');
    });

    it('serializes vwapSession as fixed-18 string', () => {
        const snapshot = buildSnapshot({ vwapSession: new Money('2000.5') });
        const event = buildBacktestEvent(snapshot, 1_700_000_000_000, buildContext());

        expect(event.vwapSession).toBe(new Money('2000.5').toFixed(18));
    });

    it('produces the same event on repeated calls with the same inputs (determinism)', () => {
        const snapshot = buildSnapshot();
        const barOpenTimeMs = 1_700_000_000_000;
        const ctx = buildContext();

        const first = buildBacktestEvent(snapshot, barOpenTimeMs, ctx);
        const second = buildBacktestEvent(snapshot, barOpenTimeMs, ctx);

        expect(first).toEqual(second);
    });
});
