// M12 W1 — getPerformance unit tests.
//
// Unit-scope: a stub DataSource captures the SQL + bindings and returns
// fixture rows so we exercise mapping + validation without a live Postgres.
// A `mcp_reader`-backed integration spec is W5 (QA wave).

import { getPerformance } from '../../src/query/getPerformance';
import { AnalysisValidationError } from '../../src/util/analysisValidation';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

interface IStubDataSource {
    query: QueryHandler;
}

function stubDataSource(handler: QueryHandler): IStubDataSource {
    return { query: handler };
}

describe('getPerformance', () => {
    const versionId = 7;
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    it('aggregates closed positions for a version over a window', async () => {
        const ds = stubDataSource(async () => [
            {
                trade_count: '12',
                win_count: '7',
                net_pnl_usd: '345.6789',
                label: 'momentum@v3',
                status: 'shadow',
            },
        ]);

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.strategyVersionId).toBe('7');
        expect(view.label).toBe('momentum@v3');
        expect(view.status).toBe('shadow');
        expect(view.tradeCount).toBe(12);
        expect(view.winRate).toBe((7 / 12).toFixed(6));
        expect(view.netPnlUsd).toBe('345.6789');
        expect(view.windowDays).toBe(31);
        expect(view.maxDrawdownUsd).toBeNull();
        expect(view.sharpe).toBeNull();
        expect(view.sortino).toBeNull();
        expect(view.expectancyPerUnitRisk).toBeNull();
    });

    it('handles an empty window by resolving label/status from strategy_versions directly', async () => {
        // why: post-M12 live-smoke fix — when the aggregation has 0 rows, the
        // query function now falls back to a 1-row lookup against
        // `strategy_versions` so a real active version with 0 trades surfaces
        // its canonical `name@v<version>` label, not `unknown@v<id>`.
        let callCount = 0;
        const ds = stubDataSource(async (_sql, _bindings) => {
            callCount += 1;

            if (callCount === 1) {
                return [];
            }

            return [{ label: 'volatility-vwap@v0', status: 'shadow' }];
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
            capturedSql = sql;
            capturedBindings = bindings;

            return [{ trade_count: '1', win_count: '0', net_pnl_usd: '0', label: 'x@v1', status: 'shadow' }];
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
        const ds = stubDataSource(async () => [
            {
                trade_count: '1',
                win_count: '1',
                net_pnl_usd: '123.450000000000000000',
                label: 'v',
                status: 'shadow',
            },
        ]);

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.netPnlUsd).toBe('123.45');
    });

    it('rejects ranges beyond the 366-day hard ceiling', async () => {
        const ds = stubDataSource(async () => []);
        const farTo = new Date(from.getTime() + 400 * 86_400_000);

        await expect(getPerformance(ds as never, { versionId, from, to: farTo })).rejects.toBeInstanceOf(AnalysisValidationError);
    });
});
