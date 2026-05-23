import { MigrationInterface, QueryRunner } from 'typeorm';

// M5 fix-wave (ADR 0007 §3 + ADR 0006 §5): drop NOT NULL on transactions.position_id so a
// terminal-state-but-zero-fill OPEN intent can persist an audit row without a position
// reference. The CHECK constraint locks this nullability to the only legitimate case:
//   - position_id IS NULL is allowed ONLY when qty = 0 AND type IN ('open','add'). A
//     partial-fill / reduce / close / funding row still requires a position.
//
// This unblocks the "zero-fill audit row" path in ExecutionService.handleNoFill so the
// audit trail records every approved intent, idempotent on transactions.client_order_id.
//
// Reversibility note (DESTRUCTIVE down path): the down migration drops the zero-fill audit
// rows (position_id IS NULL) before re-applying NOT NULL — there is no position to
// backfill them against. Documented per ADR 0007 §3. Run the down only with explicit
// operator awareness that audit history for missed entries will be lost.

export class RelaxTransactionPositionIdNullable20260524020000 implements MigrationInterface {
    name = 'RelaxTransactionPositionIdNullable20260524020000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "position_id" DROP NOT NULL`);
        await queryRunner.query(
            `ALTER TABLE "transactions" ADD CONSTRAINT "ck_transactions_position_id_zero_fill_only" ` +
                `CHECK ("position_id" IS NOT NULL OR ("qty" = 0 AND "type" IN ('open','add')))`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Destructive: drops zero-fill audit rows that have no position to reference.
        await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "ck_transactions_position_id_zero_fill_only"`);
        await queryRunner.query(`DELETE FROM "transactions" WHERE "position_id" IS NULL`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "position_id" SET NOT NULL`);
    }
}
