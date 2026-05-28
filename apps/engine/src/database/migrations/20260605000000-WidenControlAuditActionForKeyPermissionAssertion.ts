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
// Pure constraint swap — no shape change. Reversible: DOWN deletes any
// KEY_PERMISSION_* rows before restoring the narrowed constraint — rolling back
// this migration means the schema no longer recognises those action types, so
// their audit rows are invalid and must be purged.

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
        await queryRunner.query(
            `DELETE FROM "control_audit" WHERE "action" IN ('KEY_PERMISSION_ASSERTION_FAILED', 'KEY_PERMISSION_ASSERTION_SKIPPED')`,
        );
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED'))",
        );
    }
}
