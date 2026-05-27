import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a R2b R2b-fix wave — adds a CHECK constraint enforcing
// `paper_account_snapshots.peak_equity >= 0`. ADR 0032 §D5: peak_equity is
// monotonically non-decreasing in [PAPER_STARTING_EQUITY_USDT, +inf); a
// negative value would invalidate the drawdown denominator's invariants and
// fail closed (drawdown evaluator would produce nonsense). Defence-in-depth
// against any service-layer write that miscomputes the running peak.
//
// Reversible: down() drops the constraint.

export class AddPaperAccountSnapshotsPeakEquityCheck20260617000000 implements MigrationInterface {
    name = 'AddPaperAccountSnapshotsPeakEquityCheck20260617000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "paper_account_snapshots"
            ADD CONSTRAINT "ck_paper_account_snapshots_peak_equity_nonneg"
            CHECK ("peak_equity" >= 0)
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "paper_account_snapshots"
            DROP CONSTRAINT IF EXISTS "ck_paper_account_snapshots_peak_equity_nonneg"
        `);
    }
}
