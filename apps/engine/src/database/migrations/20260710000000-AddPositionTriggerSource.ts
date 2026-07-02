import { MigrationInterface, QueryRunner } from 'typeorm';

// M50c (ADR 0048 amendment) — rebalance provenance on the position row. Adds a nullable
// `trigger_source` varchar to `positions` carrying the RebalanceTriggerSourceEnum string
// ('scheduled' | 'manual') for momentum-portfolio opens.
//
// Nullable, no backfill: NULL is the correct and permanent value for every pre-existing row
// and every VWAP / legacy single-symbol open (which has no rebalance-trigger concept). A
// NOT NULL DEFAULT would falsely assert those rows were 'scheduled'. The analysis calibration
// surfaces fence 'manual' rows out of their primary aggregation (getPerformance /
// compareVersions), so operator smoke-tests / ad-hoc rebalances no longer contaminate the
// paper-soak sample. Reversible.

export class AddPositionTriggerSource20260710000000 implements MigrationInterface {
    name = 'AddPositionTriggerSource20260710000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "trigger_source" varchar`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN IF EXISTS "trigger_source"`);
    }
}
