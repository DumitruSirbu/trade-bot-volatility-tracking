import { MigrationInterface, QueryRunner } from 'typeorm';

// M9 W2 (ADR 0020 §2.2).
//
// Creates the `revoked_jti` table — the auth guard's revocation list. A leaked
// bearer must be killable in seconds, not minutes, so even with the 15-minute
// TTL on tokens we keep an explicit revocation set. The guard checks every
// request + every WS emit against this table (indexed on the PK).
//
// Columns:
//   - jti          uuid PK    — `jti` claim from the revoked JWT
//   - revoked_at   timestamptz NOT NULL DEFAULT now() — when revocation landed
//   - reason       text NULL  — operator-supplied free text (forensic only)
//   - revoked_by   text NOT NULL — IAuthSubject.sub OR 'SYSTEM:<source>'; required
//                                  so post-incident audit can attribute every entry
//
// Indexes:
//   - idx_revoked_jti_revoked_at  — supports the future TTL prune sweep
//     (rows older than the max token TTL can be deleted safely; deferred to M11).
//
// Reversible: down() drops the index then the table.

export class CreateRevokedJti20260528010000 implements MigrationInterface {
    name = 'CreateRevokedJti20260528010000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        await queryRunner.query(`
            CREATE TABLE "revoked_jti" (
                "jti" uuid NOT NULL,
                "revoked_at" timestamptz NOT NULL DEFAULT now(),
                "reason" text,
                "revoked_by" text NOT NULL,
                CONSTRAINT "pk_revoked_jti" PRIMARY KEY ("jti")
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_revoked_jti_revoked_at" ON "revoked_jti" ("revoked_at")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_revoked_jti_revoked_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "revoked_jti"`);
    }
}
