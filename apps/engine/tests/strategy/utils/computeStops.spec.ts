import { PositionSideEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { computeAtrStop, computeStructuralStop } from '../../../src/strategy/utils/computeStops';

// ─── ATR stop ────────────────────────────────────────────────────────────────

describe('computeAtrStop', () => {
    describe('LONG side — stop below entry', () => {
        it('returns entry - atr * multiplier for a long', () => {
            const entry = new Money('30000.00');
            const atr = new Money('450.00');

            const stop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 1.5);

            // 30000 - 450 × 1.5 = 30000 - 675 = 29325
            expect(stop.toFixed()).toBe('29325');
        });

        it('uses exact decimal arithmetic — no float drift', () => {
            // 0.1 + 0.2 famously drifts in float; decimal.js should be exact
            const entry = new Money('0.30');
            const atr = new Money('0.10');

            const stop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 2.0);

            // 0.30 - 0.10 × 2 = 0.30 - 0.20 = 0.10 (exactly, no float drift)
            expect(stop.equals(new Money('0.10'))).toBe(true);
        });

        it('stop is less than entry for a long', () => {
            const entry = new Money('100.00');
            const atr = new Money('5.00');

            const stop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 1.0);

            expect(stop.lessThan(entry)).toBe(true);
        });

        it('handles a zero ATR edge case — stop equals entry', () => {
            const entry = new Money('500.00');
            const atr = new Money('0.00');

            const stop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 2.0);

            expect(stop.equals(new Money('500.00'))).toBe(true);
        });
    });

    describe('SHORT side — stop above entry', () => {
        it('returns entry + atr * multiplier for a short', () => {
            const entry = new Money('30000.00');
            const atr = new Money('450.00');

            const stop = computeAtrStop(PositionSideEnum.SHORT, entry, atr, 1.5);

            // 30000 + 450 × 1.5 = 30000 + 675 = 30675
            expect(stop.toFixed()).toBe('30675');
        });

        it('stop is greater than entry for a short', () => {
            const entry = new Money('100.00');
            const atr = new Money('5.00');

            const stop = computeAtrStop(PositionSideEnum.SHORT, entry, atr, 1.0);

            expect(stop.greaterThan(entry)).toBe(true);
        });
    });

    describe('boundary values', () => {
        it('multiplier of exactly 1.0 offsets by one ATR', () => {
            const entry = new Money('1000.00');
            const atr = new Money('50.00');

            const longStop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 1.0);
            const shortStop = computeAtrStop(PositionSideEnum.SHORT, entry, atr, 1.0);

            expect(longStop.toFixed()).toBe('950');
            expect(shortStop.toFixed()).toBe('1050');
        });

        it('large entry price retains precision (no overflow or drift)', () => {
            const entry = new Money('99999.99');
            const atr = new Money('1000.01');

            const stop = computeAtrStop(PositionSideEnum.LONG, entry, atr, 2.0);

            // 99999.99 - 1000.01 × 2 = 99999.99 - 2000.02 = 97999.97
            expect(stop.toFixed()).toBe('97999.97');
        });
    });
});

// ─── Structural stop ─────────────────────────────────────────────────────────

describe('computeStructuralStop', () => {
    describe('SHORT side — stop above the wick', () => {
        it('returns wickPrice × (1 + buffer%) when below hard cap', () => {
            // entry=30000, wick=30400, buffer=0.3%, hardCap=2%
            const entry = new Money('30000.00');
            const wick = new Money('30400.00');

            const stop = computeStructuralStop(PositionSideEnum.SHORT, entry, wick, 0.3, 2.0);

            // raw = 30400 × (1 + 0.003) = 30400 × 1.003 = 30491.2
            // hardCap = 30000 × (1 + 0.02) = 30600
            // short: min(raw, hardCap) = min(30491.2, 30600) = 30491.2
            expect(stop.toFixed()).toBe('30491.2');
        });

        it('clamps to hard cap when structural distance exceeds it', () => {
            // wide wick that would push raw stop far above the cap
            const entry = new Money('30000.00');
            const wick = new Money('32000.00'); // wick is 6.67% above entry

            const stop = computeStructuralStop(PositionSideEnum.SHORT, entry, wick, 0.3, 2.0);

            // raw = 32000 × 1.003 = 32096
            // hardCap = 30000 × 1.02 = 30600
            // short: min(32096, 30600) = 30600
            expect(stop.toFixed()).toBe('30600');
        });

        it('stop is above entry for a short', () => {
            const entry = new Money('10000.00');
            const wick = new Money('10500.00');

            const stop = computeStructuralStop(PositionSideEnum.SHORT, entry, wick, 0.3, 2.0);

            expect(stop.greaterThan(entry)).toBe(true);
        });

        it('hard cap boundary — raw equals hard cap produces hard cap exactly', () => {
            // Make raw == hardCap exactly: wick × (1 + buffer) == entry × (1 + hardCap)
            // entry=10000, hardCap=2% → hardCap stop = 10200
            // Need wick × 1.003 = 10200 → wick = 10200 / 1.003 ≈ 10169.49...
            // Use a value that makes them exactly equal by picking wick = 10200 and buffer = 0%
            const entry = new Money('10000.00');
            const wick = new Money('10200.00');

            const stop = computeStructuralStop(PositionSideEnum.SHORT, entry, wick, 0.0, 2.0);

            // raw = 10200 × 1.0 = 10200; hardCap = 10000 × 1.02 = 10200 → equal
            expect(stop.toFixed()).toBe('10200');
        });
    });

    describe('LONG side — stop below the wick', () => {
        it('returns wickPrice × (1 - buffer%) when above hard cap floor', () => {
            // entry=30000, wick=28800 (lower band), buffer=0.3%, hardCap=2%
            const entry = new Money('30000.00');
            const wick = new Money('28800.00');

            const stop = computeStructuralStop(PositionSideEnum.LONG, entry, wick, 0.3, 2.0);

            // raw = 28800 × (1 - 0.003) = 28800 × 0.997 = 28713.6
            // hardCap = 30000 × (1 - 0.02) = 29400
            // long: max(raw, hardCap) = max(28713.6, 29400) = 29400
            expect(stop.toFixed()).toBe('29400');
        });

        it('uses raw stop when it sits above the hard cap floor (wick not too far away)', () => {
            // entry=30000, wick=29900 (close to entry), buffer=0.3%, hardCap=2%
            const entry = new Money('30000.00');
            const wick = new Money('29900.00');

            const stop = computeStructuralStop(PositionSideEnum.LONG, entry, wick, 0.3, 2.0);

            // raw = 29900 × 0.997 = 29810.3
            // hardCap = 30000 × 0.98 = 29400
            // long: max(29810.3, 29400) = 29810.3
            expect(stop.toFixed()).toBe('29810.3');
        });

        it('stop is below entry for a long', () => {
            const entry = new Money('10000.00');
            const wick = new Money('9800.00');

            const stop = computeStructuralStop(PositionSideEnum.LONG, entry, wick, 0.3, 2.0);

            expect(stop.lessThan(entry)).toBe(true);
        });
    });

    describe('decimal exactness — no float drift', () => {
        it('buffer and hard cap calculations are decimal-exact', () => {
            // Use values that would drift in float arithmetic
            const entry = new Money('1.00');
            const wick = new Money('1.03');

            const stop = computeStructuralStop(PositionSideEnum.SHORT, entry, wick, 0.1, 5.0);

            // raw = 1.03 × 1.001 = 1.03103
            // hardCap = 1.00 × 1.05 = 1.05
            // short: min(1.03103, 1.05) = 1.03103
            expect(stop.toFixed()).toBe('1.03103');
        });
    });
});
