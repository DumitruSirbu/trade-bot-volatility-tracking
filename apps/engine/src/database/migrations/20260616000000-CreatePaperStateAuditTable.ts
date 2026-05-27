import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a R2b wave B — creates the `paper_state_audit` table (ADR 0032 §D6
// HMAC-chained audit + §D16 atomic three-table-write partner of
// `paper_account_state` + `paper_account_state_history`).
//
// Every mutation to `paper_account_state`, `paper_account_state_history`,
// `paper_account_state_meta`, or `paper_account_snapshots` writes one audit
// row IN THE SAME TRANSACTION (D16 atomicity guarantee). The audit row
// carries a SHA-256 `payload_hash` of the canonical mutation payload (small
// row, forensically reproducible) plus the HMAC chain link
// (`prev_row_hash` + `this_row_hmac`). Per-purpose HKDF subkey via
// `paper_state_audit v1` info string keeps a compromise of the
// boot_mode_history sub-key (or vice versa) from cross-contaminating this
// chain (D6 HMAC-subkey-derivation clause).
//
// Columns mirror the boot_mode_history shape so a reviewer reads one schema
// vocabulary across both chains:
//   - id              uuid PK
//   - seq             BIGSERIAL UNIQUE — monotonic ordering, bound into the
//                                        signed payload (defeats clock-skew
//                                        row-insertion attacks per D6)
//   - recorded_at     timestamptz NOT NULL DEFAULT now()
//   - mutation_kind   text NOT NULL — see CHECK; enum drives the value set
//   - subject_kind    text NOT NULL — see CHECK; the audited table's name
//   - subject_id      uuid NOT NULL — the audited row's PK
//   - payload_hash    bytea NOT NULL — SHA-256 of canonical mutation payload
//   - prev_row_hash   bytea NULL    — HMAC of the prior audit row (null on
//                                     genesis)
//   - this_row_hmac   bytea NOT NULL — HMAC of this row's signed payload
//
// Defence-in-depth checks (mirrors HardenBootModeHistorySchema):
//   - `ck_paper_state_audit_this_row_hmac_nonzero` rejects the all-zero
//     placeholder HMAC the two-phase appender writes before the UPDATE phase.
//   - `ck_paper_state_audit_this_row_hmac_len_32` enforces exactly 32 bytes
//     (HMAC-SHA256 output width).
//
// Reversible: down() drops the index, then the table. pgcrypto is provisioned
// by earlier migrations and is NOT dropped here.

export class CreatePaperStateAuditTable20260616000000 implements MigrationInterface {
    name = 'CreatePaperStateAuditTable20260616000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        await queryRunner.query(`
            CREATE TABLE "paper_state_audit" (
                "paper_state_audit_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "seq" BIGSERIAL NOT NULL,
                "recorded_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "mutation_kind" text NOT NULL,
                "subject_kind" text NOT NULL,
                "subject_id" uuid NOT NULL,
                "payload_hash" bytea NOT NULL,
                "prev_row_hash" bytea,
                "this_row_hmac" bytea NOT NULL,
                CONSTRAINT "pk_paper_state_audit" PRIMARY KEY ("paper_state_audit_id"),
                CONSTRAINT "uq_paper_state_audit_seq" UNIQUE ("seq"),
                CONSTRAINT "ck_paper_state_audit_mutation_kind" CHECK (
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
                ),
                CONSTRAINT "ck_paper_state_audit_subject_kind" CHECK (
                    "subject_kind" IN (
                        'paper_account_state',
                        'paper_account_state_history',
                        'paper_account_state_meta',
                        'paper_account_snapshots'
                    )
                ),
                CONSTRAINT "ck_paper_state_audit_this_row_hmac_nonzero"
                    CHECK ("this_row_hmac" <> decode(repeat('00', 32), 'hex')),
                CONSTRAINT "ck_paper_state_audit_this_row_hmac_len_32"
                    CHECK (octet_length("this_row_hmac") = 32),
                CONSTRAINT "ck_paper_state_audit_payload_hash_len_32"
                    CHECK (octet_length("payload_hash") = 32)
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_paper_state_audit_seq" ON "paper_state_audit" ("seq")`);
        await queryRunner.query(`CREATE INDEX "idx_paper_state_audit_subject" ON "paper_state_audit" ("subject_kind", "subject_id")`);
        await queryRunner.query(`CREATE INDEX "idx_paper_state_audit_recorded_at" ON "paper_state_audit" ("recorded_at")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_state_audit_recorded_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_state_audit_subject"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_state_audit_seq"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paper_state_audit"`);
    }
}
