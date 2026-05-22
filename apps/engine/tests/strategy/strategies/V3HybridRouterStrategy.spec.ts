import { DeviationSideEnum, FlowTypeEnum, PositionSideEnum, RegimeLabelEnum, SignalActionEnum, SkipReasonEnum, StrategyDirectionEnum } from '@bot/shared';

import { V3HybridRouterStrategy } from '../../../src/strategy/strategies/V3HybridRouterStrategy';
import { IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams, buildSnapshot } from '../support/fixtures';

function buildStrategy(): V3HybridRouterStrategy {
    return new V3HybridRouterStrategy();
}

function buildInput(overrides: Partial<IStrategyInput> = {}): IStrategyInput {
    return {
        event: buildEvent(),
        snapshot: buildSnapshot({ signal_score: 65 }),
        openPosition: null,
        params: buildParams(),
        nowMs: 1_716_307_500_000,
        ...overrides,
    };
}

// Exhaustion-confirmed event state (all three confirmations hold).
function buildExhaustionConfirmedEvent(extraOverrides: Partial<ReturnType<typeof buildEvent>> = {}) {
    return buildEvent({
        side: DeviationSideEnum.ABOVE,
        bollingerPctB: 0.9,
        volumeRatio: 0.8,
        openInterestChange5mPct: -1.0,
        regimeLabel: RegimeLabelEnum.RANGING,
        idiosyncrasyScore: 0.2,
        ...extraOverrides,
    });
}

describe('V3HybridRouterStrategy', () => {
    describe('identity', () => {
        it('has name volatility-vwap, version 3, hybrid direction', () => {
            const strategy = buildStrategy();

            expect(strategy.name).toBe('volatility-vwap');
            expect(strategy.version).toBe(3);
            expect(strategy.direction).toBe(StrategyDirectionEnum.HYBRID);
        });
    });

    describe('routing — forced_exhaustion → mean-reversion path', () => {
        it('emits OPEN SHORT (fade) for forced_exhaustion with ABOVE deviation and exhaustion confirmed', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildExhaustionConfirmedEvent({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.SHORT);
        });

        it('passes through regime suppression on forced_exhaustion route', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildExhaustionConfirmedEvent({
                    flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                    regimeLabel: RegimeLabelEnum.TRENDING_UP, // SHORT suppressed in uptrend
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.REGIME_SUPPRESSED);
        });

        it('passes through no-exhaustion skip on forced_exhaustion route', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({
                    flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 1.3, // outside band
                    volumeRatio: 2.5, // elevated
                    openInterestChange5mPct: 0.5, // OI rising
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
        });
    });

    describe('routing — trend_initiation → momentum path', () => {
        it('emits OPEN LONG (follow) for trend_initiation with ABOVE deviation in non-ranging regime', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({
                    flowType: FlowTypeEnum.TREND_INITIATION,
                    side: DeviationSideEnum.ABOVE,
                    regimeLabel: RegimeLabelEnum.TRENDING_UP,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.LONG);
        });

        it('emits OPEN SHORT (follow down) for trend_initiation with BELOW deviation', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({
                    flowType: FlowTypeEnum.TREND_INITIATION,
                    side: DeviationSideEnum.BELOW,
                    regimeLabel: RegimeLabelEnum.TRENDING_DOWN,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.SHORT);
        });

        it('passes through momentum ranging suppression on trend_initiation route', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({
                    flowType: FlowTypeEnum.TREND_INITIATION,
                    side: DeviationSideEnum.ABOVE,
                    regimeLabel: RegimeLabelEnum.RANGING, // momentum suppressed in ranging
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.REGIME_SUPPRESSED);
        });
    });

    describe('routing — skip flows', () => {
        it('skips with FLOW_ROUTED_SKIP for market_beta', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ flowType: FlowTypeEnum.MARKET_BETA }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        });

        it('skips with FLOW_ROUTED_SKIP for catalyst_risk', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ flowType: FlowTypeEnum.CATALYST_RISK }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        });

        it('skips with FLOW_ROUTED_SKIP for low_quality_noise', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ flowType: FlowTypeEnum.LOW_QUALITY_NOISE }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        });
    });

    describe('v3 reads the stamped flowType, never re-classifies', () => {
        it('routes based on the pre-stamped flowType field, not event market data', () => {
            const strategy = buildStrategy();

            // Market data would classify this as FORCED_EXHAUSTION (OI falling),
            // but the pre-stamped flowType is TREND_INITIATION — v3 must follow the stamp.
            const input = buildInput({
                event: buildEvent({
                    flowType: FlowTypeEnum.TREND_INITIATION, // stamp overrides raw signals
                    openInterestChange5mPct: -2.0, // would be forced_exhaustion raw
                    side: DeviationSideEnum.ABOVE,
                    regimeLabel: RegimeLabelEnum.TRENDING_UP,
                }),
            });

            const signal = strategy.evaluate(input);

            // If v3 re-classified it would pick FORCED_EXHAUSTION → SHORT (fade).
            // Since it reads the stamp → TREND_INITIATION → momentum → LONG.
            expect(signal.tradeSide).toBe(PositionSideEnum.LONG);
        });
    });

    describe('skip invariants', () => {
        it('every SKIP carries a non-null skipReason', () => {
            const strategy = buildStrategy();

            const flowSkip = strategy.evaluate(buildInput({ event: buildEvent({ flowType: FlowTypeEnum.CATALYST_RISK }) }));
            const regimeSkip = strategy.evaluate(
                buildInput({
                    event: buildExhaustionConfirmedEvent({
                        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                        regimeLabel: RegimeLabelEnum.TRENDING_UP,
                    }),
                }),
            );

            expect(flowSkip.skipReason).not.toBeNull();
            expect(regimeSkip.skipReason).not.toBeNull();
        });

        it('every OPEN has null skipReason, non-null tradeSide, and non-null proposedExit', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildExhaustionConfirmedEvent({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.skipReason).toBeNull();
            expect(signal.tradeSide).not.toBeNull();
            expect(signal.proposedExit).not.toBeNull();
        });
    });

    describe('determinism', () => {
        it('returns identical signals on two calls with the same input', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildExhaustionConfirmedEvent({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }),
            });

            const first = strategy.evaluate(input);
            const second = strategy.evaluate(input);

            expect(first.action).toBe(second.action);
            expect(first.tradeSide).toBe(second.tradeSide);
        });
    });
});
