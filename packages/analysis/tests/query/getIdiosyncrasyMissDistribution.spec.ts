// M30 D3 — getIdiosyncrasyMissDistribution unit tests.
//
// Stub DataSource.query with fixture IRejectRow arrays to cover bucket
// assignment, boundary handling, per-UTC-day grouping, unknown-score counting,
// activeMinScore parameter correctness, and input validation.
// No real DB — the SQL is exercised only by integration tests against the
// port-6900 test container.

import { AnalysisValidationError } from '../../src/index';
import { getIdiosyncrasyMissDistribution } from '../../src/query/getIdiosyncrasyMissDistribution';

// ─── Fixture factory ──────────────────────────────────────────────────────────

interface IRejectRowOverrides {
    utc_date?: string;
    idiosyncrasy_score?: string | null;
}

function buildRejectRow(overrides: IRejectRowOverrides = {}): Record<string, unknown> {
    return {
        utc_date: '2026-06-01',
        idiosyncrasy_score: '0.3',
        ...overrides,
    };
}

function stubDs(rows: Record<string, unknown>[]): { query: () => Promise<unknown[]> } {
    return {
        query: async () => rows,
    };
}

const DEFAULT_PARAMS = {
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    activeMinScore: '0.5',
};

// Helper to find a bucket by label
function findBucket(row: { buckets: Array<{ label: string; count: number }> }, label: string): number {
    return row.buckets.find((b) => b.label === label)?.count ?? 0;
}

// ─── Bucket assignment ────────────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — bucket assignment', () => {
    it('score=0.295 with activeMinScore=0.5 → missDistance=0.205 → bucket [0.2,0.3)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.295' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.2,0.3)')).toBe(1);
    });

    it('score=0.05 → missDistance=0.45 → bucket [0.4,0.5] (deep BTC-beta, top band)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.05' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.4,0.5]')).toBe(1);
    });

    it('score=0.49 → missDistance=0.01 → bucket [0,0.1)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.49' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0,0.1)')).toBe(1);
    });

    it('score=0.4 → missDistance=0.1 → bucket [0.1,0.2) (lower edge of second band)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.4' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.1,0.2)')).toBe(1);
    });

    it('score=0.3 → missDistance=0.2 → bucket [0.2,0.3)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.3' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.2,0.3)')).toBe(1);
    });

    it('score=0.2 → missDistance=0.3 → bucket [0.3,0.4)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.2' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.3,0.4)')).toBe(1);
    });

    it('score=0.0 → missDistance=0.5 → top closed band [0.4,0.5] (exactly at upper edge)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.0' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(findBucket(rows[0], '[0.4,0.5]')).toBe(1);
    });
});

// ─── Boundary at score=0.5 (gate-passer exclusion) ───────────────────────────

describe('getIdiosyncrasyMissDistribution — gate-passer boundary exclusion', () => {
    it('score=0.5 → missDistance=0 → excluded from all buckets; totalRejections increments', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.5' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(rows[0].totalRejections).toBe(1);
        // All bucket counts must be zero
        for (const bucket of rows[0].buckets) {
            expect(bucket.count).toBe(0);
        }
    });

    it('score above threshold (0.6) → missDistance negative → excluded from all buckets', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.6' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        // Not counted in any bucket
        for (const bucket of rows[0].buckets) {
            expect(bucket.count).toBe(0);
        }
    });
});

// ─── Unknown score handling ───────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — unknown score handling', () => {
    it('null score → counted in unknownScoreCount, not in any bucket, not as 0-score artifact', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: null })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(rows[0].unknownScoreCount).toBe(1);
        expect(rows[0].totalRejections).toBe(1);
        for (const bucket of rows[0].buckets) {
            expect(bucket.count).toBe(0);
        }
    });

    it('mix of known and null scores: unknownScoreCount counts only nulls', async () => {
        const ds = stubDs([
            buildRejectRow({ idiosyncrasy_score: '0.3' }),
            buildRejectRow({ idiosyncrasy_score: null }),
            buildRejectRow({ idiosyncrasy_score: null }),
        ]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows[0].totalRejections).toBe(3);
        expect(rows[0].unknownScoreCount).toBe(2);
        expect(findBucket(rows[0], '[0.2,0.3)')).toBe(1);
    });
});

// ─── activeMinScore parameter correctness ────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — activeMinScore version sensitivity', () => {
    it('score=0.295 with activeMinScore=0.5 → missDistance=0.205 → bucket [0.2,0.3)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.295' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: '0.5' });

        expect(findBucket(rows[0], '[0.2,0.3)')).toBe(1);
    });

    it('score=0.295 with activeMinScore=0.3 → missDistance=0.005 → bucket [0,0.1) (different version)', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.295' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: '0.3' });

        expect(findBucket(rows[0], '[0,0.1)')).toBe(1);
    });

    it('using wrong activeMinScore misclassifies the bucket (proves caller must pass correct version param)', async () => {
        const ds1 = stubDs([buildRejectRow({ idiosyncrasy_score: '0.295' })]);
        const ds2 = stubDs([buildRejectRow({ idiosyncrasy_score: '0.295' })]);

        const rowsV2 = await getIdiosyncrasyMissDistribution(ds1 as never, { ...DEFAULT_PARAMS, activeMinScore: '0.5' });
        const rowsV0 = await getIdiosyncrasyMissDistribution(ds2 as never, { ...DEFAULT_PARAMS, activeMinScore: '0.3' });

        // v2 score=0.5 → score is in [0.2,0.3) bucket (miss of 0.205)
        // v0 score=0.3 → score is in [0,0.1) bucket (miss of 0.005)
        expect(findBucket(rowsV2[0], '[0.2,0.3)')).toBe(1);
        expect(findBucket(rowsV0[0], '[0,0.1)')).toBe(1);
        // The two classifications are different — wrong version gives wrong bucket
        expect(findBucket(rowsV2[0], '[0,0.1)')).toBe(0);
        expect(findBucket(rowsV0[0], '[0.2,0.3)')).toBe(0);
    });
});

// ─── SQL filter verification ──────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — SQL filter for reason=no_eligible_slot', () => {
    it('the SQL contains reason = no_eligible_slot filter', async () => {
        let capturedSql = '';
        const mockDs = {
            query: async (sql: string) => {
                capturedSql = sql;
                return [];
            },
        };

        await getIdiosyncrasyMissDistribution(mockDs as never, DEFAULT_PARAMS);

        expect(capturedSql).toContain("'no_eligible_slot'");
    });
});

// ─── Per-UTC-day grouping ─────────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — per-UTC-day grouping', () => {
    it('rows on different days produce separate IIdiosyncrasyMissDistributionRow entries', async () => {
        const ds = stubDs([
            buildRejectRow({ utc_date: '2026-06-01', idiosyncrasy_score: '0.3' }),
            buildRejectRow({ utc_date: '2026-06-02', idiosyncrasy_score: '0.4' }),
        ]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(2);
        expect(rows[0].utcDate).toBe('2026-06-01');
        expect(rows[1].utcDate).toBe('2026-06-02');
    });

    it('two rows on the same day produce one entry with summed bucket counts', async () => {
        const ds = stubDs([
            buildRejectRow({ utc_date: '2026-06-01', idiosyncrasy_score: '0.3' }),
            buildRejectRow({ utc_date: '2026-06-01', idiosyncrasy_score: '0.35' }),
        ]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toHaveLength(1);
        expect(rows[0].totalRejections).toBe(2);
        // Both have missDistance in [0.1,0.2) range (0.5-0.3=0.2 is [0.2,0.3), 0.5-0.35=0.15 is [0.1,0.2))
        expect(findBucket(rows[0], '[0.1,0.2)')).toBe(1); // score=0.35 → miss=0.15
        expect(findBucket(rows[0], '[0.2,0.3)')).toBe(1); // score=0.3 → miss=0.2
    });

    it('rows are returned sorted by utcDate ascending', async () => {
        const ds = stubDs([
            buildRejectRow({ utc_date: '2026-06-03', idiosyncrasy_score: '0.3' }),
            buildRejectRow({ utc_date: '2026-06-01', idiosyncrasy_score: '0.3' }),
            buildRejectRow({ utc_date: '2026-06-02', idiosyncrasy_score: '0.3' }),
        ]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows.map((r) => r.utcDate)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    });

    it('each day entry has the complete set of five bucket labels', async () => {
        const ds = stubDs([buildRejectRow({ idiosyncrasy_score: '0.3' })]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        const labels = rows[0].buckets.map((b) => b.label);
        expect(labels).toEqual(['[0,0.1)', '[0.1,0.2)', '[0.2,0.3)', '[0.3,0.4)', '[0.4,0.5]']);
    });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — input validation', () => {
    it('invalid fromDate format throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, fromDate: '01/06/2026' })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );
    });

    it('invalid toDate format throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, toDate: 'June-30-2026' })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );
    });

    it('fromDate > toDate throws AnalysisValidationError on field "range"', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, fromDate: '2026-06-30', toDate: '2026-06-01' })).rejects.toMatchObject({
            field: 'range',
        });
    });

    it('activeMinScore=NaN throws AnalysisValidationError on field "activeMinScore"', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: 'NaN' })).rejects.toMatchObject({
            field: 'activeMinScore',
        });
    });

    it('activeMinScore=0 throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: '0' })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('activeMinScore negative throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: '-0.5' })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );
    });

    it('non-numeric activeMinScore throws AnalysisValidationError', async () => {
        const ds = stubDs([]);

        await expect(getIdiosyncrasyMissDistribution(ds as never, { ...DEFAULT_PARAMS, activeMinScore: 'abc' })).rejects.toBeInstanceOf(
            AnalysisValidationError,
        );
    });
});

// ─── Empty result ─────────────────────────────────────────────────────────────

describe('getIdiosyncrasyMissDistribution — empty result', () => {
    it('no matching rows returns empty array without error', async () => {
        const ds = stubDs([]);

        const rows = await getIdiosyncrasyMissDistribution(ds as never, DEFAULT_PARAMS);

        expect(rows).toEqual([]);
    });
});
