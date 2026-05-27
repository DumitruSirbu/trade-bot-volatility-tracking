import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the boot_mode_history + boot_mode_chain_rotations tables
// (ADR 0032 §D6 / §D7). — the
// append-only HMAC chain that records every successful boot, mode
// transition, key-rotation witness, chain-restore, or machine-repurpose
// wipe. Verified at every boot by BootModeChainService; chain breaks abort
// the engine with the security-critical exit code. Retained forever per
// ADR 0032 §D16 retention table — both tables are part of the operator
// audit trail across milestones.
//
// Columns (boot_mode_history):
//   - boot_mode_history_id  uuid PK   — surrogate identifier
//   - seq                   BIGSERIAL — monotonic ordering, UNIQUE; bound
//                                       into the signed payload to defeat
//                                       clock-skew row-insertion attacks
//   - booted_at             timestamptz NOT NULL DEFAULT now()
//   - row_kind              text NOT NULL — see CHECK constraint
//   - exchange_env          text NOT NULL — env in effect AFTER the row
//   - from_env              text NULL    — TRANSITION rows only
//   - to_env                text NULL    — TRANSITION rows only
//   - prev_row_hash         bytea NULL   — HMAC of prior row (null on genesis)
//   - this_row_hmac         bytea NOT NULL — HMAC of this row's signed payload
//
// Columns (boot_mode_chain_rotations):
//   - boot_mode_chain_rotation_id uuid PK
//   - seq                   BIGSERIAL UNIQUE
//   - rotated_at            timestamptz NOT NULL DEFAULT now()
//   - from_env              text NOT NULL
//   - to_env                text NOT NULL
//   - pre_tip_hash          bytea NOT NULL — boot_mode_history tip BEFORE the
//                                            transition row was appended
//   - transition_token_hash bytea NOT NULL — SHA-256 of the operator-provided
//                                            transition token trimmed content
//   - prev_row_hash         bytea NULL
//   - this_row_hmac         bytea NOT NULL
//
// Reversible: down() drops indexes (reverse creation order) then tables. The
// pgcrypto extension is NOT dropped — other migrations depend on it.

export class CreateBootModeHistory20260612000000 implements MigrationInterface {
    name = 'CreateBootModeHistory20260612000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        await queryRunner.query(`
            CREATE TABLE "boot_mode_history" (
                "boot_mode_history_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "seq" BIGSERIAL NOT NULL,
                "booted_at" timestamptz NOT NULL DEFAULT now(),
                "row_kind" text NOT NULL,
                "exchange_env" text NOT NULL,
                "from_env" text,
                "to_env" text,
                "prev_row_hash" bytea,
                "this_row_hmac" bytea NOT NULL,
                CONSTRAINT "pk_boot_mode_history" PRIMARY KEY ("boot_mode_history_id"),
                CONSTRAINT "uq_boot_mode_history_seq" UNIQUE ("seq"),
                CONSTRAINT "ck_boot_mode_history_row_kind" CHECK (
                    "row_kind" IN ('BOOT', 'TRANSITION', 'KEY_ROTATION_WITNESS', 'CHAIN_RESTORE', 'MACHINE_REPURPOSE_WIPE')
                ),
                CONSTRAINT "ck_boot_mode_history_exchange_env" CHECK (
                    "exchange_env" IN ('testnet', 'paper', 'live')
                )
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_boot_mode_history_seq" ON "boot_mode_history" ("seq")`);

        await queryRunner.query(`
            CREATE TABLE "boot_mode_chain_rotations" (
                "boot_mode_chain_rotation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "seq" BIGSERIAL NOT NULL,
                "rotated_at" timestamptz NOT NULL DEFAULT now(),
                "from_env" text NOT NULL,
                "to_env" text NOT NULL,
                "pre_tip_hash" bytea NOT NULL,
                "transition_token_hash" bytea NOT NULL,
                "prev_row_hash" bytea,
                "this_row_hmac" bytea NOT NULL,
                CONSTRAINT "pk_boot_mode_chain_rotations" PRIMARY KEY ("boot_mode_chain_rotation_id"),
                CONSTRAINT "uq_boot_mode_chain_rotations_seq" UNIQUE ("seq"),
                CONSTRAINT "ck_boot_mode_chain_rotations_from_env" CHECK (
                    "from_env" IN ('testnet', 'paper', 'live')
                ),
                CONSTRAINT "ck_boot_mode_chain_rotations_to_env" CHECK (
                    "to_env" IN ('testnet', 'paper', 'live')
                )
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_boot_mode_chain_rotations_seq" ON "boot_mode_chain_rotations" ("seq")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_boot_mode_chain_rotations_seq"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "boot_mode_chain_rotations"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_boot_mode_history_seq"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "boot_mode_history"`);
    }
}
