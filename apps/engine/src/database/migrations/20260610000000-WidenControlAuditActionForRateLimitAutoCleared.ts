import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W1.4 (ADR 0030 §2.6.2).
//
// Widens `control_audit.action` CHECK constraint to allow
// `RATE_LIMIT_HALT_AUTO_CLEARED`, written when the in-engine rate-limit
// policy's freeze window expires without a further 429/418 and the
// programmatic halt that was engaged at the start of the window is released.
//
// Pure constraint swap — no shape change. Reversible: DOWN restores the
// previous (KEY_PERMISSION-widened) constraint set. If any
// RATE_LIMIT_HALT_AUTO_CLEARED rows exist at rollback the DOWN-migration will
// fail (forward-only convention, same as the prior widening migrations).

export class WidenControlAuditActionForRateLimitAutoCleared20260610000000 implements MigrationInterface {
    name = 'WidenControlAuditActionForRateLimitAutoCleared20260610000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED', 'KEY_PERMISSION_ASSERTION_FAILED', 'KEY_PERMISSION_ASSERTION_SKIPPED', 'RATE_LIMIT_HALT_AUTO_CLEARED'))",
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED', 'KEY_PERMISSION_ASSERTION_FAILED', 'KEY_PERMISSION_ASSERTION_SKIPPED'))",
        );
    }
}
