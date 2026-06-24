/**
 * PositionSizer — M45 D1 adversarial tests.
 *
 * Coverage (stop-distance guard):
 *   A1 — sizing correctness: positionQty × |entry - stop| ≈ riskedUsdt
 *   A5a — zero denominator: stop == entry → invalid_inputs
 *   A5b — one-tick stop: |entry - stop| < tickSize → invalid_inputs
 *   A5c — NaN / Infinity stopLossPrice → invalid_inputs
 */

import { PositionSideEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { RISK_PER_TRADE_PCT } from '../../../src/risk/const';
import { PositionSizer, ISizingInput } from '../../../src/risk/service/PositionSizer';
import { buildInstrument } from '../support/fixtures';

// ─── fixture ─────────────────────────────────────────────────────────────────

function buildInput(overrides: Partial<ISizingInput> = {}): ISizingInput {
    return {
        allocatedCapital: new Money('10000'),
        atr14: new Money('500'),
        atrStopMultiplier: 1.0,
        // entry=50000, stop=49500 → stopDistance=500 → risked=100, qty=100/500=0.2
        entryPrice: new Money('50000'),
        stopLossPrice: new Money('49500'),
        tradeSide: PositionSideEnum.LONG,
        fundingRate: 0,
        fundingRateAnnualized: 0,
        fundingRateSuppressThreshold: 0.001,
        maxExposurePerCoinUsdt: new Money(9_999_999),
        instrument: buildInstrument({
            symbol: 'BTCUSDT',
            stepSize: new Money('0.001'),
            tickSize: new Money('1'),
            minNotional: new Money('5'),
        }),
        ...overrides,
    };
}

// ─── A1: sizing correctness ───────────────────────────────────────────────────

describe('PositionSizer M45 D1 — A1: stop-distance sizing correctness', () => {
    const sizer = new PositionSizer();

    it('positionQty × stopDistance equals riskedUsdt within rounding tolerance', () => {
        // entry=50000, stop=49500 → stopDistance=500
        // riskedUsdt = 10000 × RISK_PER_TRADE_PCT (1%) = 100 USDT
        // expectedQty = 100/500 = 0.2 contracts; after step-round DOWN to 0.001: 0.200
        const input = buildInput();

        const result = sizer.size(input);

        expect(result.kind).toBe('sized');

        if (result.kind !== 'sized') return;

        const stopDistance = input.entryPrice.minus(input.stopLossPrice).abs();
        const actualRisk = result.sizing.qty.times(stopDistance);
        const expectedRisk = input.allocatedCapital.times(RISK_PER_TRADE_PCT);

        // Allow ±1 step worth of rounding: qty rounds DOWN so actualRisk ≤ expectedRisk
        expect(actualRisk.lessThanOrEqualTo(expectedRisk)).toBe(true);

        // Must not be more than one-step below
        const oneStepRisk = input.instrument.stepSize.times(stopDistance);
        const lowerBound = expectedRisk.minus(oneStepRisk);
        expect(actualRisk.greaterThanOrEqualTo(lowerBound)).toBe(true);
    });

    it('produces the expected qty of 0.200 for the canonical BTC-momentum input', () => {
        // Canonical: capital=10000, stop=500, qty=0.2 (at most — step-rounding may leave 0.200 exactly)
        const result = sizer.size(buildInput());

        expect(result.kind).toBe('sized');

        if (result.kind !== 'sized') return;

        // qty = 100/500 = 0.2 → step 0.001 → 0.200 exactly (already aligned)
        expect(result.sizing.qty.greaterThanOrEqualTo(new Money('0.199'))).toBe(true);
        expect(result.sizing.qty.lessThanOrEqualTo(new Money('0.200'))).toBe(true);
    });
});

// ─── A5a: zero denominator (stop == entry) ────────────────────────────────────

describe('PositionSizer M45 D1 — A5a: stopLossPrice equal to entryPrice returns invalid_inputs', () => {
    const sizer = new PositionSizer();

    it('returns invalid_inputs when stopLossPrice equals entryPrice (zero stop distance)', () => {
        // stopDistance = |50000 - 50000| = 0 → would divide riskedUsdt by 0
        const result = sizer.size(
            buildInput({
                entryPrice: new Money('50000'),
                stopLossPrice: new Money('50000'),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });

    it('does NOT return sized when stop equals entry — no position is created', () => {
        const result = sizer.size(
            buildInput({
                entryPrice: new Money('30000'),
                stopLossPrice: new Money('30000'),
            }),
        );

        // Guard must fire before any sizing arithmetic reaches the DB
        expect(result.kind).not.toBe('sized');
    });
});

// ─── A5b: one-tick stop (|entry - stop| < tickSize) ──────────────────────────

describe('PositionSizer M45 D1 — A5b: stop distance smaller than one tick returns invalid_inputs', () => {
    const sizer = new PositionSizer();

    it('returns invalid_inputs when stopDistance is less than one tick', () => {
        // tickSize=1, stop distance = |50000 - 49999.5| = 0.5 < 1
        const result = sizer.size(
            buildInput({
                entryPrice: new Money('50000'),
                stopLossPrice: new Money('49999.5'),
                instrument: buildInstrument({
                    stepSize: new Money('0.001'),
                    tickSize: new Money('1'),
                    minNotional: new Money('5'),
                }),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns invalid_inputs when stopDistance equals exactly zero ticks (stop one sub-tick below entry)', () => {
        // tickSize=10, stop distance=9 — below floor
        const result = sizer.size(
            buildInput({
                entryPrice: new Money('50000'),
                stopLossPrice: new Money('49991'),
                instrument: buildInstrument({
                    stepSize: new Money('0.001'),
                    tickSize: new Money('10'),
                    minNotional: new Money('5'),
                }),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns sized when stopDistance equals exactly one tick (boundary — exactly at tick floor)', () => {
        // tickSize=1, stop distance=1 → greaterThanOrEqualTo(tickSize) must pass
        const result = sizer.size(
            buildInput({
                entryPrice: new Money('50000'),
                stopLossPrice: new Money('49999'),
                instrument: buildInstrument({
                    stepSize: new Money('0.001'),
                    tickSize: new Money('1'),
                    minNotional: new Money('5'),
                }),
            }),
        );

        // 1 tick is exactly at the floor — must not be rejected as invalid
        expect(result.kind).not.toBe('invalid_inputs');
    });
});

// ─── A5c: NaN / Infinity stopLossPrice ───────────────────────────────────────

describe('PositionSizer M45 D1 — A5c: non-finite stopLossPrice returns invalid_inputs', () => {
    const sizer = new PositionSizer();

    it('returns invalid_inputs when stopLossPrice is NaN', () => {
        const result = sizer.size(
            buildInput({
                // Decimal constructor accepts NaN — isFinite() returns false
                stopLossPrice: new Money(NaN),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns invalid_inputs when stopLossPrice is positive Infinity', () => {
        const result = sizer.size(
            buildInput({
                stopLossPrice: new Money(Infinity),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });

    it('returns invalid_inputs when stopLossPrice is negative Infinity', () => {
        const result = sizer.size(
            buildInput({
                stopLossPrice: new Money(-Infinity),
            }),
        );

        expect(result.kind).toBe('invalid_inputs');
    });
});
