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

import { V1MeanReversionStrategy } from '../../../src/strategy/strategies/V1MeanReversionStrategy';
import { IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams, buildSnapshot } from '../support/fixtures';

// Band re-entry thresholds from strategyConsts.ts (tightened in round-1 review fix).
// ABOVE (pump): confirmed only when bollingerPctB < BAND_REENTRY_UPPER_PCT_B (0.8).
// BELOW (dump): confirmed only when bollingerPctB > BAND_REENTRY_LOWER_PCT_B (0.2).
const BAND_REENTRY_UPPER_PCT_B = 0.8;
const BAND_REENTRY_LOWER_PCT_B = 0.2;

function buildStrategy(): V1MeanReversionStrategy {
    return new V1MeanReversionStrategy();
}

// Exhaustion-confirmed base input: all three confirmation conditions hold.
//   1. pctB = 0.7 → < 0.8 → genuine re-entry for an ABOVE (pump) event
//   2. volumeRatio = 0.8 ≤ 1.0 → volume decelerating
//   3. openInterestChange5mPct = -1.0 ≤ 0 → OI not rising
// NOT a trap (low idiosyncrasy, OI is falling not rising).
// NOT regime-suppressed (RANGING).
function buildConfirmedInput(overrides: Partial<IStrategyInput> = {}): IStrategyInput {
    return {
        event: buildEvent({
            side: DeviationSideEnum.ABOVE,
            regimeLabel: RegimeLabelEnum.RANGING,
            idiosyncrasyScore: 0.2,
            volumeRatio: 0.8,
            openInterestChange5mPct: -1.0,
            bollingerPctB: 0.7, // < 0.8 → genuine band re-entry confirmed
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        }),
        snapshot: buildSnapshot({ signal_score: 60 }),
        openPosition: null,
        params: buildParams(),
        nowMs: 1_716_307_500_000,
        ...overrides,
    };
}

describe('V1MeanReversionStrategy', () => {
    describe('identity', () => {
        it('has name volatility-vwap, version 1, mean_reversion direction', () => {
            const strategy = buildStrategy();

            expect(strategy.name).toBe('volatility-vwap');
            expect(strategy.version).toBe(1);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MEAN_REVERSION);
        });
    });

    describe('direction — fades the spike', () => {
        it('emits SHORT when deviation side is ABOVE (positive sigma)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 0.7,
                    volumeRatio: 0.8,
                    openInterestChange5mPct: -1.0,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.SHORT);
        });

        it('emits LONG when deviation side is BELOW (negative sigma)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    vwapDeviationSigma: -2.5,
                    vwapDeviationPct: -1.5,
                    bollingerPctB: 0.3, // > 0.2 → genuine re-entry for BELOW dump
                    openInterestChange5mPct: -1.0,
                    volumeRatio: 0.8,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.tradeSide).toBe(PositionSideEnum.LONG);
        });

        it('resolves VWAP_DEVIATION_LONG_BIAS signal type for ABOVE deviation', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildConfirmedInput());

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS);
        });

        it('resolves VWAP_DEVIATION_SHORT_BIAS signal type for BELOW deviation', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    bollingerPctB: 0.3,
                    openInterestChange5mPct: -1.0,
                    volumeRatio: 0.8,
                    regimeLabel: RegimeLabelEnum.RANGING,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_SHORT_BIAS);
        });
    });

    describe('exhaustion confirmation — no confirmation → SKIP', () => {
        // "None of the confirmation conditions met": pctB still-pinned (>= 0.8 for ABOVE),
        // volume still elevated (> 1.0), OI still rising (> 0).
        function buildNoConfirmationInput(): IStrategyInput {
            return buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 1.2, // > 0.8 and > 1.0 — outside band, still extended
                    volumeRatio: 2.5, // > 1.0 — still elevated
                    openInterestChange5mPct: 0.5, // > 0 — OI still rising
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });
        }

        it('returns SKIP with NO_EXHAUSTION_CONFIRMATION when no confirmation holds', () => {
            const strategy = buildStrategy();

            const signal = strategy.evaluate(buildNoConfirmationInput());

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
        });

        it('a still-pinned spike (bollingerPctB = 0.95, elevated volume, rising OI) → SKIP', () => {
            // pctB = 0.95 is inside [0,1] but >= 0.8 → NOT confirmed (tightened threshold).
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 0.95, // ≥ 0.8 → NOT confirmed by band re-entry
                    volumeRatio: 2.5, // elevated — NOT confirmed by volume
                    openInterestChange5mPct: 0.5, // rising — NOT confirmed by OI
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
        });

        it('bollingerPctB exactly 1.0 is NOT confirmed (>= BAND_REENTRY_UPPER_PCT_B = 0.8)', () => {
            // pctB = 1.0 means price exactly at the upper band — still pinned, not re-entered.
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 1.0,
                    volumeRatio: 2.5,
                    openInterestChange5mPct: 0.5,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });

        it('opens when ONLY genuine band re-entry holds (bollingerPctB < 0.8 for ABOVE)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 0.7, // < 0.8 → genuinely re-entered
                    volumeRatio: 2.5, // elevated — NOT from volume
                    openInterestChange5mPct: 0.5, // rising — NOT from OI
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('boundary — bollingerPctB exactly at BAND_REENTRY_UPPER_PCT_B (0.8) is NOT confirmed (strict <)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: BAND_REENTRY_UPPER_PCT_B, // exactly 0.8 — not < 0.8
                    volumeRatio: 2.5,
                    openInterestChange5mPct: 0.5,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
        });

        it('opens when ONLY volume deceleration holds (volumeRatio <= 1.0)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 1.3, // outside band — NOT confirmed by band
                    volumeRatio: 1.0, // exactly at deceleration threshold (≤ 1.0)
                    openInterestChange5mPct: 0.5, // rising — NOT confirmed by OI
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('opens when ONLY OI not rising holds (openInterestChange5mPct <= 0)', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 1.3, // outside band
                    volumeRatio: 2.5, // elevated
                    openInterestChange5mPct: 0.0, // exactly at threshold → OI not rising
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('BELOW dump: bollingerPctB > 0.2 is confirmed; pctB <= 0.2 is NOT', () => {
            const strategy = buildStrategy();

            const confirmed = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    bollingerPctB: 0.3, // > 0.2 → re-entered (confirmed)
                    volumeRatio: 2.5,
                    openInterestChange5mPct: 0.5,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });
            const notConfirmed = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    bollingerPctB: BAND_REENTRY_LOWER_PCT_B, // exactly 0.2 — not > 0.2
                    volumeRatio: 2.5,
                    openInterestChange5mPct: 0.5,
                    regimeLabel: RegimeLabelEnum.RANGING,
                    idiosyncrasyScore: 0.2,
                }),
            });

            expect(strategy.evaluate(confirmed).action).toBe(SignalActionEnum.OPEN);
            expect(strategy.evaluate(notConfirmed).action).toBe(SignalActionEnum.SKIP);
        });
    });

    describe('idiosyncratic trap — never fades', () => {
        function buildTrapInput(): IStrategyInput {
            const params = buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 });

            return buildConfirmedInput({
                event: buildEvent({
                    idiosyncrasyScore: 0.8, // ≥ 0.7
                    openInterestChange5mPct: 0.5, // > 0 → OI rising
                    volumeRatio: 2.0, // ≥ 1.5
                    bollingerPctB: 0.7, // < 0.8 → band confirmed (trap fires before exhaustion check)
                    regimeLabel: RegimeLabelEnum.RANGING,
                }),
                params,
            });
        }

        it('returns SKIP with IDIOSYNCRATIC_TRAP on idio + rising OI + elevated volume', () => {
            const strategy = buildStrategy();

            const signal = strategy.evaluate(buildTrapInput());

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.IDIOSYNCRATIC_TRAP);
        });

        it('does NOT trap when idiosyncrasyScore is just below threshold', () => {
            const strategy = buildStrategy();
            const params = buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 });
            const input = buildConfirmedInput({
                event: buildEvent({
                    idiosyncrasyScore: 0.69, // just below threshold
                    openInterestChange5mPct: 0.5, // OI rising
                    volumeRatio: 2.0, // elevated
                    // Need exhaustion confirmed via another signal — use OI=0 (not rising)
                    // Actually, OI is 0.5 (rising) here — need volume decel to confirm.
                    bollingerPctB: 1.3, // pctB not confirming
                    // volume=2.0 > 1.0, not decelerating; OI=0.5 > 0, rising
                    // Only way to confirm: need to change test so exhaustion IS confirmed via OI
                }),
                params,
            });

            // With pctB=1.3, volume=2.0, OI=0.5: no confirmation → SKIP NO_EXHAUSTION
            // This is correct: trap does not fire (idio too low), but exhaustion also fails.
            // The trap NOT firing is what we are testing; the resulting skip reason is NO_EXHAUSTION.
            const signal = strategy.evaluate(input);

            expect(signal.skipReason).not.toBe(SkipReasonEnum.IDIOSYNCRATIC_TRAP);
        });

        it('does NOT trap when OI is not rising (openInterestChange5mPct = 0)', () => {
            const strategy = buildStrategy();
            const params = buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 });
            const input = buildConfirmedInput({
                event: buildEvent({
                    idiosyncrasyScore: 0.9,
                    openInterestChange5mPct: 0.0, // exactly 0 → not rising → trap does not fire
                    volumeRatio: 2.0,
                    bollingerPctB: 0.7, // < 0.8 → exhaustion confirmed via band re-entry
                    regimeLabel: RegimeLabelEnum.RANGING,
                }),
                params,
            });

            const signal = strategy.evaluate(input);

            // Trap does not fire (OI not > 0); exhaustion confirmed via pctB < 0.8 → OPEN
            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('does NOT trap when volumeRatio is just below volume_ratio_min', () => {
            const strategy = buildStrategy();
            const params = buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 });
            const input = buildConfirmedInput({
                event: buildEvent({
                    idiosyncrasyScore: 0.9,
                    openInterestChange5mPct: 0.5, // OI rising
                    volumeRatio: 1.4, // just below 1.5 — trap does not fire
                    bollingerPctB: 0.7, // < 0.8 → exhaustion confirmed
                    regimeLabel: RegimeLabelEnum.RANGING,
                }),
                params,
            });

            const signal = strategy.evaluate(input);

            // Trap does not fire (vol too low); exhaustion confirmed via pctB → OPEN
            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('boundary — idiosyncrasyScore exactly at threshold triggers the trap', () => {
            const strategy = buildStrategy();
            const params = buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 });
            const input = buildConfirmedInput({
                event: buildEvent({
                    idiosyncrasyScore: 0.7, // exactly at threshold (>= is inclusive)
                    openInterestChange5mPct: 0.5,
                    volumeRatio: 2.0,
                    bollingerPctB: 0.7,
                    regimeLabel: RegimeLabelEnum.RANGING,
                }),
                params,
            });

            const signal = strategy.evaluate(input);

            expect(signal.skipReason).toBe(SkipReasonEnum.IDIOSYNCRATIC_TRAP);
        });
    });

    describe('regime gate — suppresses adverse direction', () => {
        it('skips with REGIME_SUPPRESSED when ABOVE deviation in trending_up regime', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    regimeLabel: RegimeLabelEnum.TRENDING_UP,
                    bollingerPctB: 0.7,
                    volumeRatio: 0.8,
                    openInterestChange5mPct: -1.0,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.REGIME_SUPPRESSED);
        });

        it('skips with REGIME_SUPPRESSED when BELOW deviation in trending_down regime', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    regimeLabel: RegimeLabelEnum.TRENDING_DOWN,
                    bollingerPctB: 0.3,
                    openInterestChange5mPct: -1.0,
                    volumeRatio: 0.8,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.SKIP);
            expect(signal.skipReason).toBe(SkipReasonEnum.REGIME_SUPPRESSED);
        });

        it('does NOT suppress a SHORT in trending_down regime', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    regimeLabel: RegimeLabelEnum.TRENDING_DOWN,
                    bollingerPctB: 0.7,
                    volumeRatio: 0.8,
                    openInterestChange5mPct: -1.0,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('does NOT suppress a LONG in trending_up regime', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({
                    side: DeviationSideEnum.BELOW,
                    regimeLabel: RegimeLabelEnum.TRENDING_UP,
                    bollingerPctB: 0.3,
                    openInterestChange5mPct: -1.0,
                    volumeRatio: 0.8,
                }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('opens in ranging regime — no suppression applies', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({ regimeLabel: RegimeLabelEnum.RANGING, bollingerPctB: 0.7, volumeRatio: 0.8, openInterestChange5mPct: -1.0 }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });

        it('opens in transitioning regime — no suppression applies', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput({
                event: buildEvent({ regimeLabel: RegimeLabelEnum.TRANSITIONING, bollingerPctB: 0.7, volumeRatio: 0.8, openInterestChange5mPct: -1.0 }),
            });

            const signal = strategy.evaluate(input);

            expect(signal.action).toBe(SignalActionEnum.OPEN);
        });
    });

    describe('skip invariants', () => {
        it('every SKIP signal carries a non-null skipReason', () => {
            const strategy = buildStrategy();

            // Regime-suppressed skip
            const regime = strategy.evaluate(
                buildConfirmedInput({
                    event: buildEvent({
                        side: DeviationSideEnum.ABOVE,
                        regimeLabel: RegimeLabelEnum.TRENDING_UP,
                        bollingerPctB: 0.7,
                        volumeRatio: 0.8,
                        openInterestChange5mPct: -1.0,
                    }),
                }),
            );
            // Idiosyncratic trap skip
            const trap = strategy.evaluate(
                buildConfirmedInput({
                    event: buildEvent({ idiosyncrasyScore: 0.9, openInterestChange5mPct: 0.5, volumeRatio: 2.0, bollingerPctB: 0.7 }),
                    params: buildParams({ idiosyncrasy_min_score: 0.7, volume_ratio_min: 1.5 }),
                }),
            );
            // No exhaustion confirmation skip
            const noConfirm = strategy.evaluate(
                buildConfirmedInput({
                    event: buildEvent({ bollingerPctB: 1.3, volumeRatio: 2.5, openInterestChange5mPct: 0.5 }),
                }),
            );

            expect(regime.skipReason).not.toBeNull();
            expect(trap.skipReason).not.toBeNull();
            expect(noConfirm.skipReason).not.toBeNull();
        });

        it('every OPEN signal has null skipReason, non-null tradeSide, and non-null proposedExit', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildConfirmedInput());

            expect(signal.action).toBe(SignalActionEnum.OPEN);
            expect(signal.skipReason).toBeNull();
            expect(signal.tradeSide).not.toBeNull();
            expect(signal.proposedExit).not.toBeNull();
        });
    });

    describe('proposed exit on OPEN signal', () => {
        it('stop type is STRUCTURAL', () => {
            const strategy = buildStrategy();
            const signal = strategy.evaluate(buildConfirmedInput());

            expect(signal.proposedExit!.stopType).toBe(StopTypeEnum.STRUCTURAL);
        });

        it('timeStopAtMs equals nowMs + time_stop_minutes * 60_000', () => {
            const strategy = buildStrategy();
            const nowMs = 1_716_307_500_000;
            const params = buildParams({ time_stop_minutes: 60 });
            const input = buildConfirmedInput({ nowMs, params });

            const signal = strategy.evaluate(input);

            expect(signal.proposedExit!.timeStopAtMs).toBe(nowMs + 60 * 60_000);
        });
    });

    describe('determinism', () => {
        it('returns identical action/side/reason on repeated calls with the same input', () => {
            const strategy = buildStrategy();
            const input = buildConfirmedInput();

            const first = strategy.evaluate(input);
            const second = strategy.evaluate(input);

            expect(first.action).toBe(second.action);
            expect(first.tradeSide).toBe(second.tradeSide);
            expect(first.skipReason).toBe(second.skipReason);
        });

        it('time-stop target is derived from nowMs, not wall clock', () => {
            const strategy = buildStrategy();
            const inputA = buildConfirmedInput({ nowMs: 1_000_000 });
            const inputB = buildConfirmedInput({ nowMs: 2_000_000 });

            const signalA = strategy.evaluate(inputA);
            const signalB = strategy.evaluate(inputB);

            expect(signalA.proposedExit!.timeStopAtMs).not.toBe(signalB.proposedExit!.timeStopAtMs);
            expect(signalA.proposedExit!.timeStopAtMs).toBe(1_000_000 + 60 * 60_000);
            expect(signalB.proposedExit!.timeStopAtMs).toBe(2_000_000 + 60 * 60_000);
        });
    });
});
