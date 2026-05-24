import { fnv1a32, mulberry32 } from '../rng';

describe('mulberry32', () => {
    it('returns the same sequence for the same seed', () => {
        const a = mulberry32(42);
        const b = mulberry32(42);
        const seqA = Array.from({ length: 20 }, () => a());
        const seqB = Array.from({ length: 20 }, () => b());

        expect(seqB).toEqual(seqA);
    });

    it('returns a different sequence for a different seed', () => {
        const a = mulberry32(1);
        const b = mulberry32(2);
        const seqA = Array.from({ length: 20 }, () => a());
        const seqB = Array.from({ length: 20 }, () => b());

        expect(seqB).not.toEqual(seqA);
    });

    it('yields values strictly within [0, 1) over a large sample', () => {
        const rng = mulberry32(7);

        for (let i = 0; i < 50000; i += 1) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('handles seed = 0 without collapsing', () => {
        const rng = mulberry32(0);
        const first = rng();
        const second = rng();

        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(1);
        expect(second).not.toBe(first);
    });
});

describe('fnv1a32', () => {
    it('returns the same hash for the same input', () => {
        expect(fnv1a32('comparison-2026-05-24||pair-1-2')).toBe(fnv1a32('comparison-2026-05-24||pair-1-2'));
    });

    it('returns different hashes for different inputs', () => {
        expect(fnv1a32('pair-1-2')).not.toBe(fnv1a32('pair-1-3'));
    });

    it('matches the published FNV-1a 32-bit test vectors', () => {
        // Reference values from the FNV-1a 32-bit specification.
        expect(fnv1a32('')).toBe(0x811c9dc5);
        expect(fnv1a32('a')).toBe(0xe40c292c);
        expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    });

    it('produces an unsigned 32-bit integer', () => {
        const h = fnv1a32('any-string-at-all');

        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 ** 32);
    });
});
