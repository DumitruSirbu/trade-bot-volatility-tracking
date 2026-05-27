// M12 W1 — compareVersions unit tests.
//
// Stub DataSource returns the per-version aggregate row for `getPerformance`'s
// two parallel queries plus the paired-diff row. We assert: (a) both versions
// run, (b) paired-diff totals propagate, (c) validation rejects equal-version
// and bad ranges.

import { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN } from '@bot/shared';

import { AnalysisValidationError, compareVersions } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function makeStubDataSource(performanceRow: Record<string, unknown>, pairedRow: Record<string, unknown>) {
    const calls: { sql: string; bindings: readonly unknown[] }[] = [];

    const handler: QueryHandler = async (sql, bindings) => {
        calls.push({ sql, bindings });

        if (sql.includes('paired_with_pnl')) {
            return [pairedRow];
        }

        return [performanceRow];
    };

    return { ds: { query: handler }, calls };
}

describe('compareVersions', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    it('returns per-version metrics + paired-diff summary on the happy path (n above sample floor)', async () => {
        const { ds, calls } = makeStubDataSource(
            { trade_count: '50', win_count: '30', net_pnl_usd: '100', label: 'v', status: 'shadow' },
            {
                paired_event_count: '120',
                paired_traded_event_count: '64',
                // 45.5 / 64 = 0.7109375 → exact via decimalMath (vs PG AVG heuristic scale)
                net_pnl_delta_usd: '45.5',
            },
        );

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.aPerformance.tradeCount).toBe(50);
        expect(result.bPerformance.tradeCount).toBe(50);
        expect(result.pairedDiff.pairedEventCount).toBe(120);
        expect(result.pairedDiff.pairedTradedEventCount).toBe(64);
        expect(result.pairedDiff.netPnlDeltaUsd).toBe('45.5');
        expect(result.pairedDiff.meanPnlDeltaUsd).toBe('0.7109375');
        expect(result.pairedDiff.belowSampleFloor).toBe(false);

        // Three queries: getPerformance(a), getPerformance(b), paired-diff.
        expect(calls).toHaveLength(3);
        const pairedCall = calls.find((c) => c.sql.includes('paired_with_pnl'));

        expect(pairedCall).toBeDefined();
        expect(pairedCall!.bindings).toEqual([1, 2, from.toISOString(), to.toISOString()]);
    });

    it('reports meanPnlDeltaUsd=null + belowSampleFloor=true when no paired-traded events exist (n=0)', async () => {
        const { ds } = makeStubDataSource(
            { trade_count: '0', win_count: '0', net_pnl_usd: '0', label: null, status: null },
            {
                paired_event_count: '5',
                paired_traded_event_count: '0',
                net_pnl_delta_usd: '0',
            },
        );

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.pairedTradedEventCount).toBe(0);
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
        expect(result.pairedDiff.belowSampleFloor).toBe(true);
    });

    it('suppresses meanPnlDeltaUsd when paired-traded count is 1 below the sample floor (n=29)', async () => {
        const { ds } = makeStubDataSource(
            { trade_count: '40', win_count: '20', net_pnl_usd: '0', label: 'v', status: 'shadow' },
            {
                paired_event_count: '40',
                paired_traded_event_count: String(MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN - 1),
                net_pnl_delta_usd: '10',
            },
        );

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.pairedTradedEventCount).toBe(MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN - 1);
        // Sum is still surfaced — totals are not misleading the way a small-n mean is.
        expect(result.pairedDiff.netPnlDeltaUsd).toBe('10');
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
        expect(result.pairedDiff.belowSampleFloor).toBe(true);
    });

    it('exposes meanPnlDeltaUsd at exactly the sample floor (n=30)', async () => {
        const { ds } = makeStubDataSource(
            { trade_count: '60', win_count: '30', net_pnl_usd: '5', label: 'v', status: 'shadow' },
            {
                paired_event_count: '60',
                paired_traded_event_count: String(MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN),
                // 30 / 30 = 1 exactly via decimalMath.
                net_pnl_delta_usd: '30',
            },
        );

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.pairedTradedEventCount).toBe(MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN);
        expect(result.pairedDiff.meanPnlDeltaUsd).toBe('1');
        expect(result.pairedDiff.belowSampleFloor).toBe(false);
    });

    it('exposes meanPnlDeltaUsd at large n=100', async () => {
        const { ds } = makeStubDataSource(
            { trade_count: '200', win_count: '110', net_pnl_usd: '50', label: 'v', status: 'shadow' },
            {
                paired_event_count: '200',
                paired_traded_event_count: '100',
                net_pnl_delta_usd: '125',
            },
        );

        const result = await compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(result.pairedDiff.pairedTradedEventCount).toBe(100);
        // 125 / 100 = 1.25 exactly via decimalMath.
        expect(result.pairedDiff.meanPnlDeltaUsd).toBe('1.25');
        expect(result.pairedDiff.belowSampleFloor).toBe(false);
    });

    it('computes the paired mean via shared decimalMath (no AVG in SQL) with deterministic sub-cent precision', async () => {
        // why: previously the SQL did `AVG(NUMERIC)` whose scale is PG-version-
        // dependent. We now return SUM + COUNT only and divide in JS via
        // shared decimalMath so the surface is stable across PG versions.
        let capturedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (sql.includes('paired_with_pnl')) {
                capturedSql = sql;
                return [
                    {
                        paired_event_count: '100',
                        paired_traded_event_count: '100',
                        net_pnl_delta_usd: '1', // 1 / 100 = 0.01 — a sub-cent value PG AVG would round inconsistently.
                    },
                ];
            }
            return [{ trade_count: '100', win_count: '50', net_pnl_usd: '0', label: 'v', status: 'shadow' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(capturedSql).not.toMatch(/\bAVG\(/u);
        expect(result.pairedDiff.meanPnlDeltaUsd).toBe('0.01');
    });

    it('paired-diff SQL anchors on OPEN decisions (action=open AND position_id IS NOT NULL), not earliest-by-ts', async () => {
        // why: the previous CTE was `ORDER BY ts ASC` with no action filter, so a
        // SKIP at t=1 (position_id=NULL) for event_id=E preceding an OPEN at
        // t=2 (position_id=42) would pick the SKIP row — silently dropping the
        // paired anchor. The fix filters `action='open' AND position_id IS NOT
        // NULL` so DISTINCT ON resolves to the OPEN that actually anchored the
        // position. This is a SQL-text contract assertion: we cannot exercise
        // the predicate against real rows without an integration database, so
        // we verify the CTE contains both filter clauses for both versions.
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (sql.includes('paired_with_pnl')) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '1',
                        paired_traded_event_count: '1',
                        net_pnl_delta_usd: '5',
                    },
                ];
            }
            return [{ trade_count: '1', win_count: '1', net_pnl_usd: '5', label: 'v', status: 'shadow' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        const actionFilters = (capturedPairedSql.match(/d\.action\s*=\s*'open'/gu) ?? []).length;
        const positionIdFilters = (capturedPairedSql.match(/d\.position_id\s+IS\s+NOT\s+NULL/gu) ?? []).length;
        expect(actionFilters).toBe(2);
        expect(positionIdFilters).toBe(2);
        expect(result.pairedDiff.pairedEventCount).toBe(1);
    });

    it('paired-diff SQL collapses duplicate event_id rows per version via DISTINCT ON', async () => {
        // why: if the SQL did not de-dup, two A-decisions sharing an event_id
        // would cross-join with one B-decision to produce 2 paired rows instead
        // of 1. We verify the SQL contains the DISTINCT ON guard; the
        // pairedEventCount and netPnlDeltaUsd are propagated from the engine's
        // already-collapsed result row (the integration spec asserts the live
        // semantics; this unit asserts the contract surface).
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (sql.includes('paired_with_pnl')) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '1',
                        paired_traded_event_count: '1',
                        net_pnl_delta_usd: '5',
                    },
                ];
            }
            return [{ trade_count: '1', win_count: '1', net_pnl_usd: '5', label: 'v', status: 'shadow' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(capturedPairedSql).toContain('DISTINCT ON (d.event_id)');
        // Two CTEs, both de-duped.
        const occurrences = (capturedPairedSql.match(/DISTINCT ON \(d\.event_id\)/gu) ?? []).length;
        expect(occurrences).toBe(2);
        expect(result.pairedDiff.pairedEventCount).toBe(1);
    });

    it('paired LEFT JOIN bounds closed_at by the window upper bound for both versions', async () => {
        // why: paired-diff semantics require BOTH versions' positions to have
        // closed inside [from, to). Without the closed_at < $4 clause, a
        // still-open trade or one closing after the window would contribute
        // NULL realized_pnl on one side and skew the sum. We assert the SQL
        // contains the clause on both LEFT JOINs.
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (sql.includes('paired_with_pnl')) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '0',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'v', status: 'shadow' }];
        };

        await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        const aClause = (capturedPairedSql.match(/pa\.closed_at\s*<\s*\$4/gu) ?? []).length;
        const bClause = (capturedPairedSql.match(/pb\.closed_at\s*<\s*\$4/gu) ?? []).length;
        expect(aClause).toBe(1);
        expect(bClause).toBe(1);
    });

    it('rejects equal versionIds', async () => {
        const { ds } = makeStubDataSource({}, {});

        await expect(compareVersions(ds as never, { aVersionId: 4, bVersionId: 4, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects reversed range', async () => {
        const { ds } = makeStubDataSource({}, {});

        await expect(compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from: to, to: from })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
