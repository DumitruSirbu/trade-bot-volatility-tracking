import { CoinTierEnum, DeviationSideEnum, FlowTypeEnum, RegimeLabelEnum, SignalActionEnum, SignalTypeEnum, SkipReasonEnum } from '@bot/shared';

import { V0BaselineStrategy } from '../../../src/strategy/strategies/V0BaselineStrategy';
import { IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams, buildSnapshot } from '../support/fixtures';

function buildStrategy(): V0BaselineStrategy {
    return new V0BaselineStrategy();
}

function buildInput(overrides: Partial<IStrategyInput> = {}): IStrategyInput {
    return {
        event: buildEvent(),
        snapshot: buildSnapshot({ signal_score: 72 }),
        openPosition: null,
        params: buildParams(),
        nowMs: 1_716_307_500_000,
        ...overrides,
    };
}

describe('V0BaselineStrategy', () => {
    describe('identity', () => {
        it('has name volatility-vwap and version 0', () => {
            const strategy = buildStrategy();

            expect(strategy.name).toBe('volatility-vwap');
            expect(strategy.version).toBe(0);
        });
    });

    describe('always skips — baseline_no_trade', () => {
        it('returns SKIP with BASELINE_NO_TRADE on a standard ABOVE event', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.BASELINE_NO_TRADE);
        });

        it('returns SKIP regardless of a strong positive sigma trigger', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ vwapDeviationSigma: 5.0, volumeRatio: 4.0 }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.BASELINE_NO_TRADE);
        });

        it('returns SKIP for a BELOW deviation event', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ side: DeviationSideEnum.BELOW, vwapDeviationSigma: -3.0 }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.BASELINE_NO_TRADE);
        });

        it('returns SKIP even when regime is trending_up', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ regimeLabel: RegimeLabelEnum.TRENDING_UP }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });

        it('returns SKIP even when flow is trend_initiation', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ flowType: FlowTypeEnum.TREND_INITIATION }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });
    });

    describe('skip-first invariant — skipReason and proposedExit', () => {
        it('skipReason is non-null on every skip', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.skipReason).not.toBeNull();
        });

        it('proposedExit is null on every skip', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.proposedExit).toBeNull();
        });

        it('tradeSide is null on every skip', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.tradeSide).toBeNull();
        });
    });

    describe('signal metadata passthrough', () => {
        it('carries the signal_score from the snapshot unchanged', () => {
            const strategy = buildStrategy();
            const input = buildInput({ snapshot: buildSnapshot({ signal_score: 42 }) });

            const signal = strategy.evaluate(input);

            expect(signal.signalScore).toBe(42);
        });

        it('carries the flowType from the event unchanged', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ flowType: FlowTypeEnum.MARKET_BETA }) });

            const signal = strategy.evaluate(input);

            expect(signal.flowType).toBe(FlowTypeEnum.MARKET_BETA);
        });

        it('resolves VWAP_DEVIATION_LONG_BIAS signal type for ABOVE deviation', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ side: DeviationSideEnum.ABOVE }) });

            const signal = strategy.evaluate(input);

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS);
        });

        it('resolves VWAP_DEVIATION_SHORT_BIAS signal type for BELOW deviation', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ side: DeviationSideEnum.BELOW }),
                snapshot: buildSnapshot({ signal_score: 50 }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS);
        });
    });

    describe('determinism', () => {
        it('returns deeply equal signals on two identical calls', () => {
            const strategy = buildStrategy();
            const input = buildInput();

            const first = strategy.evaluate(input);
            const second = strategy.evaluate(input);

            expect(first).toEqual(second);
        });

        it('does not read the wall clock — result is identical regardless of call time', () => {
            const strategy = buildStrategy();
            const input = buildInput({ nowMs: 9_999_999_999_999 });

            const a = strategy.evaluate(input);
            const b = strategy.evaluate({ ...input, nowMs: 1 });

            // v0 ignores nowMs entirely — both results must equal
            expect(a.action).toBe(b.action);
            expect(a.skipReason).toBe(b.skipReason);
        });
    });

    describe('tier coverage', () => {
        it('returns SKIP for tier-2 coins', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ coinTier: CoinTierEnum.TIER_2 }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });

        it('returns SKIP for tier-3 coins', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ coinTier: CoinTierEnum.TIER_3 }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });
    });
});
