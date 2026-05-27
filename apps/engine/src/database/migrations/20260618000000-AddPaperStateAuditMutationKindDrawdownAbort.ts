import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a R2c.D — widens `paper_state_audit.mutation_kind` CHECK to admit the
// two new mutation kinds introduced by Items 2 and 3:
//
//   - DRAWDOWN_ABORT     (PaperDrawdownAbortHandler, ADR 0032 §D5 + §D11)
//   - FUNDING_CAP_BREACH (PaperFundingAccrualService, ADR 0032 §D4 magnitude
//                         bound is apply-and-alert — the breach gets its own
//                         audit row so the violation is grep-able post-soak)
//
// Reversible: down() restores the pre-R2c.D CHECK constraint exactly so a
// rollback is byte-equivalent. Per `code-conventions.md` — `each`-transaction
// mode is the TypeORM default; this migration is a CHECK constraint swap so
// it does not need explicit batching.

export class AddPaperStateAuditMutationKindDrawdownAbort20260618000000 implements MigrationInterface {
    name = 'AddPaperStateAuditMutationKindDrawdownAbort20260618000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "paper_state_audit"
            DROP CONSTRAINT IF EXISTS "ck_paper_state_audit_mutation_kind"
        `);

        await queryRunner.query(`
            ALTER TABLE "paper_state_audit"
            ADD CONSTRAINT "ck_paper_state_audit_mutation_kind" CHECK (
                "mutation_kind" IN (
                    'OPEN_POSITION',
                    'CLOSE_POSITION',
                    'APPLY_FUNDING',
                    'APPLY_FILL',
                    'OPERATOR_DRAIN',
                    'RECONCILIATION_FORCED',
                    'META_INIT',
                    'SNAPSHOT',
                    'DRAWDOWN_ABORT',
                    'FUNDING_CAP_BREACH'
                )
            )
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "paper_state_audit"
            DROP CONSTRAINT IF EXISTS "ck_paper_state_audit_mutation_kind"
        `);

        await queryRunner.query(`
            ALTER TABLE "paper_state_audit"
            ADD CONSTRAINT "ck_paper_state_audit_mutation_kind" CHECK (
                "mutation_kind" IN (
                    'OPEN_POSITION',
                    'CLOSE_POSITION',
                    'APPLY_FUNDING',
                    'APPLY_FILL',
                    'OPERATOR_DRAIN',
                    'RECONCILIATION_FORCED',
                    'META_INIT',
                    'SNAPSHOT'
                )
            )
        `);
    }
}
