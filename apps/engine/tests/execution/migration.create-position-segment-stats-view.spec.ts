/**
 * Migration CreatePositionSegmentStatsView (M47 Task 5c) — unit test.
 *
 * The view is read-only analytics infrastructure for M48 (no trade path). Coverage:
 *   - up() creates the `position_segment_stats` VIEW (plain, not materialized).
 *   - It segments by the five documented keys: flow_type, symbol,
 *     strategy_versions_id, side, hour_of_day (UTC).
 *   - It exposes the documented aggregates: win_rate, avg_pnl, avg_rr, avg_mfe_pct,
 *     avg_mae_pct, trade_count.
 *   - avg_rr is side-relative (CASE on side) with NULLIF div-by-zero guards.
 *   - win_rate guards the denominator with NULLIF(COUNT(*), 0).
 *   - It filters to CLOSED positions only.
 *   - down() drops the view (reversible).
 */

import { QueryRunner } from 'typeorm';

import { CreatePositionSegmentStatsView20260709000100 } from '../../src/database/migrations/20260709000100-CreatePositionSegmentStatsView';

function makeQueryRunner(): { qr: QueryRunner; querySpy: jest.Mock } {
    const querySpy = jest.fn().mockResolvedValue(undefined);
    const qr = { query: querySpy } as unknown as QueryRunner;

    return { qr, querySpy };
}

function firstSql(querySpy: jest.Mock): string {
    return querySpy.mock.calls.map(([sql]) => sql as string).join('\n');
}

describe('Migration CreatePositionSegmentStatsView — up()', () => {
    it('creates a plain VIEW named position_segment_stats (not materialized)', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().up(qr);

        const sql = firstSql(querySpy);
        expect(sql).toMatch(/CREATE VIEW "position_segment_stats"/);
        expect(sql).not.toMatch(/MATERIALIZED/);
    });

    it('segments by the five documented keys including UTC hour_of_day', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().up(qr);

        const sql = firstSql(querySpy);
        expect(sql).toMatch(/"flow_type_at_entry" AS "flow_type"/);
        expect(sql).toContain('"symbol"');
        expect(sql).toMatch(/"strategy_version_id" AS "strategy_versions_id"/);
        expect(sql).toContain('"side"');
        expect(sql).toMatch(/EXTRACT\(HOUR FROM "opened_at" AT TIME ZONE 'UTC'\)::integer AS "hour_of_day"/);
    });

    it('exposes win_rate / avg_pnl / avg_rr / avg_mfe_pct / avg_mae_pct / trade_count', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().up(qr);

        const sql = firstSql(querySpy);
        expect(sql).toMatch(/AS "win_rate"/);
        expect(sql).toMatch(/AVG\("realized_pnl"\) AS "avg_pnl"/);
        expect(sql).toMatch(/AS "avg_rr"/);
        expect(sql).toMatch(/AVG\("mfe_pct"\) AS "avg_mfe_pct"/);
        expect(sql).toMatch(/AVG\("mae_pct"\) AS "avg_mae_pct"/);
        expect(sql).toMatch(/COUNT\(\*\) AS "trade_count"/);
    });

    it('computes avg_rr side-relative with NULLIF div-by-zero guards', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().up(qr);

        const sql = firstSql(querySpy);
        expect(sql).toMatch(/WHEN "side" = 'long'/);
        expect(sql).toContain('NULLIF("entry_price" - "stop_loss_price", 0)');
        expect(sql).toContain('NULLIF("stop_loss_price" - "entry_price", 0)');
    });

    it('guards the win_rate denominator and filters to closed positions only', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().up(qr);

        const sql = firstSql(querySpy);
        expect(sql).toContain('NULLIF(COUNT(*), 0)');
        expect(sql).toMatch(/WHERE "state" = 'closed'/);
    });
});

describe('Migration CreatePositionSegmentStatsView — down()', () => {
    it('drops the view (reversible)', async () => {
        const { qr, querySpy } = makeQueryRunner();

        await new CreatePositionSegmentStatsView20260709000100().down(qr);

        const sql = firstSql(querySpy);
        expect(sql).toMatch(/DROP VIEW IF EXISTS "position_segment_stats"/);
    });
});
