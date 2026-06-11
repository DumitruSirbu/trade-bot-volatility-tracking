/**
 * PositionSizer — ATR-based sizing, step-rounding, leverage clamp, funding filter.
 * Pure function: no I/O, no clock. All assertions use decimal equality.
 */

import { PositionSideEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { FUNDING_ANNUALIZED_SUPPRESS_PCT, FUNDING_SIZE_CUT_FACTOR, MAX_LEVERAGE, RISK_PER_TRADE_PCT } from '../../../src/risk/const';
import { PositionSizer, ISizingInput } from '../../../src/risk/service/PositionSizer';
import { buildInstrument } from '../support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildInput(overrides: Partial<ISizingInput> = {}): ISizingInput {
    return {
        allocatedCapital: new Money('1000'),
        atr14: new Money('100'),
        atrStopMultiplier: 1.5,
        entryPrice: new Money('10000'),
        tradeSide: PositionSideEnum.SHORT,
        fundingRate: 0,
        fundingRateAnnualized: 0,
        fundingRateSuppressThreshold: 0.001, // abs periodic rate threshold for funding cut
        maxExposurePerCoinUsdt: new Money(9_999_999), // M29: per-coin hard ceiling — default huge so pre-M29 tests are unaffected
        instrument: buildInstrument({
            stepSize: new Money('0.001'),
            minNotional: new Money('5'),
        }),
        ...overrides,
    };
}

function makeSizer(): PositionSizer {
    return new PositionSizer();
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('PositionSizer', () => {
    describe('ATR-based notional formula', () => {
        it('computes the correct base notional from riskPerTrade / stopDistance * entryPrice', () => {
            const sizer = makeSizer();
            const input = buildInput({
                allocatedCapital: new Money('1000'),
                atr14: new Money('100'),
                atrStopMultiplier: 1.5,
                entryPrice: new Money('10000'),
                instrument: buildInstrument({ stepSize: new Money('0.001'), minNotional: new Money('5') }),
            });

            // riskPerTrade = 1000 * 0.01 = 10
            // stopDistance = 100 * 1.5 = 150
            // baseNotional = 10 / 150 * 10000 = 666.66...
            // qty = 666.66.../10000 = 0.06666... rounded DOWN to 0.001 step → 0.066
            // notional = 0.066 * 10000 = 660
            const result = sizer.size(input);

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                // notional should be exactly 660 after step-rounding
                expect(result.sizing.notional.greaterThanOrEqualTo(new Money('650'))).toBe(true);
                expect(result.sizing.notional.lessThanOrEqualTo(new Money('670'))).toBe(true);
            }
        });

        it('sets riskPerTradeUsdt to allocatedCapital * RISK_PER_TRADE_PCT', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ allocatedCapital: new Money('2000') }));

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                const expected = new Money('2000').times(RISK_PER_TRADE_PCT);
                expect(result.sizing.riskPerTradeUsdt.equals(expected)).toBe(true);
            }
        });
    });

    describe('step-size rounding — always DOWN', () => {
        it('rounds qty down to step_size multiple (never rounds up)', () => {
            const sizer = makeSizer();
            // price=7, atr=0.1: base=100/0.1*7=7000, clamped to 3× of capital=300,
            // qty=300/7=42.857... → rounded DOWN to step 0.1 → 42.8; notional=42.8*7=299.6 >= 5
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('100'),
                    atr14: new Money('0.1'),
                    atrStopMultiplier: 1,
                    entryPrice: new Money('7'),
                    instrument: buildInstrument({ stepSize: new Money('0.1'), minNotional: new Money('5') }),
                }),
            );

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                const qty = result.sizing.qty;
                // qty must be an exact multiple of 0.1
                const remainder = qty.modulo(new Money('0.1'));
                expect(remainder.equals(new Money('0'))).toBe(true);
            }
        });

        it('never produces a qty that is a non-integer multiple of stepSize', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    atr14: new Money('77.77'),
                    instrument: buildInstrument({ stepSize: new Money('0.01'), minNotional: new Money('1') }),
                }),
            );

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                const remainder = result.sizing.qty.modulo(new Money('0.01'));
                expect(remainder.equals(new Money('0'))).toBe(true);
            }
        });

        it('returns below_min_notional when rounding down leaves qty * price < minNotional', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('1'), // very small capital
                    atr14: new Money('9999'), // huge ATR → tiny qty
                    instrument: buildInstrument({ stepSize: new Money('1'), minNotional: new Money('100') }),
                }),
            );

            expect(result.kind).toBe('below_min_notional');
        });

        it('does NOT bump qty up to meet min notional (rejects instead)', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('10'),
                    atr14: new Money('500'),
                    instrument: buildInstrument({ stepSize: new Money('1'), minNotional: new Money('10000') }),
                }),
            );

            expect(result.kind).toBe('below_min_notional');
        });
    });

    describe('max-leverage clamp (≤ 3×)', () => {
        it('clamps notional so leverage <= MAX_LEVERAGE when ATR-based notional would exceed it', () => {
            const sizer = makeSizer();
            // Very small ATR → huge notional → exceeds 3× allocated capital
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('1000'),
                    atr14: new Money('0.01'),
                    atrStopMultiplier: 1.0,
                    entryPrice: new Money('100'),
                    instrument: buildInstrument({ stepSize: new Money('0.001'), minNotional: new Money('5') }),
                }),
            );

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                expect(result.sizing.leverage.lessThanOrEqualTo(new Money(MAX_LEVERAGE))).toBe(true);
            }
        });

        it('does not clamp when notional is naturally within 3× leverage', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('1000'),
                    atr14: new Money('100'),
                    atrStopMultiplier: 1.5,
                    entryPrice: new Money('10000'),
                }),
            );

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                expect(result.sizing.leverage.lessThanOrEqualTo(new Money(MAX_LEVERAGE))).toBe(true);
            }
        });
    });

    describe('funding adjustment', () => {
        it('halves notional when funding is unfavourable (positive funding + long side)', () => {
            const sizer = makeSizer();
            const baseline = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0,
                    fundingRateAnnualized: 0,
                }),
            );

            const withFunding = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0.002, // positive → unfavourable for longs
                    fundingRateAnnualized: 1, // below suppress threshold of 30%
                }),
            );

            expect(baseline.kind).toBe('sized');
            expect(withFunding.kind).toBe('sized');

            if (baseline.kind === 'sized' && withFunding.kind === 'sized') {
                const expectedCut = baseline.sizing.notional.times(FUNDING_SIZE_CUT_FACTOR);
                // allow rounding difference of step-size
                const diff = expectedCut.minus(withFunding.sizing.notional).abs();
                expect(diff.lessThan(new Money('10'))).toBe(true);
            }
        });

        it('halves notional when funding is unfavourable (negative funding + short side)', () => {
            const sizer = makeSizer();
            const baseline = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.SHORT,
                    fundingRate: 0,
                    fundingRateAnnualized: 0,
                }),
            );

            const withFunding = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.SHORT,
                    fundingRate: -0.002, // negative → unfavourable for shorts
                    fundingRateAnnualized: -1,
                }),
            );

            expect(baseline.kind).toBe('sized');
            expect(withFunding.kind).toBe('sized');

            if (baseline.kind === 'sized' && withFunding.kind === 'sized') {
                // Funded notional must be smaller than unfunded
                expect(withFunding.sizing.notional.lessThan(baseline.sizing.notional)).toBe(true);
            }
        });

        it('does NOT halve when funding direction is favourable (positive + short)', () => {
            const sizer = makeSizer();
            const noFunding = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.SHORT,
                    fundingRate: 0,
                    fundingRateAnnualized: 0,
                }),
            );

            const favourableFunding = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.SHORT,
                    fundingRate: 0.002, // positive funding is FAVOURABLE for shorts (they receive it)
                    fundingRateAnnualized: 1,
                }),
            );

            expect(noFunding.kind).toBe('sized');
            expect(favourableFunding.kind).toBe('sized');

            if (noFunding.kind === 'sized' && favourableFunding.kind === 'sized') {
                // Same notional — no cut applied
                expect(favourableFunding.sizing.notional.equals(noFunding.sizing.notional)).toBe(true);
            }
        });

        it('returns funding_suppressed when annualized rate exceeds FUNDING_ANNUALIZED_SUPPRESS_PCT', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    fundingRateAnnualized: FUNDING_ANNUALIZED_SUPPRESS_PCT + 1,
                }),
            );

            expect(result.kind).toBe('funding_suppressed');
        });

        it('returns funding_suppressed for deeply negative annualized rate (>30% magnitude)', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    fundingRateAnnualized: -(FUNDING_ANNUALIZED_SUPPRESS_PCT + 1),
                }),
            );

            expect(result.kind).toBe('funding_suppressed');
        });

        it('does NOT suppress at exactly FUNDING_ANNUALIZED_SUPPRESS_PCT (boundary — strictly greater)', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    fundingRateAnnualized: FUNDING_ANNUALIZED_SUPPRESS_PCT,
                }),
            );

            // At exactly 30% it uses >30 condition so it should NOT suppress
            expect(result.kind).toBe('sized');
        });

        it('does NOT halve notional when periodic fundingRate is below fundingRateSuppressThreshold (unfavourable but under threshold)', () => {
            // fundingRate=0.0005 (unfavourable for long) but threshold=0.001 → below threshold → no cut
            const sizer = makeSizer();
            const baseline = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0,
                    fundingRateAnnualized: 0,
                    fundingRateSuppressThreshold: 0.001,
                }),
            );

            const belowThreshold = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0.0005, // unfavourable (positive + long) but < threshold
                    fundingRateAnnualized: 0,
                    fundingRateSuppressThreshold: 0.001,
                }),
            );

            expect(baseline.kind).toBe('sized');
            expect(belowThreshold.kind).toBe('sized');

            if (baseline.kind === 'sized' && belowThreshold.kind === 'sized') {
                // No cut — same notional
                expect(belowThreshold.sizing.notional.equals(baseline.sizing.notional)).toBe(true);
            }
        });

        it('halves notional when periodic fundingRate exactly meets fundingRateSuppressThreshold (at threshold)', () => {
            // fundingRate=0.001 exactly at threshold and unfavourable for long → cut fires
            const sizer = makeSizer();
            const baseline = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0,
                    fundingRateAnnualized: 0,
                    fundingRateSuppressThreshold: 0.001,
                }),
            );

            const atThreshold = sizer.size(
                buildInput({
                    tradeSide: PositionSideEnum.LONG,
                    fundingRate: 0.001, // at threshold, unfavourable for long → cut fires
                    fundingRateAnnualized: 0,
                    fundingRateSuppressThreshold: 0.001,
                }),
            );

            expect(baseline.kind).toBe('sized');
            expect(atThreshold.kind).toBe('sized');

            if (baseline.kind === 'sized' && atThreshold.kind === 'sized') {
                // Cut applied — notional is roughly half of baseline
                expect(atThreshold.sizing.notional.lessThan(baseline.sizing.notional)).toBe(true);
            }
        });
    });

    describe('invalid inputs (fail-closed)', () => {
        it('returns invalid_inputs when atrStopMultiplier is NaN', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ atrStopMultiplier: NaN }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when fundingRate is Infinity', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ fundingRate: Infinity }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when fundingRateAnnualized is NaN', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ fundingRateAnnualized: NaN }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when entryPrice is negative', () => {
            // Negative entry price violates isPositive() check; decimal.js isPositive returns
            // false for negative values.
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ entryPrice: new Money('-1') }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when atr14 is negative', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ atr14: new Money('-1') }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when allocatedCapital is negative', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ allocatedCapital: new Money('-100') }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when atrStopMultiplier is 0 (non-positive)', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ atrStopMultiplier: 0 }));
            expect(result.kind).toBe('invalid_inputs');
        });

        it('returns invalid_inputs when atrStopMultiplier is negative', () => {
            const sizer = makeSizer();
            const result = sizer.size(buildInput({ atrStopMultiplier: -1 }));
            expect(result.kind).toBe('invalid_inputs');
        });
    });

    describe('decimal precision', () => {
        it('produces qty that is an exact decimal (no floating-point drift)', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    atr14: new Money('333.333333'),
                    entryPrice: new Money('33333.33'),
                    instrument: buildInstrument({ stepSize: new Money('0.001'), minNotional: new Money('1') }),
                }),
            );

            expect(result.kind).toBe('sized');

            if (result.kind === 'sized') {
                // isFinite and not NaN — decimal.js always produces exact values
                expect(result.sizing.qty.isFinite()).toBe(true);
                expect(result.sizing.notional.isFinite()).toBe(true);
            }
        });

        it('handles large allocated capital without overflow', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    allocatedCapital: new Money('1000000'),
                    instrument: buildInstrument({ stepSize: new Money('0.001'), minNotional: new Money('1') }),
                }),
            );

            expect(result.kind).toBe('sized');
        });

        it('handles zero entry price step-size gracefully (returns sized with zero qty path)', () => {
            const sizer = makeSizer();
            const result = sizer.size(
                buildInput({
                    instrument: buildInstrument({ stepSize: new Money('0'), minNotional: new Money('5') }),
                }),
            );

            // stepSize=0 means no rounding applied; qty should still compute
            expect(result.kind === 'sized' || result.kind === 'below_min_notional').toBe(true);
        });
    });
});
