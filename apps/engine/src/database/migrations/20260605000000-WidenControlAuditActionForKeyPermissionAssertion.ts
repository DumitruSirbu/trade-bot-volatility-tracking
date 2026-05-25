import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W1.2 (ADR 0028 §2.5).
//
// Widens `control_audit.action` CHECK constraint to allow the two new
// key-permission-assertion audit actions written by the boot-time allowlist
// gate (`KEY_PERMISSION_ASSERTION_FAILED`, `KEY_PERMISSION_ASSERTION_SKIPPED`).
// ADR 0028 §2.5 prescribes a row per assertion outcome (including the TESTNET
// exemption) so a forensic reader can answer "did the bot ever boot without
// this check."
//
// Pure constraint swap — no shape change. Reversible: DOWN restores the
// LOGIN-widened constraint set. If any KEY_PERMISSION_* rows exist at the
// time of a rollback the DOWN-migration will fail (the CHECK cannot
// retroactively allow them); same forward-only convention as the M10 W0.5
// LOGIN widening.

export class WidenControlAuditActionForKeyPermissionAssertion20260605000000 implements MigrationInterface {
    name = 'WidenControlAuditActionForKeyPermissionAssertion20260605000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED', 'KEY_PERMISSION_ASSERTION_FAILED', 'KEY_PERMISSION_ASSERTION_SKIPPED'))",
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED'))",
        );
    }
}
