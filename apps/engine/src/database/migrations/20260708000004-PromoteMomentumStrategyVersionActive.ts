import { MigrationInterface, QueryRunner } from 'typeorm';

// Paper exploration (M25): ACTIVE_STRATEGY_VERSION_ID=3 selects strategy version 2
// (momentum) at runtime, but EnsureActiveStrategyVersion left id=2 (v1 mean-reversion)
// as status='active'. The engine resolves by primary key, not status — this migration
// aligns the promotion-audit label with the configured paper soak so dashboards and
// findActive() match ACTIVE_STRATEGY_VERSION_ID.
//
// Mapping reminder:
//   strategy_versions_id=3 → version column 2 → momentum
//
// Partial unique index uq_strategy_versions_active_per_name allows one active row per name.

const MOMENTUM_ROW_ID = 3;
const MEAN_REVERSION_ROW_ID = 2;

export class PromoteMomentumStrategyVersionActive20260708000004 implements MigrationInterface {
    name = 'PromoteMomentumStrategyVersionActive20260708000004';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = $1 AND "status" = 'active'`, [
            MEAN_REVERSION_ROW_ID,
        ]);
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'active' WHERE "strategy_versions_id" = $1 AND "status" <> 'active'`, [
            MOMENTUM_ROW_ID,
        ]);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'shadow' WHERE "strategy_versions_id" = $1 AND "status" = 'active'`, [
            MOMENTUM_ROW_ID,
        ]);
        await queryRunner.query(`UPDATE "strategy_versions" SET "status" = 'active' WHERE "strategy_versions_id" = $1 AND "status" <> 'active'`, [
            MEAN_REVERSION_ROW_ID,
        ]);
    }
}
