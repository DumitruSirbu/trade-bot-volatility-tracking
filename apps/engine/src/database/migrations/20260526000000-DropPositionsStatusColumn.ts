import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropPositionsStatusColumn20260526000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        // Drop old status-keyed indices
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_positions_strategy_version_id_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_positions_symbol_status"`);
        // Drop the legacy alias column
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN IF EXISTS "status"`);
        // Create state-keyed indices
        await queryRunner.query(`CREATE INDEX "idx_positions_strategy_version_id_state" ON "positions" ("strategy_version_id", "state")`);
        await queryRunner.query(`CREATE INDEX "idx_positions_symbol_state" ON "positions" ("symbol", "state")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_positions_strategy_version_id_state"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_positions_symbol_state"`);
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "status" varchar NOT NULL DEFAULT 'open'`);
        await queryRunner.query(`CREATE INDEX "idx_positions_strategy_version_id_status" ON "positions" ("strategy_version_id", "status")`);
        await queryRunner.query(`CREATE INDEX "idx_positions_symbol_status" ON "positions" ("symbol", "status")`);
    }
}
