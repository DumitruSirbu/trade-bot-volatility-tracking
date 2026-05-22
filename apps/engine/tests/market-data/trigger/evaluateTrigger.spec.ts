import { DeviationSideEnum, IClosedBarTriggerInput, ITriggerParams } from '@bot/shared';

import { evaluateTrigger } from '../../../src/market-data/trigger/evaluateTrigger';

// A known candle snapshot that satisfies all four conditions when params are set to
// baseline values. Hand-verified against the four-condition formula in the source.
function buildAllPassingInput(overrides: Partial<IClosedBarTriggerInput> = {}): IClosedBarTriggerInput {
    return {
        symbol: 'ETH/USDT:USDT',
        vwapDeviationSigma: 3.0, // abs >= 2.5 (vwapSigmaTrigger) ✓
        vwapDeviationPct: 2.5, // abs in [0.8, 6] ✓
        volumeRatio: 3.0, // >= 2.0 (volumeRatioMin) ✓
        ...overrides,
    };
}

function buildBaselineParams(overrides: Partial<ITriggerParams> = {}): ITriggerParams {
    return {
        vwapSigmaTrigger: 2.5,
        volumeRatioMin: 2.0,
        tierMinAbsMovePct: 0.8,
        tierMaxAbsMovePct: 6.0,
        ...overrides,
    };
}

describe('evaluateTrigger', () => {
    describe('all four conditions satisfied', () => {
        it('fires when sigma, volume, minMove and maxMove conditions all hold', () => {
            // BUILD
            const input = buildAllPassingInput();
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.fired).toBe(true);
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.volumeConditionMet).toBe(true);
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.maxMoveConditionMet).toBe(true);
        });
    });

    describe('sigma condition boundary', () => {
        it('fires when abs(vwapDeviationSigma) equals exactly the threshold', () => {
            // BUILD — sigma is exactly at the trigger threshold
            const input = buildAllPassingInput({ vwapDeviationSigma: 2.5 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when abs(vwapDeviationSigma) is one epsilon below threshold', () => {
            // BUILD
            const input = buildAllPassingInput({ vwapDeviationSigma: 2.4999 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.sigmaConditionMet).toBe(false);
            expect(result.fired).toBe(false);
        });

        it('sigma condition uses abs so negative deviation at threshold also fires', () => {
            // BUILD — negative sigma of same magnitude as the threshold
            const input = buildAllPassingInput({ vwapDeviationSigma: -2.5 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when sigma condition fails independently; other conditions hold', () => {
            // BUILD — only sigma is below threshold
            const input = buildAllPassingInput({ vwapDeviationSigma: 1.0 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.sigmaConditionMet).toBe(false);
            expect(result.volumeConditionMet).toBe(true);
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.maxMoveConditionMet).toBe(true);
            expect(result.fired).toBe(false);
        });
    });

    describe('volume condition boundary', () => {
        it('fires when volumeRatio equals exactly the minimum', () => {
            // BUILD
            const input = buildAllPassingInput({ volumeRatio: 2.0 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.volumeConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when volumeRatio is one epsilon below the minimum', () => {
            // BUILD
            const input = buildAllPassingInput({ volumeRatio: 1.9999 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.volumeConditionMet).toBe(false);
            expect(result.fired).toBe(false);
        });

        it('does not fire when volume condition fails independently; other conditions hold', () => {
            // BUILD — only volume fails
            const input = buildAllPassingInput({ volumeRatio: 0.5 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.volumeConditionMet).toBe(false);
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.maxMoveConditionMet).toBe(true);
            expect(result.fired).toBe(false);
        });
    });

    describe('minMove condition boundary', () => {
        it('fires when abs(vwapDeviationPct) equals exactly the tier minimum', () => {
            // BUILD — deviation exactly at the tier floor
            const input = buildAllPassingInput({ vwapDeviationPct: 0.8 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when abs(vwapDeviationPct) is one epsilon below the tier minimum', () => {
            // BUILD
            const input = buildAllPassingInput({ vwapDeviationPct: 0.7999 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.minMoveConditionMet).toBe(false);
            expect(result.fired).toBe(false);
        });

        it('minMove uses abs so a negative deviation at the floor also passes', () => {
            // BUILD
            const input = buildAllPassingInput({ vwapDeviationPct: -0.8 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when minMove condition fails independently; other conditions hold', () => {
            // BUILD — pct close to zero; sigma and volume still pass
            const input = buildAllPassingInput({ vwapDeviationPct: 0.1 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.minMoveConditionMet).toBe(false);
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.volumeConditionMet).toBe(true);
            expect(result.fired).toBe(false);
        });
    });

    describe('maxMove condition boundary', () => {
        it('fires when abs(vwapDeviationPct) equals exactly the tier maximum', () => {
            // BUILD — deviation at the cap
            const input = buildAllPassingInput({ vwapDeviationPct: 6.0 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.maxMoveConditionMet).toBe(true);
            expect(result.fired).toBe(true);
        });

        it('does not fire when abs(vwapDeviationPct) is one epsilon above the tier maximum', () => {
            // BUILD — just over the cap signals a gap-move / illiquid condition
            const input = buildAllPassingInput({ vwapDeviationPct: 6.0001 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.maxMoveConditionMet).toBe(false);
            expect(result.fired).toBe(false);
        });

        it('maxMove uses abs so a large negative deviation above the cap is also rejected', () => {
            // BUILD
            const input = buildAllPassingInput({ vwapDeviationPct: -7.0 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.maxMoveConditionMet).toBe(false);
            expect(result.fired).toBe(false);
        });

        it('does not fire when maxMove condition fails independently; other conditions hold', () => {
            // BUILD — extreme positive deviation; sigma/volume still satisfy
            const input = buildAllPassingInput({ vwapDeviationPct: 50.0 });
            const params = buildBaselineParams();

            // OPERATE
            const result = evaluateTrigger(input, params);

            // CHECK
            expect(result.maxMoveConditionMet).toBe(false);
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.volumeConditionMet).toBe(true);
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.fired).toBe(false);
        });
    });

    describe('side derivation', () => {
        it('returns ABOVE when vwapDeviationPct is positive', () => {
            const input = buildAllPassingInput({ vwapDeviationPct: 2.5 });

            const result = evaluateTrigger(input, buildBaselineParams());

            expect(result.side).toBe(DeviationSideEnum.ABOVE);
        });

        it('returns BELOW when vwapDeviationPct is negative', () => {
            const input = buildAllPassingInput({ vwapDeviationPct: -2.5 });

            const result = evaluateTrigger(input, buildBaselineParams());

            expect(result.side).toBe(DeviationSideEnum.BELOW);
        });

        it('returns BELOW when vwapDeviationPct is exactly zero', () => {
            // Zero is not positive so the boundary falls to BELOW per the implementation.
            const input = buildAllPassingInput({ vwapDeviationPct: 0 });

            const result = evaluateTrigger(input, buildBaselineParams());

            expect(result.side).toBe(DeviationSideEnum.BELOW);
        });

        it('side is always returned regardless of whether the trigger fired', () => {
            // Even a non-firing evaluation includes a meaningful side field.
            const input = buildAllPassingInput({ vwapDeviationSigma: 0, vwapDeviationPct: 1.5 });

            const result = evaluateTrigger(input, buildBaselineParams());

            expect(result.fired).toBe(false);
            expect(result.side).toBe(DeviationSideEnum.ABOVE);
        });
    });

    describe('determinism', () => {
        it('produces identical output for identical inputs across repeated invocations', () => {
            const input = buildAllPassingInput();
            const params = buildBaselineParams();

            const firstResult = evaluateTrigger(input, params);
            const secondResult = evaluateTrigger(input, params);
            const thirdResult = evaluateTrigger(input, params);

            expect(firstResult).toStrictEqual(secondResult);
            expect(secondResult).toStrictEqual(thirdResult);
        });

        it('produces different output when a single input field changes', () => {
            const params = buildBaselineParams();
            const passing = evaluateTrigger(buildAllPassingInput(), params);
            const failing = evaluateTrigger(buildAllPassingInput({ volumeRatio: 0 }), params);

            expect(passing.fired).not.toBe(failing.fired);
        });
    });

    describe('known candle series fixture', () => {
        // Hand-computed fixture: ETH/USDT:USDT 5-min bar.
        // close = 3 100, VWAP = 3 038.46 → deviation = +2.02 %
        // rolling σ = 0.78 % → sigma distance = 2.02 / 0.78 ≈ 2.59
        // volume ratio = 4.1 (current bar vs 20-bar avg)
        // Tier-1 bands: min 0.8 %, max 6 %
        it('fires on a hand-verified ETH/USDT:USDT bar that meets all four conditions', () => {
            const input: IClosedBarTriggerInput = {
                symbol: 'ETH/USDT:USDT',
                vwapDeviationSigma: 2.59,
                vwapDeviationPct: 2.02,
                volumeRatio: 4.1,
            };
            const params: ITriggerParams = {
                vwapSigmaTrigger: 2.5,
                volumeRatioMin: 2.0,
                tierMinAbsMovePct: 0.8,
                tierMaxAbsMovePct: 6.0,
            };

            const result = evaluateTrigger(input, params);

            expect(result.fired).toBe(true);
            expect(result.side).toBe(DeviationSideEnum.ABOVE);
            expect(result.sigmaConditionMet).toBe(true);
            expect(result.volumeConditionMet).toBe(true);
            expect(result.minMoveConditionMet).toBe(true);
            expect(result.maxMoveConditionMet).toBe(true);
        });

        it('does not fire on a bar with a large move that exceeds the tier cap (illiquid signal)', () => {
            // Deviation too large: gap-move / illiquid; maxMove condition rejects it.
            const input: IClosedBarTriggerInput = {
                symbol: 'ETH/USDT:USDT',
                vwapDeviationSigma: 5.0,
                vwapDeviationPct: 8.5, // above tier-1 max of 6 %
                volumeRatio: 6.0,
            };
            const params: ITriggerParams = {
                vwapSigmaTrigger: 2.5,
                volumeRatioMin: 2.0,
                tierMinAbsMovePct: 0.8,
                tierMaxAbsMovePct: 6.0,
            };

            const result = evaluateTrigger(input, params);

            expect(result.fired).toBe(false);
            expect(result.maxMoveConditionMet).toBe(false);
        });
    });
});
