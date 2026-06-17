// M39 W2 — getPerformance shadow metrics unit tests.
//
// Covers the new `forceCloseFraction` and `missRate` fields on IPerformanceByVersionView:
//
//   SM1 — active version returns forceCloseFraction=null and missRate=null
//          (PERFORMANCE_SQL emits NULL::text for both columns).
//
//   SM2 — shadow version with all force_close traded fills returns forceCloseFraction≈1
//          and missRate≈0 (from a mock row simulating a 100% force_close soak).
//
//   SM3 — shadow version with zero traded fills returns forceCloseFraction=null
//          (NULLIF(denominator, 0) in the shadow SQL yields NULL; mock row carries null).
//
//   SM4 — shadow version with 50% miss rate: missRate='0.50000000'.
//
// All tests use a stub DataSource — no real DB, no integration infrastructure.

import { getPerformance } from '../../src/query/getPerformance';

type QueryHandler = (sql: string, bindings: readonly unknown[]) => Promise<unknown[]>;

function isVersionLookupSql(sql: string): boolean {
    return sql.includes('LIMIT 1');
}

function stubDs(handler: QueryHandler): { query: QueryHandler } {
    return { query: handler };
}

describe('getPerformance — shadow metrics (M39 W2)', () => {
    const versionId = 5;
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');

    // ── SM1 ──────────────────────────────────────────────────────────────────
    it('SM1: active version returns forceCloseFraction=null and missRate=null', async () => {
        // The active-version SQL (PERFORMANCE_SQL) emits NULL::text for both columns.
        const ds = stubDs(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'active@v1', status: 'active' }];
            }

            return [
                {
                    trade_count: '10',
                    win_count: '6',
                    net_pnl_usd: '120.5',
                    force_close_fraction: null,
                    miss_rate: null,
                    label: 'active@v1',
                    status: 'active',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.forceCloseFraction).toBeNull();
        expect(view.missRate).toBeNull();
        expect(view.status).toBe('active');
    });

    // ── SM2 ──────────────────────────────────────────────────────────────────
    it('SM2: shadow version with all force_close traded fills returns forceCloseFraction="1.00000000" and missRate="0.00000000"', async () => {
        // Simulates a soak where every traded fill exited via force_close (0 sl/tp/time_stop)
        // and no open decisions were missed (all got entry fills).
        const ds = stubDs(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'shadow@v2', status: 'shadow' }];
            }

            return [
                {
                    trade_count: '15',
                    win_count: '0',
                    net_pnl_usd: '-2.5',
                    force_close_fraction: '1.00000000',
                    miss_rate: '0.00000000',
                    label: 'shadow@v2',
                    status: 'shadow',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.forceCloseFraction).toBe('1.00000000');
        expect(view.missRate).toBe('0.00000000');
        expect(view.status).toBe('shadow');
        expect(view.tradeCount).toBe(15);
    });

    // ── SM3 ──────────────────────────────────────────────────────────────────
    it('SM3: shadow version with zero traded fills returns forceCloseFraction=null', async () => {
        // NULLIF(denominator, 0) in the shadow SQL yields NULL when no traded fills exist;
        // the mock row carries null directly, simulating the DB output.
        const ds = stubDs(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'shadow@v3', status: 'shadow' }];
            }

            return [
                {
                    trade_count: '0',
                    win_count: '0',
                    net_pnl_usd: '0',
                    force_close_fraction: null, // NULLIF(..., 0) → NULL when denominator is 0
                    miss_rate: '0.50000000', // some misses still counted even with no fills
                    label: 'shadow@v3',
                    status: 'shadow',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.forceCloseFraction).toBeNull();
        expect(view.tradeCount).toBe(0);
    });

    // ── SM4 ──────────────────────────────────────────────────────────────────
    it('SM4: shadow version with 50% miss rate returns missRate="0.50000000"', async () => {
        // Simulates a shadow version where half of all open decisions missed entry
        // (e.g. no tick data available for half the events).
        const ds = stubDs(async (sql) => {
            if (isVersionLookupSql(sql)) {
                return [{ label: 'shadow@v4', status: 'shadow' }];
            }

            return [
                {
                    trade_count: '10',
                    win_count: '5',
                    net_pnl_usd: '30',
                    force_close_fraction: '0.30000000',
                    miss_rate: '0.50000000',
                    label: 'shadow@v4',
                    status: 'shadow',
                },
            ];
        });

        const view = await getPerformance(ds as never, { versionId, from, to });

        expect(view.missRate).toBe('0.50000000');
        expect(view.forceCloseFraction).toBe('0.30000000');
        expect(view.status).toBe('shadow');
    });
});
