/**
 * M2 Adversarial — Surface 1: NUMERIC ↔ Decimal transformer at column boundaries.
 *
 * ADR 0002 §money-as-decimal: "no float reaches a NUMERIC column."
 * Each test falsifies a specific path in decimalColumnTransformer that the
 * happy-path suite does not exercise.
 *
 * Adversarial categories covered:
 *   - Boundary: negative-zero, MAX_SAFE_INTEGER float, exact-zero string
 *   - Malformed: NaN string, Infinity string, exponent-notation string
 *   - Explicit-JS-number rejection: every numeric JS primitive is a float risk
 *   - Precision guard: values exceeding declared NUMERIC(38,18) scale
 */

import { decimalColumnTransformer } from '../../../src/common/utils/decimalColumnTransformer';
import { MoneyTransformerException } from '../../../src/common/exception';
import { Money, parseMoney } from '../../../src/common/utils/money';

const { to, from } = decimalColumnTransformer;

// ---------------------------------------------------------------------------
// Surface 1a — JS number variants reaching to()
// ADR 0002 §money-as-decimal: no float reaches a NUMERIC column.
// ---------------------------------------------------------------------------
describe('decimalColumnTransformer.to — adversarial JS-number rejection (ADR 0002 §money-as-decimal)', () => {
    it('rejects negative-zero JS number to prevent silent sign ambiguity in NUMERIC column', () => {
        // -0 === 0 in JS but encodes differently in some drivers; the transformer
        // must reject it before it reaches the wire.
        expect(() => to(-0 as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects Number.MAX_SAFE_INTEGER because it is a float and will corrupt NUMERIC precision', () => {
        expect(() => to(Number.MAX_SAFE_INTEGER as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects Number.POSITIVE_INFINITY — a float that cannot round-trip through NUMERIC', () => {
        expect(() => to(Number.POSITIVE_INFINITY as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects Number.NEGATIVE_INFINITY — same reasoning as POSITIVE_INFINITY', () => {
        expect(() => to(Number.NEGATIVE_INFINITY as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects NaN — a JS number that would silently land as NULL or raise in Postgres', () => {
        expect(() => to(Number.NaN as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects the integer literal 1 (a JS number) — no special-casing for "safe" ints', () => {
        // A future caller might argue "1 is exact as a float." The transformer must
        // reject ALL numbers to keep the invariant simple and unconditional.
        expect(() => to(1 as unknown as null)).toThrow(MoneyTransformerException);
    });
});

// ---------------------------------------------------------------------------
// Surface 1b — Exponent-notation strings reaching to()
// ADR 0002 §money-as-decimal: only plain decimal strings are accepted.
// ---------------------------------------------------------------------------
describe('decimalColumnTransformer.to — adversarial exponent-notation string inputs', () => {
    it('accepts "1e2" string because decimal.js parses it as 100 (lossless)', () => {
        // decimal.js accepts exponential notation; the transformer normalises it to
        // plain form via formatMoney → toFixed(). The result must be "100", not "1e+2".
        const result = to('1e2' as unknown as null);

        expect(result).toBe('100');
        expect(result).not.toContain('e');
    });

    it('normalises "1.5e3" to "1500" — no exponent form reaches the DB column', () => {
        const result = to('1.5e3' as unknown as null);

        expect(result).toBe('1500');
        expect(result).not.toContain('e');
    });

    it('normalises a very small exponent string to its plain form — no float truncation', () => {
        // "1e-10" must not become "0" or "1e-10" in the DB column.
        const result = to('1e-10' as unknown as null);

        expect(result).not.toContain('e');
        expect(result).toBe('0.0000000001');
    });
});

// ---------------------------------------------------------------------------
// Surface 1c — NaN and Infinity as string inputs to to()
// ADR 0002 §money-as-decimal: upstream computation may produce NaN/Infinity as
// a string; the transformer must refuse both before they corrupt NUMERIC columns.
// decimal.js parses "NaN"/"Infinity"/"-Infinity" as non-finite Decimal values
// silently — the transformer's isFinite() guard converts that into a typed
// MoneyTransformerException so callers never see a raw pg error.
// ---------------------------------------------------------------------------
describe('decimalColumnTransformer.to — adversarial NaN/Infinity string inputs (ADR 0002 §money-as-decimal)', () => {
    it('rejects to("NaN") with MoneyTransformerException — never reaches Postgres NUMERIC', () => {
        expect(() => to('NaN' as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects to("Infinity") with MoneyTransformerException — never reaches Postgres NUMERIC', () => {
        expect(() => to('Infinity' as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects to("-Infinity") with MoneyTransformerException — never reaches Postgres NUMERIC', () => {
        expect(() => to('-Infinity' as unknown as null)).toThrow(MoneyTransformerException);
    });

    it('rejects a non-finite MoneyValue (0/0) on the to() path — covers the MoneyValue branch, not only strings', () => {
        // A producer that divides by zero hands the transformer a Decimal with
        // isFinite() === false. The guard must fire on this branch too.
        const nonFinite = new Money(0).dividedBy(0);

        expect(nonFinite.isFinite()).toBe(false);
        expect(() => to(nonFinite as unknown as null)).toThrow(MoneyTransformerException);
    });
});

// ---------------------------------------------------------------------------
// Surface 1d — from() with unusual DB values
// ADR 0002 §money-as-decimal: from() is the read path; malformed DB values must
// not silently produce corrupt MoneyValues.
// ---------------------------------------------------------------------------
describe('decimalColumnTransformer.from — adversarial DB read-path inputs', () => {
    it('negative-zero string "-0" round-trips as zero without sign corruption', () => {
        // Postgres NUMERIC normalises -0 to 0; the from() result must be zero.
        const result = from('-0');

        expect(result).not.toBeNull();
        expect(result!.isZero()).toBe(true);
    });

    it('throws or returns a non-null error-state when from() receives an empty string', () => {
        // An empty string is not a valid NUMERIC serialisation. parseMoney wraps
        // the decimal.js error into a typed domain exception.
        expect(() => from('')).toThrow();
    });

    it('rejects from("NaN") with MoneyTransformerException — defends against bypass writes (raw SQL / queryRunner)', () => {
        // The transformer is the only sanctioned write path, but migrations and raw
        // queryRunner inserts can land non-finite values directly. The read-path
        // guard ensures such rows surface as a typed domain error, not a corrupt
        // MoneyValue silently propagated into business logic.
        expect(() => from('NaN')).toThrow(MoneyTransformerException);
    });

    it('preserves precision on a 19-digit mantissa — value within NUMERIC(38,18) column limits', () => {
        // NUMERIC(38,18) stores up to 20 integer digits. A 19-digit mantissa is valid.
        const largeString = '12345678901234567890.123456789012345678';
        const result = from(largeString);

        expect(result).not.toBeNull();
        // toFixed() must reproduce the original string without float truncation.
        expect(result!.toFixed()).toBe(largeString);
    });
});

// ---------------------------------------------------------------------------
// Surface 1e — Boundary: exact precision limits
// ADR 0002 §money-as-decimal: values at exactly the declared precision boundary
// must round-trip without loss or silent truncation.
// ---------------------------------------------------------------------------
describe('decimalColumnTransformer — boundary precision round-trips', () => {
    it('round-trips 18 decimal places without loss (declared scale = 18)', () => {
        // NUMERIC(38,18) has scale = 18. A value with exactly 18 decimal digits must
        // survive to() → from() intact.
        const maxScale = '1.123456789012345678'; // 18 decimal digits
        const result = from(to(parseMoney(maxScale)) as string);

        expect(result!.toFixed()).toBe(maxScale);
    });

    it('round-trips maximum integer digits (20 digits, within NUMERIC(38,18) integer part)', () => {
        const maxInt = '12345678901234567890'; // 20 integer digits
        const result = from(to(parseMoney(maxInt)) as string);

        expect(result!.toFixed()).toBe(maxInt);
    });

    it('round-trips negative value with 18 decimal places without sign loss', () => {
        const negMaxScale = '-0.999999999999999999';
        const result = from(to(parseMoney(negMaxScale)) as string);

        expect(result!.toFixed()).toBe(negMaxScale);
    });
});
