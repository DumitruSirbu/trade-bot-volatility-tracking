import { MigrationInterface, QueryRunner } from 'typeorm';

// Defence-in-depth schema constraints on the boot_mode_history +
// boot_mode_chain_rotations chains (ADR 0032 §D6 / §D7).
//
// Adds a CHECK to both tables rejecting the all-zero placeholder HMAC. The
// repositories write a 32-byte zero buffer as a placeholder during the
// two-phase append (INSERT placeholder → assign seq → UPDATE with real HMAC)
// and immediately overwrite it; if the second phase ever fails to fire (a
// future regression in the repo, a partial migration, or an out-of-band SQL
// insert), this CHECK turns the silent-zero into a hard reject so the
// integrity walker never has to differentiate "real zero HMAC" from a
// tampered row.
//
// The pre-existing `ck_boot_mode_history_row_kind` enum check already exists
// in the 20260612000000 migration; no additional constraint added there.
//
// Reversible: down() drops both new constraints. No data backfill — existing
// rows in M11a-bootstrapped databases all carry real (non-zero) HMACs.

export class HardenBootModeHistorySchema20260614000000 implements MigrationInterface {
    name = 'HardenBootModeHistorySchema20260614000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "boot_mode_history"
            ADD CONSTRAINT "ck_boot_mode_history_this_row_hmac_nonzero"
            CHECK ("this_row_hmac" <> decode(repeat('00', 32), 'hex'))
        `);

        await queryRunner.query(`
            ALTER TABLE "boot_mode_chain_rotations"
            ADD CONSTRAINT "ck_boot_mode_chain_rotations_this_row_hmac_nonzero"
            CHECK ("this_row_hmac" <> decode(repeat('00', 32), 'hex'))
        `);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "boot_mode_chain_rotations" DROP CONSTRAINT IF EXISTS "ck_boot_mode_chain_rotations_this_row_hmac_nonzero"`);
        await queryRunner.query(`ALTER TABLE "boot_mode_history" DROP CONSTRAINT IF EXISTS "ck_boot_mode_history_this_row_hmac_nonzero"`);
    }
}
