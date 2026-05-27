// M12 W1 — CursorCodec round-trip + tamper-resistance smoke tests.

import { decodeCursor, encodeCursor } from '../../src/util/CursorCodec';

describe('CursorCodec', () => {
    it('round-trips a numeric id + millis tuple', () => {
        const payload = { id: 12345, createdAtMs: 1_700_000_000_000 };
        const cursor = encodeCursor(payload);
        const decoded = decodeCursor(cursor);

        expect(decoded).toEqual(payload);
    });

    it('round-trips a numeric-string id (bigint-shaped)', () => {
        // why: string ids must currently match /^[0-9]+$/ to keep non-numeric
        // forged ids out of the downstream `::bigint` cast in listPositions.
        // The constraint relaxes when BaseRepository UUID-PK widening lands.
        const payload = { id: '90071992547409921', createdAtMs: 1_700_000_000_000 };
        const cursor = encodeCursor(payload);

        expect(decodeCursor(cursor)).toEqual(payload);
    });

    it('rejects non-numeric string ids (e.g. uuid-shaped, hex) to keep them out of the ::bigint cast', () => {
        const uuidShaped = Buffer.from(JSON.stringify({ id: 'abc-123-def', createdAtMs: 1 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');
        const hexShaped = Buffer.from(JSON.stringify({ id: 'deadbeef', createdAtMs: 1 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');
        const withInjection = Buffer.from(JSON.stringify({ id: '1; DROP TABLE x;--', createdAtMs: 1 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(uuidShaped)).toBeNull();
        expect(decodeCursor(hexShaped)).toBeNull();
        expect(decodeCursor(withInjection)).toBeNull();
    });

    it('returns null for empty / null / undefined cursors', () => {
        expect(decodeCursor(null)).toBeNull();
        expect(decodeCursor(undefined)).toBeNull();
        expect(decodeCursor('')).toBeNull();
    });

    it('returns null for malformed base64', () => {
        expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    });

    it('returns null for cursors over the 256-char raw cap', () => {
        const oversize = 'a'.repeat(300);

        expect(decodeCursor(oversize)).toBeNull();
    });

    it('returns null when payload JSON lacks required fields', () => {
        const bogus = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(bogus)).toBeNull();
    });

    it('returns null for negative numeric ids', () => {
        const payload = Buffer.from(JSON.stringify({ id: -1, createdAtMs: 1 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(payload)).toBeNull();
    });

    it('returns null for non-integer createdAtMs', () => {
        const payload = Buffer.from(JSON.stringify({ id: 1, createdAtMs: 1.5 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(payload)).toBeNull();
    });

    it('round-trips a filterHash when present', () => {
        const payload = { id: 12345, createdAtMs: 1_700_000_000_000, filterHash: 'abcd1234' };
        const cursor = encodeCursor(payload);

        expect(decodeCursor(cursor)).toEqual(payload);
    });

    it('omits filterHash from the wire when undefined (legacy shape preserved)', () => {
        const cursor = encodeCursor({ id: 1, createdAtMs: 1 });
        const decoded = decodeCursor(cursor);

        expect(decoded).toEqual({ id: 1, createdAtMs: 1 });
        expect(decoded).not.toHaveProperty('filterHash');
    });

    it('returns null for an over-long filterHash field', () => {
        const payload = Buffer.from(JSON.stringify({ id: 1, createdAtMs: 1, filterHash: 'x'.repeat(100) }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(payload)).toBeNull();
    });

    it('returns null for over-long string ids', () => {
        const payload = Buffer.from(JSON.stringify({ id: 'x'.repeat(100), createdAtMs: 1 }), 'utf8')
            .toString('base64')
            .replace(/=+$/u, '');

        expect(decodeCursor(payload)).toBeNull();
    });
});
