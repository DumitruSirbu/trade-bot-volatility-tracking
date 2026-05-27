import { MigrationInterface, QueryRunner } from 'typeorm';

// ADR 0032 §D6 — enforces at the DB layer that TRANSITION rows always carry
// both `from_env` and `to_env`, and that non-TRANSITION rows leave both
// columns NULL. The application-side BootModeChainService already obeys this
// invariant, but the CHECK constraint defends against an out-of-band SQL
// insert (operator script, migration error, forensic restore) that would
// otherwise let a TRANSITION row land with NULL endpoints and silently break
// the directional intent the chain encodes.
//
// Reversible: down() drops the constraint. No data backfill needed — the
// existing rows in M11a-bootstrapped databases are all genesis BOOT rows
// with both from_env/to_env NULL, which satisfies the new constraint.

export class AddBootModeHistoryTransitionCheck20260613000000 implements MigrationInterface {
    name = 'AddBootModeHistoryTransitionCheck20260613000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "boot_mode_history"
            ADD CONSTRAINT "ck_boot_mode_history_transition_endpoints"
            CHECK (
                ("row_kind" = 'TRANSITION') = ("from_env" IS NOT NULL AND "to_env" IS NOT NULL)
            )
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "boot_mode_history" DROP CONSTRAINT IF EXISTS "ck_boot_mode_history_transition_endpoints"`);
    }
}
