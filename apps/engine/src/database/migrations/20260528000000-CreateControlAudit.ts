import { MigrationInterface, QueryRunner } from 'typeorm';

// M9 W1 (ADR 0021 §2.3 + ADR 0025 manifest).
//
// Creates the `control_audit` table — the single source of truth for every
// halt-state transition (operator-driven or programmatic-from-M4). One row
// per accepted toggle; append-only from the engine's perspective.
//
// Columns per ADR 0021 §2.3:
//   - control_audit_id      uuid PK (server-minted)
//   - occurred_at           timestamptz NOT NULL — event-time from injected clock
//   - actor_sub             text NOT NULL — IAuthSubject.sub; 'SYSTEM:<source>' for programmatic
//   - actor_jti             text NOT NULL — bearer-token jti for forensic correlation
//   - source_ip             inet NULL    — proxied request IP; null for loopback / programmatic
//   - action                text NOT NULL — 'HALT' | 'RESUME'
//   - reason                text NOT NULL — operator-supplied, server-truncated at 256 chars
//   - flatten_requested     boolean NOT NULL DEFAULT false — only meaningful on HALT
//   - previous_state        text NOT NULL — 'RUNNING' | 'HALTED'
//   - new_state             text NOT NULL — 'RUNNING' | 'HALTED'
//   - correlation_event_id  text NULL    — populated when programmatic; null for operator
//
// Indexes:
//   - idx_control_audit_occurred_at      (occurred_at DESC) — boot-time "last row" lookup
//   - idx_control_audit_actor_occurred   (actor_sub, occurred_at DESC) — per-operator history
//
// Reversible: down() drops indexes (reverse creation order) then the table.

export class CreateControlAudit20260528000000 implements MigrationInterface {
    name = 'CreateControlAudit20260528000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // pgcrypto provides `gen_random_uuid()`. Created idempotently — other
        // tables may already depend on it in future migrations.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        await queryRunner.query(`
            CREATE TABLE "control_audit" (
                "control_audit_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "occurred_at" timestamptz NOT NULL,
                "actor_sub" text NOT NULL,
                "actor_jti" text NOT NULL,
                "source_ip" inet,
                "action" text NOT NULL,
                "reason" text NOT NULL,
                "flatten_requested" boolean NOT NULL DEFAULT false,
                "previous_state" text NOT NULL,
                "new_state" text NOT NULL,
                "correlation_event_id" text,
                CONSTRAINT "pk_control_audit" PRIMARY KEY ("control_audit_id"),
                CONSTRAINT "ck_control_audit_action" CHECK ("action" IN ('HALT', 'RESUME')),
                CONSTRAINT "ck_control_audit_previous_state" CHECK ("previous_state" IN ('RUNNING', 'HALTED')),
                CONSTRAINT "ck_control_audit_new_state" CHECK ("new_state" IN ('RUNNING', 'HALTED'))
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_control_audit_occurred_at" ON "control_audit" ("occurred_at" DESC)`);
        await queryRunner.query(`CREATE INDEX "idx_control_audit_actor_occurred" ON "control_audit" ("actor_sub", "occurred_at" DESC)`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse exact order of up(): drop indexes, then the table (which
        // removes its CHECK / PK constraints inline). The pgcrypto extension
        // is intentionally NOT dropped — other migrations may rely on it and
        // a CREATE-IF-NOT-EXISTS is cheap to re-apply.
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_control_audit_actor_occurred"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_control_audit_occurred_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "control_audit"`);
    }
}
