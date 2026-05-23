import { MigrationInterface, QueryRunner } from 'typeorm';

// M4 (ADR 0004 §4): adds positions.correlation_mode so the risk gate reads the entry's
// idiosyncratic/correlated classification from a real column instead of inferring it from the
// slot. Nullable varchar (CorrelationModeEnum string value); no live rows exist yet (first
// opens land in M5), so no backfill is required. Reversible: down() drops the column.

export class AddPositionCorrelationMode20260523010000 implements MigrationInterface {
    name = 'AddPositionCorrelationMode20260523010000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "positions" ADD COLUMN "correlation_mode" varchar');
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "positions" DROP COLUMN "correlation_mode"');
    }
}
