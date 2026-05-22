import {
    DeviationSideEnum,
    FlowTypeEnum,
    PositionSideEnum,
    RegimeLabelEnum,
    SignalActionEnum,
    SignalTypeEnum,
    SkipReasonEnum,
    StopTypeEnum,
    StrategyDirectionEnum,
} from '@bot/shared';

import { V2MomentumStrategy } from '../../../src/strategy/strategies/V2MomentumStrategy';
import { IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams, buildSnapshot } from '../support/fixtures';

function buildStrategy(): V2MomentumStrategy {
    return new V2MomentumStrategy();
}

function buildInput(overrides: Partial<IStrategyInput> = {}): IStrategyInput {
    return {
        event: buildEvent({
            side: DeviationSideEnum.ABOVE,
            regimeLabel: RegimeLabelEnum.TRENDING_UP, // not ranging → momentum works
            flowType: FlowTypeEnum.TREND_INITIATION,
        }),
        snapshot: buildSnapshot({ signal_score: 70 }),
        openPosition: null,
        params: buildParams(),
        nowMs: 1_716_307_500_000,
        ...overrides,
    };
}

describe('V2MomentumStrategy', () => {
    describe('identity', () => {
        it('has name volatility-vwap, version 2, momentum direction', () => {
            const strategy = buildStrategy();

            expect(strategy.name).toBe('volatility-vwap');
            expect(strategy.version).toBe(2);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MOMENTUM);
        });
    });

    describe('direction — follows the spike', () => {
        it('emits LONG when deviation side is ABOVE (follows up)', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ side: DeviationSideEnum.ABOVE, regimeLabel: RegimeLabelEnum.TRENDING_UP }) });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.LONG);
        });

        it('emits SHORT when deviation side is BELOW (follows down)', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    vwapDeviationSigma: -2.5,
                    regimeLabel: RegimeLabelEnum.TRENDING_DOWN,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.SHORT);
        });

        it('resolves VWAP_DEVIATION_LONG_BIAS signal type for ABOVE deviation', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS);
        });

        it('resolves VWAP_DEVIATION_SHORT_BIAS signal type for BELOW deviation', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ side: DeviationSideEnum.BELOW, regimeLabel: RegimeLabelEnum.TRENDING_DOWN }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS);
        });
    });

    describe('regime gate — ranging suppresses momentum', () => {
        it('skips with REGIME_SUPPRESSED in ranging regime', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ regimeLabel: RegimeLabelEnum.RANGING }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.REGIME_SUPPRESSED);
        });

        it('opens in trending_up regime — no suppression', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ side: DeviationSideEnum.ABOVE, regimeLabel: RegimeLabelEnum.TRENDING_UP }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('opens in trending_down regime — no suppression', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ side: DeviationSideEnum.ABOVE, regimeLabel: RegimeLabelEnum.TRENDING_DOWN }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('opens in transitioning regime — no suppression', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ regimeLabel: RegimeLabelEnum.TRANSITIONING }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });
    });

    describe('skip invariants', () => {
        it('SKIP carries a non-null skipReason', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ regimeLabel: RegimeLabelEnum.RANGING }) });

            const signal = strategy.evaluate(input);

            expect(signal.skipReason).not.toBeNull();
        });

        it('OPEN has null skipReason, non-null tradeSide, and non-null proposedExit', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.skipReason).toBeNull();
            expect(signal.tradeSide).not.toBeNull();
            expect(signal.proposedExit).not.toBeNull();
        });
    });

    describe('proposed exit on OPEN signal', () => {
        it('stop type is STRUCTURAL (SL sits at VWAP, which is a structural level)', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildInput());

            expect(signal.proposedExit!.stopType).toBe(StopTypeEnum.STRUCTURAL);
        });

        it('timeStopAtMs equals nowMs + time_stop_minutes * 60_000', () => {
            const strategy = buildStrategy();
            const nowMs = 1_716_307_500_000;
            const params = buildParams({ time_stop_minutes: 90 });
            const input = buildInput({ nowMs, params });

            const signal = strategy.evaluate(input);

            expect(signal.proposedExit!.timeStopAtMs).toBe(nowMs + 90 * 60_000);
        });

        it('stopLossPrice equals vwapSession (VWAP invalidates momentum thesis)', () => {
            const strategy = buildStrategy();
            const input = buildInput({ event: buildEvent({ vwapSession: '30000.00', regimeLabel: RegimeLabelEnum.TRENDING_UP }) });

            const signal = strategy.evaluate(input);

            // decimal.js toFixed() drops trailing zeros; compare numerically
            expect(signal.proposedExit!.stopLossPrice.equals('30000.00')).toBe(true);
        });
    });

    describe('determinism', () => {
        it('returns identical signals on two calls with the same input', () => {
            const strategy = buildStrategy();
            const input = buildInput();

            const first = strategy.evaluate(input);
            const second = strategy.evaluate(input);

            expect(first.action).toBe(second.action);
            expect(first.tradeSide).toBe(second.tradeSide);
            expect(first.proposedExit!.timeStopAtMs).toBe(second.proposedExit!.timeStopAtMs);
        });

        it('time-stop target is derived from nowMs, not wall clock', () => {
            const strategy = buildStrategy();
            const inputA = buildInput({ nowMs: 100_000 });
            const inputB = buildInput({ nowMs: 200_000 });

            const a = strategy.evaluate(inputA);
            const b = strategy.evaluate(inputB);

            expect(a.proposedExit!.timeStopAtMs).toBe(100_000 + 60 * 60_000);
            expect(b.proposedExit!.timeStopAtMs).toBe(200_000 + 60 * 60_000);
        });
    });

    describe('metadata passthrough', () => {
        it('carries signal_score from snapshot unchanged', () => {
            const strategy = buildStrategy();
            const input = buildInput({ snapshot: buildSnapshot({ signal_score: 88 }) });

            const signal = strategy.evaluate(input);

            expect(signal.signalScore).toBe(88);
        });

        it('carries flowType from the event unchanged on skip', () => {
            const strategy = buildStrategy();
            const input = buildInput({
                event: buildEvent({ regimeLabel: RegimeLabelEnum.RANGING, flowType: FlowTypeEnum.MARKET_BETA }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.flowType).toBe(FlowTypeEnum.MARKET_BETA);
        });
    });
});
