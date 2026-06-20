// M12 W1 — getPerformance unit tests.
//
// Unit-scope: a stub DataSource captures the SQL + bindings and returns
// fixture rows so we exercise mapping + validation without a live Postgres.
// A `mcp_reader`-backed integration spec is W5 (QA wave).
//
// M37 W1: `getPerformance` now resolves `strategy_versions.status` FIRST (a
// 1-row `LIMIT 1` lookup) to choose the active (`positions`) vs shadow
// (`shadow_decisions`) aggregation source, then runs the aggregation. The
// stub helper routes the lookup query (`LIMIT 1`) separately from the
// aggregation query.

import { getPerformance } from '../../src/query/getPerformance';
import { AnalysisValidationError } from '../../src/util/analysisValidation';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

interface IStubDataSource {
    query: QueryHandler;
}

function stubDataSource(handler: QueryHandler): IStubDataSource {
    return { query: handler };
}

function isVersionLookupSql(sql: string): boolean {
    return sql.includes('LIMIT 1');
}

describe('getPerformance', () => {
    const versionId = 7;
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    it('aggregates closed positions for an active version over a window', async () => {
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'momentum@v3', status: 'active' }];
            }

            return [
                {
                    trade_count: '12',
                    win_count: '7',
                    net_pnl_usd: '345.6789',
                    label: 'momentum@v3',
                    status: 'active',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.strategyVersionId).toBe('7');
        expect(view.label).toBe('momentum@v3');
        expect(view.status).toBe('active');
        expect(view.tradeCount).toBe(12);
        expect(view.winRate).toBe((7 / 12).toFixed(6));
        expect(view.netPnlUsd).toBe('345.6789');
        expect(view.windowDays).toBe(31);
        expect(view.maxDrawdownUsd).toBeNull();
        expect(view.sharpe).toBeNull();
        expect(view.sortino).toBeNull();
        expect(view.expectancyPerUnitRisk).toBeNull();
    });

    it('handles an empty window by resolving label/status from the version lookup', async () => {
        // why: M37 W1 — the version lookup (label/status) now runs FIRST and
        // always, so even an empty aggregation window surfaces the canonical
        // `name@v<version>` label, not `unknown@v<id>`. A shadow version with no
        // non-hollow fills aggregates to 0 trades from `shadow_decisions`.
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'volatility-vwap@v0', status: 'shadow' }];
            }

            return [];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.tradeCount).toBe(0);
        expect(view.winRate).toBeNull();
        expect(view.netPnlUsd).toBe('0');
        expect(view.label).toBe('volatility-vwap@v0');
        expect(view.status).toBe('shadow');
    });

    it('throws AnalysisValidationError when versionId does not exist in strategy_versions', async () => {
        const ds = stubDataSource(async () => []);

        await expect(getPerformance(ds as never, { versionId: 999_999, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('parameterizes the SQL — no values interpolated into the query text', async () => {
        let capturedSql = '';
        let capturedBindings: readonly unknown[] = [];

        const ds = stubDataSource(async (sql, bindings) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'x@v1', status: 'active' }];
            }

            capturedSql = sql;
            capturedBindings = bindings;

            return [{ trade_count: '1', win_count: '0', net_pnl_usd: '0', label: 'x@v1', status: 'active' }];
        });

        await getPerformance(ds as never, { versionId, from, to });

        // Bindings are positional ($1, $2, $3) and no symbol/version is
        // string-interpolated into the SQL text.
        expect(capturedSql).toContain('$1');
        expect(capturedSql).toContain('$2');
        expect(capturedSql).toContain('$3');
        expect(capturedSql).not.toContain(String(versionId));
        expect(capturedBindings).toEqual([versionId, from.toISOString(), to.toISOString()]);
    });

    it('rejects reversed range (to <= from)', async () => {
        const ds = stubDataSource(async () => []);

        await expect(getPerformance(ds as never, { versionId, from: to, to: from })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects NaN dates', async () => {
        const ds = stubDataSource(async () => []);
        const nan = new Date('not-a-date');

        await expect(getPerformance(ds as never, { versionId, from: nan, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getPerformance(ds as never, { versionId, from, to: nan })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('rejects non-positive versionId', async () => {
        const ds = stubDataSource(async () => []);

        await expect(getPerformance(ds as never, { versionId: 0, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getPerformance(ds as never, { versionId: -3, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
        await expect(getPerformance(ds as never, { versionId: 1.5, from, to })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('emits netPnlUsd in canonical Decimal.toFixed() shape, matching engine `Money.toFixed()`', async () => {
        // why: previously the raw `::text` cast surfaced PG's NUMERIC scale
        // verbatim (e.g. "123.450000000000000000"). The engine emits
        // `new Money(...).toFixed()` (e.g. "123.45") — wrapping through shared
        // decimalMath collapses both surfaces to the same canonical form.
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'v', status: 'active' }];
            }

            return [
                {
                    trade_count: '1',
                    win_count: '1',
                    net_pnl_usd: '123.450000000000000000',
                    label: 'v',
                    status: 'active',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.netPnlUsd).toBe('123.45');
    });

    it('rejects ranges beyond the 366-day hard ceiling', async () => {
        const ds = stubDataSource(async () => []);
        const farTo = new Date(from.getTime() + 400 * 86_400_000);

        await expect(getPerformance(ds as never, { versionId, from, to: farTo })).rejects.toBeInstanceOf(AnalysisValidationError);
    });

    it('aggregates a shadow version from shadow_decisions (not positions) by status', async () => {
        // M37 W1 (D1.1/D1.2): a shadow version has no `positions` rows; its
        // aggregation must read `shadow_decisions`. The status lookup selects
        // the source — the aggregation query must target shadow_decisions and
        // never the positions table.
        let aggregationSql = '';
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'hybrid@v3', status: 'shadow' }];
            }

            aggregationSql = sql;

            return [{ trade_count: '4', win_count: '0', net_pnl_usd: '0', label: 'hybrid@v3', status: 'shadow' }];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(aggregationSql).toContain('shadow_decisions');
        expect(aggregationSql).not.toContain('FROM positions');
        expect(view.status).toBe('shadow');
        expect(view.tradeCount).toBe(4);
        // PnL stays '0' on the shadow path until the D1.6 fill-simulator repair.
        expect(view.netPnlUsd).toBe('0');
    });

    it('aggregates an active version from positions (not shadow_decisions) by status', async () => {
        // M37 W1 (D1.2): the active version is read from `positions`, never
        // from `shadow_decisions`, even though it may carry shadow rows for a
        // concurrently-shadowed window — the precedence rule prevents
        // double-counting.
        let aggregationSql = '';
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'momentum@v2', status: 'active' }];
            }

            aggregationSql = sql;

            return [{ trade_count: '9', win_count: '4', net_pnl_usd: '12.5', label: 'momentum@v2', status: 'active' }];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(aggregationSql).toContain('FROM positions');
        expect(aggregationSql).not.toContain('shadow_decisions');
        expect(view.status).toBe('active');
        expect(view.tradeCount).toBe(9);
        expect(view.netPnlUsd).toBe('12.5');
    });

    // ── M37 W1 (D1.1/D1.2) adversarial: hollow-fill exclusion ────────────────

    it('hollow fills (missed=true) do NOT increment tradeCount — shadow aggregation only counts non-hollow', async () => {
        // why: the shadow SQL filters `missed=false AND exitPrice IS NOT NULL`.
        // A row where missed=true is a counterfactual miss (no market fill);
        // counting it inflates tradeCount and yields an optimistic win-rate.
        // This test proves the SQL carries the filter predicate.
        let aggregationSql = '';
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'fade@v1', status: 'shadow' }];
            }

            aggregationSql = sql;

            // Simulates 3 rows total but only 1 has missed=false AND exitPrice IS NOT NULL;
            // the stub returns trade_count='1' as the DB would after applying the filter.
            return [{ trade_count: '1', win_count: '0', net_pnl_usd: '0', label: 'fade@v1', status: 'shadow' }];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        // The aggregation SQL must carry the non-hollow gate — verify the predicate text.
        expect(aggregationSql).toContain("(sd.simulated_fill->>'missed')::boolean = false");
        expect(aggregationSql).toContain("sd.simulated_fill->>'exitPrice' IS NOT NULL");
        // Only non-hollow fills surface as trades.
        expect(view.tradeCount).toBe(1);
    });

    // ── M40 D4 (StuckPositionSweeper) denominator guard ──────────────────────

    it('swept never-filled closed row (realized_pnl IS NULL) is EXCLUDED from trade_count — FILTER clause present', async () => {
        // why: StuckPositionSweeper finalizes orphaned pending_open rows via
        // RECONCILED_MISSING, writing realized_pnl=null (they never traded).
        // Without `FILTER (WHERE realized_pnl IS NOT NULL)`, these rows inflate
        // the trade_count denominator and depress the win-rate. The active-version
        // SQL must carry the explicit filter predicate.
        //
        // The stub returns trade_count='2' (DB applied the filter; only 2 of 3
        // closed rows have non-null pnl) to prove the gate is exercised in the SQL.
        let capturedSql = '';
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'active@v1', status: 'active' }];
            }

            capturedSql = sql;

            // 3 closed rows: 2 real trades (pnl non-null), 1 swept orphan (pnl=null).
            // The DB returns count=2 after applying FILTER (WHERE realized_pnl IS NOT NULL).
            return [{ trade_count: '2', win_count: '1', net_pnl_usd: '50.00', label: 'active@v1', status: 'active' }];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        // SQL carries the denominator filter predicate
        expect(capturedSql).toContain('FILTER (WHERE p.realized_pnl IS NOT NULL)');
        // The swept row is excluded from the count
        expect(view.tradeCount).toBe(2);
        // win_count / net_pnl_usd remain correct (they already ignore null via > 0 / SUM)
        expect(view.winRate).toBe((1 / 2).toFixed(6));
        expect(view.netPnlUsd).toBe('50');
    });

    it('shadow aggregation uses created_at (not closed_at) as the window key', async () => {
        // why: shadow rows have no closed_at column; the simulated close lives inside
        // JSONB. Using closed_at would always miss shadow rows and yield tradeCount=0.
        let aggregationSql = '';
        const ds = stubDataSource(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'reversion@v5', status: 'shadow' }];
            }

            aggregationSql = sql;

            return [{ trade_count: '7', win_count: '0', net_pnl_usd: '0', label: 'reversion@v5', status: 'shadow' }];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        // Shadow path must window on created_at, not closed_at.
        expect(aggregationSql).toContain('sd.created_at');
        expect(aggregationSql).not.toContain('sd.closed_at');
        expect(view.tradeCount).toBe(7);
    });
});
