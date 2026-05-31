import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W6 corrective. The PromoteShadowStrategyVersions20260621000000
// migration promoted ALL draft rows (including the configured active v1,
// id=2) to SHADOW. v1 is the live trading strategy per
// ACTIVE_STRATEGY_VERSION_ID=2 in .env; it must carry status='active', not
// 'shadow', so findActiveShadows does not fan it out as a shadow of itself.
// Only v2 (id=3) and v3 (id=4) should be SHADOW.
export class CorrectActiveStrategyStatus20260531000000 implements MigrationInterface {
    name = 'CorrectActiveStrategyStatus20260531000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // v0 (id=1) becomes shadow so it is included in shadow comparison;
        // constraint uq_strategy_versions_active_per_name requires clearing
        // the active slot before promoting v1.
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = 1 AND "status" = 'active'`,
        );
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'active' WHERE "strategy_versions_id" = 2 AND "status" = 'shadow'`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = 2 AND "status" = 'active'`,
        );
        await queryRunner.query(
            `UPDATE "strategy_versions" SET "status" = 'active' WHERE "strategy_versions_id" = 1 AND "status" = 'shadow'`,
        );
    }
}
