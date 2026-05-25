import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W1.9. Persists the per-source-IP login attempt timestamps so a process
// restart does not re-open the brute-force window. Single row per
// (source_ip, scope) where `scope` is one of 'burst' | 'sustained' | 'global'
// — matches the layered windows enforced by LoginRateLimiter (ADR 0027 §2.4).
//
// Storage shape: append-only timestamps in a `jsonb` array column on each
// row. The limiter still does in-memory O(1) checks per request; the row is
// rewritten on each enforce() (write-through). Postgres only reads the row
// at boot to rebuild the in-memory state.
//
// Reversible: down() drops the table.

export class CreateLoginRateLimitState20260601020000 implements MigrationInterface {
    name = 'CreateLoginRateLimitState20260601020000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "login_rate_limit_state" (
                "source_ip" text NOT NULL,
                "scope" text NOT NULL,
                "timestamps_ms" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_login_rate_limit_state" PRIMARY KEY ("source_ip", "scope"),
                CONSTRAINT "ck_login_rate_limit_state_scope" CHECK ("scope" IN ('burst','sustained','global'))
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_login_rate_limit_state_updated_at" ON "login_rate_limit_state" ("updated_at")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_login_rate_limit_state_updated_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "login_rate_limit_state"`);
    }
}
