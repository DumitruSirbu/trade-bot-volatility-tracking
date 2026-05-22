import {
    Money,
    MoneyValue,
    parseMoney,
    formatMoney,
    addMoney,
    subtractMoney,
    multiplyMoney,
    compareMoney,
    isGreaterThanMoney,
} from '../../../src/common/utils/money';
import { MONEY_PRECISION, MONEY_ROUNDING } from '../../../src/common/const';
import { MoneyParseException } from '../../../src/common/exception';

function m(value: string | MoneyValue) {
    return parseMoney(value);
}

describe('Money constants', () => {
    it('Money instance uses MONEY_PRECISION significant digits', () => {
        const instance = new Money(1);

        expect(Money.precision).toBe(MONEY_PRECISION);
        expect(instance.constructor).toBe(Money);
    });

    it('Money instance uses MONEY_ROUNDING (ROUND_DOWN = 1)', () => {
        expect(MONEY_ROUNDING).toBe(1);
    });
});

describe('parseMoney', () => {
    it('parses a valid string into a MoneyValue', () => {
        const result = m('123.45');

        expect(result.toString()).toBe('123.45');
    });

    it('parses a numeric zero string', () => {
        const result = m('0');

        expect(result.isZero()).toBe(true);
    });

    it('parses a negative string', () => {
        const result = m('-50.00');

        expect(result.isNegative()).toBe(true);
        expect(result.toString()).toBe('-50');
    });

    it('parses an integer-valued string', () => {
        const result = m('42');

        expect(result.toString()).toBe('42');
    });

    it('parses a very small value without losing precision', () => {
        const result = m('0.00000001');

        // toFixed() avoids exponential notation (e.g. 1e-8) for small values
        expect(result.toFixed()).toBe('0.00000001');
    });

    it('parses a very large value without float overflow', () => {
        const large = '99999999999999999999.99999999';
        const result = m(large);

        expect(result.toString()).toBe(large);
    });

    it('parses an existing MoneyValue', () => {
        const original = m('10.5');
        const result = m(original);

        expect(result.toString()).toBe('10.5');
    });

    it('throws a typed MoneyParseException naming the offending input for an invalid string', () => {
        expect(() => parseMoney('not-a-number')).toThrow(MoneyParseException);
        expect(() => parseMoney('not-a-number')).toThrow(/not-a-number/);
    });
});

describe('formatMoney', () => {
    it('formats a whole number without trailing decimal', () => {
        const result = formatMoney(m('100'));

        expect(result).toBe('100');
    });

    it('formats a decimal value preserving scale', () => {
        const result = formatMoney(m('99.5'));

        expect(result).toBe('99.5');
    });

    it('round-trips through parseMoney and formatMoney for typical price', () => {
        const original = '12345.6789';
        const result = formatMoney(m(original));

        expect(result).toBe(original);
    });

    it('round-trips through parseMoney and formatMoney for zero', () => {
        expect(formatMoney(m('0'))).toBe('0');
    });

    it('round-trips through parseMoney and formatMoney for negative value', () => {
        expect(formatMoney(m('-1.23'))).toBe('-1.23');
    });
});

describe('addMoney', () => {
    it('adds two positive values correctly', () => {
        const result = addMoney(m('10.5'), m('2.5'));

        expect(result.toString()).toBe('13');
    });

    it('adding zero returns the original value', () => {
        const result = addMoney(m('42'), m('0'));

        expect(result.toString()).toBe('42');
    });

    it('adding a negative value produces a net reduction', () => {
        const result = addMoney(m('100'), m('-30'));

        expect(result.toString()).toBe('70');
    });

    it('returns a new MoneyValue and does not mutate the left operand', () => {
        const left = m('10');
        addMoney(left, m('5'));

        expect(left.toString()).toBe('10');
    });
});

describe('subtractMoney', () => {
    it('subtracts right from left correctly', () => {
        const result = subtractMoney(m('50'), m('20'));

        expect(result.toString()).toBe('30');
    });

    it('subtracting zero returns the original value', () => {
        const result = subtractMoney(m('50'), m('0'));

        expect(result.toString()).toBe('50');
    });

    it('produces a negative result when right is larger than left', () => {
        const result = subtractMoney(m('10'), m('15'));

        expect(result.isNegative()).toBe(true);
        expect(result.toString()).toBe('-5');
    });

    it('subtracting a value from itself yields zero', () => {
        const result = subtractMoney(m('99.99'), m('99.99'));

        expect(result.isZero()).toBe(true);
    });
});

describe('multiplyMoney', () => {
    it('multiplies two positive values', () => {
        const result = multiplyMoney(m('3'), m('4'));

        expect(result.toString()).toBe('12');
    });

    it('multiplying by zero yields zero', () => {
        const result = multiplyMoney(m('1234.56'), m('0'));

        expect(result.isZero()).toBe(true);
    });

    it('multiplying by one returns the original value', () => {
        const result = multiplyMoney(m('77.77'), m('1'));

        expect(result.toString()).toBe('77.77');
    });

    it('truncates (ROUND_DOWN) rather than rounding up on the last digit', () => {
        // 0.1 * 0.3 = 0.03 (exact with decimal.js), not 0.030000...4 (float)
        const result = multiplyMoney(m('0.1'), m('0.3'));

        expect(result.toString()).toBe('0.03');
    });

    it('multiplying a negative by a positive yields a negative result', () => {
        const result = multiplyMoney(m('-5'), m('3'));

        expect(result.isNegative()).toBe(true);
        expect(result.toString()).toBe('-15');
    });
});

describe('compareMoney', () => {
    it('returns -1 when left is less than right', () => {
        expect(compareMoney(m('1'), m('2'))).toBe(-1);
    });

    it('returns 0 when left equals right', () => {
        expect(compareMoney(m('5'), m('5'))).toBe(0);
    });

    it('returns 1 when left is greater than right', () => {
        expect(compareMoney(m('10'), m('9'))).toBe(1);
    });

    it('returns 0 when comparing zero values expressed differently', () => {
        expect(compareMoney(m('0'), m('0.0'))).toBe(0);
    });

    it('compares negative values correctly', () => {
        expect(compareMoney(m('-1'), m('-2'))).toBe(1);
    });
});

describe('isGreaterThanMoney', () => {
    it('returns true when left is strictly greater than right', () => {
        expect(isGreaterThanMoney(m('10'), m('9'))).toBe(true);
    });

    it('returns false when left equals right', () => {
        expect(isGreaterThanMoney(m('5'), m('5'))).toBe(false);
    });

    it('returns false when left is less than right', () => {
        expect(isGreaterThanMoney(m('3'), m('4'))).toBe(false);
    });

    it('handles negative boundary: negative less than zero is not greater', () => {
        expect(isGreaterThanMoney(m('-0.01'), m('0'))).toBe(false);
    });

    it('handles negative boundary: zero is greater than negative', () => {
        expect(isGreaterThanMoney(m('0'), m('-0.01'))).toBe(true);
    });
});
