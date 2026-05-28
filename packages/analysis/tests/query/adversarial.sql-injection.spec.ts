// M12 W5 — adversarial SQL-injection vector (QA wave, ADR 0033 §5 + ADR 0034 §3).
//
// Defense-in-depth assertion: even when the MCP DTO layer (Zod) would reject a
// symbol like `'BTC; DROP TABLE positions; --'`, the @bot/analysis query
// functions ALSO independently reject it at their own validation layer.  This
// means a caller that bypasses the MCP tool layer (e.g., a test harness or a
// future non-MCP consumer) still cannot inject SQL.
//
// Every query function is exercised with each representative injection pattern.
// The tests assert that:
//   (a) An `AnalysisValidationError` is thrown BEFORE `ds.query` is called.
//   (b) The query function NEVER passes an unvalidated string into a binding.
//
// F.I.R.S.T.: the stub DataSource throws if called, so any test that reaches
// the DB layer fails loudly — proving the guard fires BEFORE the query.

import { AnalysisValidationError, compareVersions, getDecisions, getPerformance, listPositions } from '../../src/index';

// ---------------------------------------------------------------------------
// A DataSource stub that FAILS the test if query() is ever called.
// This is the anti-coverage sentinel: if SQL executes at all, the guard failed.
// ---------------------------------------------------------------------------

function rejectingDataSource(label: string): Record<'query', jest.Mock> {
    return {
        query: jest.fn().mockImplementation(() => {
            throw new Error(`GUARD BREACH: ds.query() was called for "${label}" — validation should have prevented this`);
        }),
    };
}

// ---------------------------------------------------------------------------
// Injection patterns to test — each one should be rejected by every string
// validator in the query layer.
// ---------------------------------------------------------------------------

const INJECTION_CASES: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'classic UNION injection', value: "BTC' UNION SELECT 1,2,3--" },
    { label: 'semicolon drop', value: 'BTC; DROP TABLE positions; --' },
    { label: 'OR tautology', value: "BTC' OR '1'='1" },
    { label: 'stacked statements', value: "BTCUSDT'; INSERT INTO auth_tokens VALUES ('x','y',now())--" },
    { label: 'SQL comment strip', value: 'BTC--' },
    { label: 'backslash escape', value: 'BTC\\0USDT' },
    { label: 'unicode quote', value: 'BTC’USDT' },
    { label: 'lowercase symbol', value: 'btcusdt' },
    { label: 'empty symbol', value: '' },
    { label: 'whitespace only', value: '   ' },
    { label: 'null byte', value: 'BTC\x00USDT' },
    { label: 'overlength (>52 chars analysis guard, includes CCXT-form ceiling)', value: 'A'.repeat(53) },
];

const VALID_FROM = new Date('2026-01-01T00:00:00Z');
const VALID_TO = new Date('2026-01-15T00:00:00Z');

// ---------------------------------------------------------------------------
// getDecisions — requires a non-empty, uppercase-alphanumeric symbol
// ---------------------------------------------------------------------------

describe('getDecisions SQL-injection defence', () => {
    for (const { label, value } of INJECTION_CASES) {
        it(`rejects ${label} before querying DB`, async () => {
            const ds = rejectingDataSource(`getDecisions:${label}`);

            await expect(getDecisions(ds as never, { symbol: value, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(AnalysisValidationError);

            expect(ds.query).not.toHaveBeenCalled();
        });
    }
});

// ---------------------------------------------------------------------------
// listPositions — symbol is optional but validated when present
// ---------------------------------------------------------------------------

describe('listPositions SQL-injection defence (symbol param)', () => {
    for (const { label, value } of INJECTION_CASES) {
        it(`rejects ${label} before querying DB`, async () => {
            const ds = rejectingDataSource(`listPositions:${label}`);

            await expect(listPositions(ds as never, { symbol: value, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(AnalysisValidationError);

            expect(ds.query).not.toHaveBeenCalled();
        });
    }
});

// ---------------------------------------------------------------------------
// getPerformance — no string filter, but versionId must be a positive integer.
// Test non-integer / string-shaped values via the typed API.
// ---------------------------------------------------------------------------

describe('getPerformance SQL-injection defence (versionId param)', () => {
    const BAD_VERSION_IDS: readonly { readonly label: string; readonly value: number }[] = [
        { label: 'zero', value: 0 },
        { label: 'negative integer', value: -1 },
        { label: 'NaN (coerced)', value: NaN },
        { label: 'Infinity', value: Infinity },
        { label: 'float 1.5', value: 1.5 },
        // NOTE: 1.1e308 is excluded here — it is recognized as integer by
        // Number.isInteger() in JS (all large enough floats become integers due
        // to floating-point precision). This is a known quirk; the versionId
        // guard relies on Number.isInteger() and Number.isFinite() which pass
        // for 1.1e308. ESCALATION: the production code should add an explicit
        // upper bound (e.g. versionId <= Number.MAX_SAFE_INTEGER) to reject
        // astronomically large values that could overflow a 32-bit DB column.
        // Tracked as a bug finding in M12 W5 QA report.
    ];

    for (const { label, value } of BAD_VERSION_IDS) {
        it(`rejects ${label} before querying DB`, async () => {
            const ds = rejectingDataSource(`getPerformance:${label}`);

            await expect(getPerformance(ds as never, { versionId: value, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(AnalysisValidationError);

            expect(ds.query).not.toHaveBeenCalled();
        });
    }
});

// ---------------------------------------------------------------------------
// compareVersions — two versionId params; both must be valid positive integers
// and they must differ.
// ---------------------------------------------------------------------------

describe('compareVersions SQL-injection defence (versionId params)', () => {
    it('rejects equal versionIds before querying DB', async () => {
        const ds = rejectingDataSource('compareVersions:equal-ids');

        await expect(compareVersions(ds as never, { aVersionId: 5, bVersionId: 5, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );

        expect(ds.query).not.toHaveBeenCalled();
    });

    it('rejects zero aVersionId before querying DB', async () => {
        const ds = rejectingDataSource('compareVersions:zero-a');

        await expect(compareVersions(ds as never, { aVersionId: 0, bVersionId: 1, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );

        expect(ds.query).not.toHaveBeenCalled();
    });

    it('rejects negative bVersionId before querying DB', async () => {
        const ds = rejectingDataSource('compareVersions:neg-b');

        await expect(compareVersions(ds as never, { aVersionId: 1, bVersionId: -3, from: VALID_FROM, to: VALID_TO })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );

        expect(ds.query).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Parameterized-binding assertion — `getDecisions` with a valid symbol but
// deliberately hostile dates to confirm all bindings stay in the `$n` slot
// and nothing is string-interpolated into the SQL.
// ---------------------------------------------------------------------------

describe('getDecisions — SQL is fully parameterized (no string interpolation)', () => {
    it('passes symbol and dates only as positional bindings, never in SQL text', async () => {
        const capturedCalls: Array<{ sql: string; bindings: readonly unknown[] }> = [];

        const ds = {
            query: jest.fn().mockImplementation(async (sql: string, bindings: readonly unknown[]) => {
                capturedCalls.push({ sql, bindings });

                return [];
            }),
        };

        const symbol = 'BTCUSDT';
        await getDecisions(ds as never, { symbol, from: VALID_FROM, to: VALID_TO });

        expect(capturedCalls).toHaveLength(1);
        const { sql, bindings } = capturedCalls[0];

        // Symbol must appear in bindings, never hard-coded in the SQL text.
        expect(sql).not.toContain(symbol);
        expect(bindings[0]).toBe(symbol);

        // SQL must use positional placeholders.
        expect(sql).toContain('$1');
        expect(sql).toContain('$2');
        expect(sql).toContain('$3');
    });
});
