import { MigrationInterface, QueryRunner } from 'typeorm';

// Baseline migration. M0 ships no entities yet; this records a clean starting
// point so the migrations table exists and later migrations have an anchor.
// Intentionally a no-op in both directions — running and reverting it are safe.
export class Baseline20260522000000 implements MigrationInterface {
    name = 'Baseline20260522000000';

    async up(_queryRunner: QueryRunner): Promise<void> {
        // No schema yet. First entity migration follows in M1.
    }

    async down(_queryRunner: QueryRunner): Promise<void> {
        // Nothing to reverse.
    }
}
