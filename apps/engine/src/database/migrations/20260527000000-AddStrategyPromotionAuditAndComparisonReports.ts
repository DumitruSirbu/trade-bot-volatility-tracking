import { MigrationInterface, QueryRunner } from 'typeorm';

// M8 W2 (ADR 0016 §2.1 + ADR 0017 §2.6): add the promotion-audit columns to
// strategy_versions, enforce "exactly one ACTIVE per name" at the DB level, and
// create the comparison_reports anchor table that promotion decisions reference.
//
//   - strategy_versions.promoted_at        timestamptz NULL — when the row became active
//   - strategy_versions.archived_at        timestamptz NULL — when the row was demoted
//   - strategy_versions.promotion_report_id integer NULL — FK → comparison_reports.id
//                                                          ON DELETE SET NULL (a deleted
//                                                          comparison report must not
//                                                          orphan-cascade strategy rows)
//   - strategy_versions.promotion_note     text NULL — operator-supplied audit reason
//
//   - uq_strategy_versions_active_per_name — partial unique index keyed on (name)
//                                            WHERE status = 'active'. DB-level guarantee
//                                            that only one row of a given name is live.
//
//   - comparison_reports table — anchors a walk-forward / same-event comparison run.
//                                version_ids stored as integer[]; folds + split_policy +
//                                summary as jsonb. The full IComparisonReport JSON lives
//                                on disk; only the summary persists in Postgres.
//
// Reversible: down() drops the FK, the table, the partial unique index, and the four
// columns in the EXACT reverse order of up().

export class AddStrategyPromotionAuditAndComparisonReports20260527000000 implements MigrationInterface {
    name = 'AddStrategyPromotionAuditAndComparisonReports20260527000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Promotion-audit columns on strategy_versions. promotion_report_id is added
        //    WITHOUT the FK first; the FK is attached after comparison_reports exists.
        await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "promoted_at" timestamptz`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "archived_at" timestamptz`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "promotion_report_id" integer`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "promotion_note" text`);

        // 2. Partial unique index — at most one row per name with status='active'.
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_strategy_versions_active_per_name" ON "strategy_versions" ("name") WHERE "status" = 'active'`);

        // 3. comparison_reports anchor table.
        await queryRunner.query(`
            CREATE TABLE "comparison_reports" (
                "comparison_reports_id" BIGSERIAL NOT NULL,
                "run_label" text NOT NULL,
                "from_ms" bigint NOT NULL,
                "to_ms" bigint NOT NULL,
                "split_policy" jsonb NOT NULL,
                "folds" jsonb NOT NULL,
                "version_ids" integer[] NOT NULL,
                "summary" jsonb NOT NULL,
                "artefact_uri" text NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "pk_comparison_reports" PRIMARY KEY ("comparison_reports_id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "idx_comparison_reports_created_at" ON "comparison_reports" ("created_at")`);

        // 4. Now that comparison_reports exists, attach the FK from strategy_versions.
        //    ON DELETE SET NULL — deleting a comparison report must not orphan-cascade
        //    strategy rows; the audit reference simply unlinks.
        await queryRunner.query(`
            ALTER TABLE "strategy_versions"
            ADD CONSTRAINT "fk_strategy_versions_promotion_report"
            FOREIGN KEY ("promotion_report_id")
            REFERENCES "comparison_reports" ("comparison_reports_id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse exact order of up(): drop FK → drop table (+ its index) → drop partial
        // unique index → drop columns in reverse add order.
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP CONSTRAINT IF EXISTS "fk_strategy_versions_promotion_report"`);

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_comparison_reports_created_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "comparison_reports"`);

        await queryRunner.query(`DROP INDEX IF EXISTS "uq_strategy_versions_active_per_name"`);

        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "promotion_note"`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "promotion_report_id"`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "archived_at"`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "promoted_at"`);
    }
}
