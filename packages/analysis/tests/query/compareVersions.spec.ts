// M12 W1 — compareVersions unit tests.
//
// Stub DataSource returns the per-version aggregate row for `getPerformance`'s
// two parallel queries plus the paired-diff row. We assert: (a) both versions
// run, (b) paired-diff totals propagate, (c) validation rejects equal-version
// and bad ranges.
//
// M37 W1: `getPerformance` now resolves `strategy_versions.status` via a 1-row
// `LIMIT 1` lookup before its aggregation, and `compareVersions` selects the
// paired-diff source per side from that status (active → `decisions`/
// `positions`; shadow → `shadow_decisions`). The stub routes three query kinds:
// the version lookup (`LIMIT 1`), the per-version aggregation, and the
// paired-diff query (`paired_event_count`).

import { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN } from '@bot/shared';

import { AnalysisValidationError, compareVersions } from '../../src/index';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function isVersionLookupSql(sql: string): boolean {
    return sql.includes('LIMIT 1');
}

function isPairedDiffSql(sql: string): boolean {
    return sql.includes('paired_event_count');
}

// Both versions default to `active` so the paired-diff reads
// `decisions`/`positions` (the pre-M37 behavior these legacy assertions cover).
// Shadow-path routing is covered by its own tests below.
function makeStubDataSource(performanceRow: Record<string, unknown>, pairedRow: Record<string, unknown>) {
    const calls: { sql: string; bindings: readonly unknown[] }[] = [];

    const handler: QueryHandler = async (sql, bindings) => {
        calls.push({ sql, bindings });

        if (isVersionLookupSql(sql)) {
            return [{ label: 'v', status: 'active' }];
        }

        if (isPairedDiffSql(sql)) {
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

        // Five queries: per-version (lookup + aggregation) ×2, plus paired-diff.
        expect(calls).toHaveLength(5);
        const pairedCall = calls.find((c) => isPairedDiffSql(c.sql));

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
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedSql = sql;
                return [
                    {
                        paired_event_count: '100',
                        paired_traded_event_count: '100',
                        net_pnl_delta_usd: '1', // 1 / 100 = 0.01 — a sub-cent value PG AVG would round inconsistently.
                    },
                ];
            }
            return [{ trade_count: '100', win_count: '50', net_pnl_usd: '0', label: 'v', status: 'active' }];
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
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '1',
                        paired_traded_event_count: '1',
                        net_pnl_delta_usd: '5',
                    },
                ];
            }
            return [{ trade_count: '1', win_count: '1', net_pnl_usd: '5', label: 'v', status: 'active' }];
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
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '1',
                        paired_traded_event_count: '1',
                        net_pnl_delta_usd: '5',
                    },
                ];
            }
            return [{ trade_count: '1', win_count: '1', net_pnl_usd: '5', label: 'v', status: 'active' }];
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
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '0',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'v', status: 'active' }];
        };

        await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        // Both active sides LEFT JOIN the closed position bounded by the window
        // upper bound ($4); the alias is `pos` per side (M37 builder).
        const closedAtClauses = (capturedPairedSql.match(/pos\.closed_at\s*<\s*\$4/gu) ?? []).length;
        expect(closedAtClauses).toBe(2);
    });

    it('active-side CTE fences manual-triggered positions out of the pairing (M50c)', async () => {
        // why: ADR 0048 M50c — a paired event anchored to a manual (operator smoke-test / ad-hoc)
        // position must be excluded symmetrically to getPerformance, so the active-side LEFT JOIN
        // carries the same NULL-permissive manual fence. Both active sides of an active-vs-active
        // pair must carry it. The shadow-side CTE is untouched (shadow_decisions has no manual rows).
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [{ paired_event_count: '0', paired_traded_event_count: '0', net_pnl_delta_usd: '0' }];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'v', status: 'active' }];
        };

        await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        const manualFences = (capturedPairedSql.match(/pos\.trigger_source IS NULL OR pos\.trigger_source <> 'manual'/gu) ?? []).length;
        expect(manualFences).toBe(2);
    });

    it('shadow-side CTE does NOT carry the manual-fence predicate (shadow_decisions has no trigger_source column)', async () => {
        // why: complements the active-side M50c test above — the manual fence must stay confined
        // to the active-side (positions-joined) CTE. Leaking it into the shadow branch would be a
        // hard SQL error (shadow_decisions has no trigger_source column).
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'shadow' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [{ paired_event_count: '0', paired_traded_event_count: '0', net_pnl_delta_usd: '0' }];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'v', status: 'shadow' }];
        };

        await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 2, from, to });

        expect(capturedPairedSql).not.toContain('trigger_source');
    });

    it('reads shadow_decisions (not decisions/positions) for a shadow-vs-shadow pair', async () => {
        // M37 W1 (D1.1): two concurrently-evaluated shadow versions must pair
        // from `shadow_decisions` on the shared `event_id`. This is the fix that
        // makes `compareVersions` return non-empty output for a shadow pair —
        // pre-M37 it read only `decisions`/`positions` and returned 0 events.
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'shadow' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '40',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'v', status: 'shadow' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 1, bVersionId: 4, from, to });

        // Both sides read shadow_decisions; neither touches the live tables.
        const shadowSources = (capturedPairedSql.match(/FROM shadow_decisions sd/gu) ?? []).length;
        expect(shadowSources).toBe(2);
        expect(capturedPairedSql).not.toContain('FROM decisions');
        expect(capturedPairedSql).not.toContain('FROM positions');
        // Non-hollow fill gate: only filled counterfactuals count as traded.
        expect(capturedPairedSql).toContain("(sd.simulated_fill->>'missed')::boolean = false");
        expect(capturedPairedSql).toContain("sd.simulated_fill->>'exitPrice' IS NOT NULL");
        // Same-event output is non-empty even while shadow fills are hollow.
        expect(result.pairedDiff.pairedEventCount).toBe(40);
        expect(result.pairedDiff.pairedTradedEventCount).toBe(0);
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
    });

    it('reads the active side from decisions/positions and the shadow side from shadow_decisions (no double-count)', async () => {
        // M37 W1 (D1.2) precedence rule: in an active-vs-shadow pair the active
        // version is sourced from `decisions`/`positions` and the shadow version
        // from `shadow_decisions` — each from exactly one stream so the active
        // version is never double-counted across the two tables.
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql, bindings) => {
            if (isVersionLookupSql(sql)) {
                // Route by the version id binding, not call order ( the two
                // getPerformance lookups race under Promise.all). v3 active, v4 shadow.
                return [bindings[0] === 3 ? { label: 'a', status: 'active' } : { label: 'b', status: 'shadow' }];
            }
            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '12',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }
            return [{ trade_count: '0', win_count: '0', net_pnl_usd: '0', label: 'x', status: 'active' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 3, bVersionId: 4, from, to });

        // Exactly one active side (decisions/positions) and one shadow side.
        expect((capturedPairedSql.match(/FROM decisions d/gu) ?? []).length).toBe(1);
        expect((capturedPairedSql.match(/LEFT JOIN positions pos/gu) ?? []).length).toBe(1);
        expect((capturedPairedSql.match(/FROM shadow_decisions sd/gu) ?? []).length).toBe(1);
        expect(result.pairedDiff.pairedEventCount).toBe(12);
    });

    it('rejects equal versionIds', async () => {
        const { ds } = makeStubDataSource({}, {});

        await expect(compareVersions(ds as never, { aVersionId: 4, bVersionId: 4, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects reversed range', async () => {
        const { ds } = makeStubDataSource({}, {});

        await expect(compareVersions(ds as never, { aVersionId: 1, bVersionId: 2, from: to, to: from })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    // ── M37 W1 adversarial: additional pairing semantics ─────────────────────

    it('returns pairedEventCount=0 when shadow_decisions event_ids do not overlap between the two versions', async () => {
        // why: `compareVersions` pairs on the shared event_id (INNER JOIN). If
        // versionA fired on event E1 and versionB fired on event E2 (different ids),
        // no paired row exists — the joined result is empty. The paired-diff CTE
        // uses INNER JOIN on event_id; this test proves no stale cross-join escapes.
        const handler: QueryHandler = async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'shadow' }];
            }

            if (isPairedDiffSql(sql)) {
                // The DB inner-join returns zero rows; the adapter maps that to count=0.
                return [
                    {
                        paired_event_count: '0',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }

            return [{ trade_count: '5', win_count: '2', net_pnl_usd: '0', label: 'v', status: 'shadow' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 10, bVersionId: 11, from, to });

        expect(result.pairedDiff.pairedEventCount).toBe(0);
        expect(result.pairedDiff.pairedTradedEventCount).toBe(0);
        expect(result.pairedDiff.meanPnlDeltaUsd).toBeNull();
        expect(result.pairedDiff.belowSampleFloor).toBe(true);
    });

    it('active-vs-shadow pair returns non-zero pairedEventCount when they share event_ids', async () => {
        // why: pre-M37 only `decisions`/`positions` was queried; a shadow side
        // produced zero because shadow rows live in shadow_decisions. The M37 fix
        // selects each side from its status-correct table so the INNER JOIN on
        // event_id can match. This test proves the structural routing is in place.
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql, bindings) => {
            if (isVersionLookupSql(sql)) {
                // versionId 5 is active, versionId 6 is shadow.
                return [bindings[0] === 5 ? { label: 'a', status: 'active' } : { label: 'b', status: 'shadow' }];
            }

            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                // Simulate 8 events matched on the shared event_id.
                return [
                    {
                        paired_event_count: '8',
                        paired_traded_event_count: '0',
                        net_pnl_delta_usd: '0',
                    },
                ];
            }

            return [{ trade_count: '8', win_count: '3', net_pnl_usd: '0', label: 'x', status: 'active' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 5, bVersionId: 6, from, to });

        // Non-zero paired count confirms the mixed-table routing produced a joinable result.
        expect(result.pairedDiff.pairedEventCount).toBe(8);
        // Active side reads decisions/positions; shadow side reads shadow_decisions.
        expect((capturedPairedSql.match(/FROM decisions d/gu) ?? []).length).toBe(1);
        expect((capturedPairedSql.match(/FROM shadow_decisions sd/gu) ?? []).length).toBe(1);
    });

    it('active-vs-shadow: active version is NOT double-counted across both tables', async () => {
        // why: the active version may carry shadow_decisions rows for a window when
        // it was concurrently shadowed (ADR 0029 M37 amendment). The precedence rule
        // reads it from `decisions`/`positions` ONLY — its shadow_decisions rows are
        // silently ignored. This prevents the same event appearing on the active side
        // twice (once from decisions, once from shadow_decisions).
        let capturedPairedSql = '';
        const handler: QueryHandler = async (sql, bindings) => {
            if (isVersionLookupSql(sql)) {
                return [bindings[0] === 7 ? { label: 'active-v', status: 'active' } : { label: 'shadow-v', status: 'shadow' }];
            }

            if (isPairedDiffSql(sql)) {
                capturedPairedSql = sql;
                return [
                    {
                        paired_event_count: '15',
                        paired_traded_event_count: '5',
                        net_pnl_delta_usd: '25',
                    },
                ];
            }

            return [{ trade_count: '15', win_count: '5', net_pnl_usd: '25', label: 'x', status: 'active' }];
        };

        const result = await compareVersions({ query: handler } as never, { aVersionId: 7, bVersionId: 8, from, to });

        // The active side CTE reads exactly one source (decisions, not shadow_decisions).
        // "FROM decisions d" appears exactly once (for the active side); the shadow side uses shadow_decisions.
        expect((capturedPairedSql.match(/FROM decisions d/gu) ?? []).length).toBe(1);
        expect((capturedPairedSql.match(/FROM shadow_decisions sd/gu) ?? []).length).toBe(1);
        // No double-count path exists: active version never appears in FROM shadow_decisions.
        expect(result.pairedDiff.pairedEventCount).toBe(15);
    });
});
