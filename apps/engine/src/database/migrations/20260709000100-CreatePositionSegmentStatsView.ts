import { MigrationInterface, QueryRunner } from 'typeorm';

// M47 Task 5c — signal-quality data foundation: the read-only `position_segment_stats` view.
// Segments CLOSED positions by flow_type / symbol / strategy_versions_id / side / hour_of_day
// and exposes per-segment win rate, avg PnL, avg R:R, avg MFE, avg MAE, and trade count. This
// is read-only analytics infrastructure for M48 — it touches NO trade path, NO strategy logic,
// NO risk gate, and carries no live-trading risk.
//
// ── PLAIN VIEW (not materialized) ──
// A plain view is chosen for simplicity: it always reflects the live `positions` table with no
// refresh cadence to operate, and the closed-position set is small enough that on-demand
// aggregation is cheap. If query volume later demands it, this can be promoted to a materialized
// view in a follow-up migration with an explicit REFRESH schedule.
//
// ── Column-existence precondition (HIGH 6) ──
// `positions` already persists `stop_loss_price`, `take_profit_price`, and `entry_price` (M2
// schema / PositionEntity), so `avg_rr` is well-defined and never silently null. No column add
// is needed in this migration.
//
// ── Notes for readers ──
// - `avg_mfe_pct` (>= 0) and `avg_mae_pct` (<= 0) are only MEANINGFUL after M47 Task 5a fixes
//   the async seed-timing race; until then the underlying columns read near-zero because the
//   entry-window ticks were dropped. `avg_mae_pct` aggregates a NON-POSITIVE column — it is a
//   signed excursion, NOT a positive magnitude; do not present it as positive.
// - `avg_rr` uses the FILL-anchored `entry_price`, not the signal-reference price. The drift
//   between fill-anchored and signal-anchored R:R is bounded by the M38 fill-acceptance guard.
// - Pre/post-M47 trades are partitioned by `strategy_versions_id` (BLOCKER 4): the new
//   geometry-coupled version rows carry new IDs, so filtering on this key separates pre-M47
//   inverted-geometry trades from post-M47 coupled-geometry trades by construction.
// - `hour_of_day` is the UTC hour extracted from `opened_at`.
export class CreatePositionSegmentStatsView20260709000100 implements MigrationInterface {
    name = 'CreatePositionSegmentStatsView20260709000100';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE VIEW "position_segment_stats" AS
            SELECT
                "flow_type_at_entry" AS "flow_type",
                "symbol",
                "strategy_version_id" AS "strategy_versions_id",
                "side",
                EXTRACT(HOUR FROM "opened_at" AT TIME ZONE 'UTC')::integer AS "hour_of_day",
                COUNT(*) FILTER (WHERE "realized_pnl" > 0)::numeric / NULLIF(COUNT(*), 0) AS "win_rate",
                AVG("realized_pnl") AS "avg_pnl",
                AVG(
                    CASE
                        WHEN "side" = 'long'
                            THEN ("take_profit_price" - "entry_price") / NULLIF("entry_price" - "stop_loss_price", 0)
                        ELSE ("entry_price" - "take_profit_price") / NULLIF("stop_loss_price" - "entry_price", 0)
                    END
                ) AS "avg_rr",
                AVG("mfe_pct") AS "avg_mfe_pct",
                AVG("mae_pct") AS "avg_mae_pct",
                COUNT(*) AS "trade_count"
            FROM "positions"
            WHERE "state" = 'closed'
            GROUP BY
                "flow_type_at_entry",
                "symbol",
                "strategy_version_id",
                "side",
                EXTRACT(HOUR FROM "opened_at" AT TIME ZONE 'UTC')
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP VIEW IF EXISTS "position_segment_stats"`);
    }
}
