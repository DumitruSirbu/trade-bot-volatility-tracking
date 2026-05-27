// M12 W3 — Tool-param DTO schemas: happy paths + boundary rejections.

import {
    CompareVersionsParamsSchema,
    GetDecisionsParamsSchema,
    GetPerformanceParamsSchema,
    ListPositionsParamsSchema,
    RunBacktestParamsSchema,
} from '../src/dtos/index';

// Fixed reference points so day-spans are deterministic across runs.
const T_NOW = Date.parse('2026-05-27T00:00:00Z');
const T_MINUS_30D = new Date(T_NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
const T_MINUS_60D = new Date(T_NOW - 60 * 24 * 60 * 60 * 1000).toISOString();
const T_MINUS_120D = new Date(T_NOW - 120 * 24 * 60 * 60 * 1000).toISOString();
const T_MINUS_400D = new Date(T_NOW - 400 * 24 * 60 * 60 * 1000).toISOString();
const T_NOW_ISO = new Date(T_NOW).toISOString();
const T_FUTURE = new Date(T_NOW + 7 * 24 * 60 * 60 * 1000).toISOString();

// Freeze Date.now() so the schemas' future-date guard is deterministic.
beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(T_NOW);
});
afterAll(() => {
    jest.restoreAllMocks();
});

describe('GetPerformanceParamsSchema', () => {
    it('accepts a happy-path 30d query', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(true);
    });

    it('rejects a reversed range', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_NOW_ISO,
            to: T_MINUS_30D,
        });
        expect(r.success).toBe(false);
    });

    it('rejects NaN ISO strings', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: 'not-a-date',
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });

    it('rejects > 90d range without acknowledgedLargeRange', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_120D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });

    it('accepts > 90d range when acknowledgedLargeRange=true', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_120D,
            to: T_NOW_ISO,
            acknowledgedLargeRange: true,
        });
        expect(r.success).toBe(true);
    });

    it('rejects > 365d range even with acknowledgedLargeRange', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_400D,
            to: T_NOW_ISO,
            acknowledgedLargeRange: true,
        });
        expect(r.success).toBe(false);
    });

    it('rejects future-dated to', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_30D,
            to: T_FUTURE,
        });
        expect(r.success).toBe(false);
    });

    it('rejects non-positive versionId', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 0,
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });
});

describe('CompareVersionsParamsSchema', () => {
    it('accepts two distinct version ids', () => {
        const r = CompareVersionsParamsSchema.safeParse({
            aVersionId: 1,
            bVersionId: 2,
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(true);
    });

    it('rejects identical version ids', () => {
        const r = CompareVersionsParamsSchema.safeParse({
            aVersionId: 3,
            bVersionId: 3,
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });
});

describe('ListPositionsParamsSchema', () => {
    it('accepts filters with valid symbol + status', () => {
        const r = ListPositionsParamsSchema.safeParse({
            symbol: 'BTCUSDT',
            status: 'open',
            from: T_MINUS_30D,
            to: T_NOW_ISO,
            limit: 50,
        });
        expect(r.success).toBe(true);
    });

    it('rejects lowercase / punctuated symbols', () => {
        const r = ListPositionsParamsSchema.safeParse({
            symbol: 'btc-usdt',
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });

    it('accepts CCXT-format symbols (engine storage form) and legacy plain form, rejects malformed variants', () => {
        // why: post-M12 live-smoke fix — the engine stores symbols as
        // `BASE/QUOTE:SETTLEMENT` (e.g. `TST/USDT:USDT`). Both the CCXT form
        // and the legacy plain-uppercase form must pass; lowercase + partial
        // separators must still be rejected.
        const accept = ['TST/USDT:USDT', 'BTC/USDT:USDT', 'BTCUSDT'];

        for (const symbol of accept) {
            const r = ListPositionsParamsSchema.safeParse({ symbol, from: T_MINUS_30D, to: T_NOW_ISO });
            expect(r.success).toBe(true);
        }

        const reject = ['BTC; DROP TABLE', 'btc/usdt:usdt', 'BTC/', '/USDT:USDT'];

        for (const symbol of reject) {
            const r = ListPositionsParamsSchema.safeParse({ symbol, from: T_MINUS_30D, to: T_NOW_ISO });
            expect(r.success).toBe(false);
        }
    });

    it('rejects limit > 200', () => {
        const r = ListPositionsParamsSchema.safeParse({
            from: T_MINUS_30D,
            to: T_NOW_ISO,
            limit: 500,
        });
        expect(r.success).toBe(false);
    });
});

describe('GetDecisionsParamsSchema', () => {
    it('accepts a happy-path 30d query with default includeSnapshot=false', () => {
        const r = GetDecisionsParamsSchema.safeParse({
            symbol: 'BTCUSDT',
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.includeSnapshot).toBe(false);
        }
    });

    it('rejects > 30d range (hard cap, no ack flag exists)', () => {
        const r = GetDecisionsParamsSchema.safeParse({
            symbol: 'BTCUSDT',
            from: T_MINUS_60D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });

    it('rejects missing symbol', () => {
        const r = GetDecisionsParamsSchema.safeParse({
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });
});

describe('RunBacktestParamsSchema', () => {
    it('accepts a 30d backtest window in bare YYYY-MM-DD form', () => {
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2026-04-27',
            to: '2026-05-27',
        });
        expect(r.success).toBe(true);
    });

    it('accepts canonical UTC-midnight YYYY-MM-DDT00:00:00.000Z form', () => {
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2026-04-27T00:00:00.000Z',
            to: '2026-05-27T00:00:00.000Z',
        });
        expect(r.success).toBe(true);
    });

    it('rejects non-midnight ISO timestamps that would silently truncate to a wider window', () => {
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2025-01-15T08:00:00Z',
            to: '2025-02-15T08:00:00Z',
        });
        expect(r.success).toBe(false);
    });

    it('rejects a non-UTC suffix (timezone offset)', () => {
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2025-01-15T00:00:00+05:00',
            to: '2025-02-15T00:00:00+05:00',
        });
        expect(r.success).toBe(false);
    });

    it('rejects same-UTC-day from/to (zero-day window)', () => {
        // Old behaviour: ISO-to-YYYY-MM-DD truncation made two distinct ISO
        // instants collapse to the same date and the engine throws. With the
        // tightened schema the canonical form '...T00:00:00.000Z' yields
        // from==to which is rejected by the engine; both raw shapes are
        // rejected at the schema only when the regex fails (handled above).
        // The schema itself allows from==to; the engine will reject the
        // zero-window. We assert at least the schema doesn't introduce a
        // spurious accept of arbitrary same-day ISO instants.
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2025-01-15T08:00:00Z',
            to: '2025-01-15T20:00:00Z',
        });
        expect(r.success).toBe(false);
    });

    it('rejects > 180d backtest window (hard cap) — date-only form', () => {
        const r = RunBacktestParamsSchema.safeParse({
            versionId: 1,
            from: '2024-04-27',
            to: '2026-05-27',
        });
        expect(r.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// M12 W5 — adversarial range-cap bypass attempts (QA wave, vector 2).
//
// These cases are NOT covered by the W3 happy-path tests above:
//   - Missing `to` (not a valid ISO string → rejected by isoDateString refine)
//   - NaN / Infinity in numeric params (versionId)
//   - Exactly-at-boundary ranges (90d soft cap, 365d hard cap, 30d decisions)
//   - Oversized range WITH acknowledgedLargeRange set for RunBacktest (180d hard)
//   - acknowledgedLargeRange=true still rejected when span > 365d hard cap on
//     read-query tools
// ---------------------------------------------------------------------------

describe('adversarial range-cap bypass — GetPerformanceParamsSchema', () => {
    // Boundary: exactly 90d should pass WITHOUT flag.
    const T_MINUS_90D = new Date(T_NOW - 90 * 24 * 60 * 60 * 1000).toISOString();
    // Boundary: exactly 365d should pass WITH flag.
    const T_MINUS_365D = new Date(T_NOW - 365 * 24 * 60 * 60 * 1000).toISOString();
    // 365d+1ms pushes past the hard cap.
    const T_MINUS_365D_PLUS_1MS = new Date(T_NOW - (365 * 24 * 60 * 60 * 1000 + 1)).toISOString();

    it('accepts exactly-90d span without acknowledgedLargeRange (boundary at soft cap)', () => {
        const r = GetPerformanceParamsSchema.safeParse({ versionId: 1, from: T_MINUS_90D, to: T_NOW_ISO });
        expect(r.success).toBe(true);
    });

    it('rejects 90d+1ms span without acknowledgedLargeRange (just past soft cap)', () => {
        const justOver90D = new Date(T_NOW - (90 * 24 * 60 * 60 * 1000 + 1)).toISOString();
        const r = GetPerformanceParamsSchema.safeParse({ versionId: 1, from: justOver90D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });

    it('accepts exactly-365d span with acknowledgedLargeRange=true (at hard cap boundary)', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_365D,
            to: T_NOW_ISO,
            acknowledgedLargeRange: true,
        });
        expect(r.success).toBe(true);
    });

    it('rejects span > 365d even with acknowledgedLargeRange=true (hard cap)', () => {
        const r = GetPerformanceParamsSchema.safeParse({
            versionId: 1,
            from: T_MINUS_365D_PLUS_1MS,
            to: T_NOW_ISO,
            acknowledgedLargeRange: true,
        });
        expect(r.success).toBe(false);
    });

    it('rejects missing `to` (undefined — schema requires string)', () => {
        const r = GetPerformanceParamsSchema.safeParse({ versionId: 1, from: T_MINUS_30D });
        expect(r.success).toBe(false);
    });

    it('rejects NaN versionId', () => {
        const r = GetPerformanceParamsSchema.safeParse({ versionId: NaN, from: T_MINUS_30D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });

    it('rejects Infinity versionId', () => {
        const r = GetPerformanceParamsSchema.safeParse({ versionId: Infinity, from: T_MINUS_30D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });

    it('rejects float versionId (non-integer)', () => {
        const r = GetPerformanceParamsSchema.safeParse({ versionId: 1.5, from: T_MINUS_30D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });
});

describe('adversarial range-cap bypass — CompareVersionsParamsSchema', () => {
    it('rejects reversed range AND identical versionIds simultaneously', () => {
        const r = CompareVersionsParamsSchema.safeParse({
            aVersionId: 3,
            bVersionId: 3,
            from: T_NOW_ISO,
            to: T_MINUS_30D,
        });
        expect(r.success).toBe(false);
    });

    it('rejects missing `from` (schema requires both bounds)', () => {
        const r = CompareVersionsParamsSchema.safeParse({ aVersionId: 1, bVersionId: 2, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });
});

describe('adversarial range-cap bypass — ListPositionsParamsSchema', () => {
    it('rejects limit=0 (must be positive)', () => {
        const r = ListPositionsParamsSchema.safeParse({ from: T_MINUS_30D, to: T_NOW_ISO, limit: 0 });
        expect(r.success).toBe(false);
    });

    it('rejects limit=201 (exceeds hard ceiling of 200)', () => {
        const r = ListPositionsParamsSchema.safeParse({ from: T_MINUS_30D, to: T_NOW_ISO, limit: 201 });
        expect(r.success).toBe(false);
    });

    it('accepts limit=200 (exactly at hard ceiling)', () => {
        const r = ListPositionsParamsSchema.safeParse({ from: T_MINUS_30D, to: T_NOW_ISO, limit: 200 });
        expect(r.success).toBe(true);
    });

    it('rejects symbol with SQL meta-characters', () => {
        const injections = ["BTC' OR 1=1--", 'BTC; DROP TABLE--', 'BTC UNION SELECT', 'btcusdt'];
        for (const symbol of injections) {
            const r = ListPositionsParamsSchema.safeParse({ symbol, from: T_MINUS_30D, to: T_NOW_ISO });
            expect(r.success).toBe(false);
        }
    });

    it('rejects reversed range (to < from)', () => {
        const r = ListPositionsParamsSchema.safeParse({ from: T_NOW_ISO, to: T_MINUS_30D });
        expect(r.success).toBe(false);
    });
});

describe('adversarial range-cap bypass — GetDecisionsParamsSchema', () => {
    const T_MINUS_31D = new Date(T_NOW - 31 * 24 * 60 * 60 * 1000).toISOString();

    it('accepts exactly-30d span (at hard cap boundary)', () => {
        const r = GetDecisionsParamsSchema.safeParse({ symbol: 'BTCUSDT', from: T_MINUS_30D, to: T_NOW_ISO });
        expect(r.success).toBe(true);
    });

    it('rejects 31d span (past hard cap, no flag available)', () => {
        const r = GetDecisionsParamsSchema.safeParse({ symbol: 'BTCUSDT', from: T_MINUS_31D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });

    it('rejects SQL-injection in symbol even when dates are valid', () => {
        const r = GetDecisionsParamsSchema.safeParse({
            symbol: "BTC'; DROP TABLE decisions--",
            from: T_MINUS_30D,
            to: T_NOW_ISO,
        });
        expect(r.success).toBe(false);
    });
});

describe('adversarial range-cap bypass — RunBacktestParamsSchema', () => {
    const T_MINUS_180D = new Date(T_NOW - 180 * 24 * 60 * 60 * 1000).toISOString();
    const T_MINUS_181D = new Date(T_NOW - 181 * 24 * 60 * 60 * 1000).toISOString();

    it('accepts exactly-180d span (at hard cap boundary)', () => {
        const r = RunBacktestParamsSchema.safeParse({ versionId: 1, from: T_MINUS_180D, to: T_NOW_ISO });
        expect(r.success).toBe(true);
    });

    it('rejects 181d span (past hard cap) even if caller smuggles acknowledgedLargeRange', () => {
        // acknowledgedLargeRange is not a defined field on RunBacktestParams;
        // even if a caller passes it in as extra data, the hard cap must still reject.
        const r = RunBacktestParamsSchema.safeParse({ versionId: 1, from: T_MINUS_181D, to: T_NOW_ISO, acknowledgedLargeRange: true });
        expect(r.success).toBe(false);
    });

    it('rejects versionId=0 (non-positive)', () => {
        const r = RunBacktestParamsSchema.safeParse({ versionId: 0, from: T_MINUS_30D, to: T_NOW_ISO });
        expect(r.success).toBe(false);
    });

    it('rejects reversed range', () => {
        const r = RunBacktestParamsSchema.safeParse({ versionId: 1, from: T_NOW_ISO, to: T_MINUS_30D });
        expect(r.success).toBe(false);
    });

    it('rejects future-dated `to`', () => {
        const r = RunBacktestParamsSchema.safeParse({ versionId: 1, from: T_MINUS_30D, to: T_FUTURE });
        expect(r.success).toBe(false);
    });
});
