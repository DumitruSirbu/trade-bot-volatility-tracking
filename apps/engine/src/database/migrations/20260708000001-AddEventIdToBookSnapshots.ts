import { MigrationInterface, QueryRunner } from 'typeorm';

// M27 Dispatch C — observability-only. `book_snapshots` previously keyed depth/
// spread rows only by (symbol, ts), with no link back to the triggering volatility
// event. These two additive, nullable columns let a snapshot be joined directly to
// the decision/shadow record that produced it via the stable per-trigger `event_id`.
//
// `event_id` mirrors the same trigger id carried on IVolatilityDetectedEvent
// (`${symbol}:${entryCandleOpenTime}`). `mid_at_trigger` is numeric(38,18)
// (decimal-as-text in code) reserved for the top-of-book mid captured around the
// trigger — written only when bid/ask are available, NULL otherwise.
//
// The UNIQUE index is partial (WHERE event_id IS NOT NULL) so the best-effort
// writer is idempotent on re-emit/restart while legacy snapshot rows (no event
// link) can still coexist with NULL event_id. Both columns nullable, no DEFAULT,
// no backfill. Reversible (reverse order in down()).

export class AddEventIdToBookSnapshots20260708000001 implements MigrationInterface {
    name = 'AddEventIdToBookSnapshots20260708000001';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "book_snapshots" ADD COLUMN "event_id" varchar`);
        await queryRunner.query(`ALTER TABLE "book_snapshots" ADD COLUMN "mid_at_trigger" numeric(38,18)`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_book_snapshots_event_id" ON "book_snapshots" ("event_id") WHERE "event_id" IS NOT NULL`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_book_snapshots_event_id"`);
        await queryRunner.query(`ALTER TABLE "book_snapshots" DROP COLUMN IF EXISTS "mid_at_trigger"`);
        await queryRunner.query(`ALTER TABLE "book_snapshots" DROP COLUMN IF EXISTS "event_id"`);
    }
}
