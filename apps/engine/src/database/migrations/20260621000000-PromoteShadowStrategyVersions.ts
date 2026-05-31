import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W5a (ADR 0029 §2.2 follow-up). The W4 logic reviewer flagged that
// `StrategyVersionRepository.findActiveShadows` filtered on
// `status != ARCHIVED`, which let DRAFT (and any inadvertent second ACTIVE)
// rows receive synthetic shadow decisions. The repository now filters on
// `status = SHADOW` explicitly; this migration converts the seeded volatility-
// vwap DRAFT rows (v0–v3 minus the configured active version) to the new
// SHADOW status so the orchestrator continues to fan out over them after the
// query tightens.
//
// Idempotent: an UPDATE bounded by (status = 'draft' AND name = $1) is a no-op
// after the first run. down() reverses by restoring DRAFT — the soak DB is the
// only environment carrying these rows and DRAFT is the closest pre-SHADOW
// label per the original seed migration.

const STRATEGY_NAME = 'volatility-vwap';

export class PromoteShadowStrategyVersions20260621000000 implements MigrationInterface {
    name = 'PromoteShadowStrategyVersions20260621000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "name" = $1 AND "status" = 'draft'`, [STRATEGY_NAME]);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'draft' WHERE "name" = $1 AND "status" = 'shadow'`, [STRATEGY_NAME]);
    }
}
