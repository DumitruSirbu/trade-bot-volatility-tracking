import { decimalColumnTransformer } from '../../../src/common/utils/decimalColumnTransformer';
import { MoneyTransformerException } from '../../../src/common/exception';
import { parseMoney } from '../../../src/common/utils/money';

// Convenience alias so tests read clearly.
const { to, from } = decimalColumnTransformer;

describe('decimalColumnTransformer.to (entity → driver / write path)', () => {
    it('converts a MoneyValue to its decimal string representation', () => {
        const value = parseMoney('123.456');

        expect(to(value)).toBe('123.456');
    });

    it('converts null to null', () => {
        expect(to(null)).toBeNull();
    });

    it('converts undefined to null', () => {
        // TypeORM can pass undefined when a nullable column is absent.
        expect(to(undefined as unknown as null)).toBeNull();
    });

    it('throws MoneyTransformerException when a JS number is passed — float-money-leak guard', () => {
        // This is the trading-safety-critical guard: a float would already be
        // corrupted before decimal.js sees it, so we reject it loudly.
        expect(() => to(99.99 as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('thrown MoneyTransformerException carries the MONEY_TRANSFORMER_REJECTED_NUMBER code', () => {
        expect(() => to(0.1 as unknown as null)).toThrow(MoneyTransformerException);

        try {
            to(0.1 as unknown as null);
        } catch (error) {
            expect((error as MoneyTransformerException).code).toBe('MONEY_TRANSFORMER_REJECTED_NUMBER');
        }
    });

    it('accepts a valid numeric decimal string and normalises it', () => {
        // Drivers occasionally round-trip a value back as a string.
        const result = to('42.50000' as unknown as null);

        expect(result).toBe('42.5');
    });

    it('accepts a negative decimal string', () => {
        const result = to('-0.00123' as unknown as null);

        expect(result).toBe('-0.00123');
    });

    it('preserves MoneyValue precision without float drift on an 18-decimal-place value', () => {
        const highPrecision = '1.123456789012345678';
        const value = parseMoney(highPrecision);
        const result = to(value);

        // toFixed() on a Decimal emits all significant decimals without float noise.
        expect(result).not.toContain('e');
        expect(result).toBe(highPrecision);
    });

    it('accepts zero MoneyValue and returns "0"', () => {
        expect(to(parseMoney('0'))).toBe('0');
    });
});

describe('decimalColumnTransformer.from (driver → entity / read path)', () => {
    it('converts a decimal string from the DB into a MoneyValue', () => {
        const result = from('99.99');

        expect(result).not.toBeNull();
        expect(result!.toString()).toBe('99.99');
    });

    it('converts null to null', () => {
        expect(from(null)).toBeNull();
    });

    it('converts undefined to null', () => {
        expect(from(undefined as unknown as null)).toBeNull();
    });

    it('preserves full precision on a high-precision DB value with no float drift', () => {
        const highPrecision = '1.123456789012345678';
        const result = from(highPrecision);

        expect(result).not.toBeNull();
        expect(result!.toFixed()).toBe(highPrecision);
    });

    it('handles a negative DB value correctly', () => {
        const result = from('-500.001');

        expect(result).not.toBeNull();
        expect(result!.isNegative()).toBe(true);
    });

    it('handles zero DB value', () => {
        const result = from('0');

        expect(result).not.toBeNull();
        expect(result!.isZero()).toBe(true);
    });
});

describe('decimalColumnTransformer round-trip (to → from)', () => {
    it('round-trips a typical price value without loss', () => {
        const original = parseMoney('29345.67');
        const serialised = to(original) as string;
        const restored = from(serialised);

        expect(restored).not.toBeNull();
        expect(restored!.equals(original)).toBe(true);
    });

    it('round-trips an 18-decimal-place value with NO float drift', () => {
        const highPrecision = '0.123456789012345678';
        const original = parseMoney(highPrecision);
        const serialised = to(original) as string;
        const restored = from(serialised);

        expect(restored).not.toBeNull();
        // equals() uses decimal-exact comparison, not float ===.
        expect(restored!.equals(original)).toBe(true);
        expect(restored!.toFixed()).toBe(highPrecision);
    });

    it('round-trips zero', () => {
        const original = parseMoney('0');
        const serialised = to(original) as string;
        const restored = from(serialised);

        expect(restored!.isZero()).toBe(true);
    });

    it('round-trips a negative value', () => {
        const original = parseMoney('-12345.6789');
        const serialised = to(original) as string;
        const restored = from(serialised);

        expect(restored!.equals(original)).toBe(true);
    });
});
