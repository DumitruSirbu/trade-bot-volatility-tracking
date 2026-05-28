import { MigrationInterface, QueryRunner } from 'typeorm';

// M10 W0.5 (ADR 0027 §2.5).
//
// Widens the `control_audit.action` CHECK constraint to allow the new login
// audit values (`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGIN_THROTTLED`) so the
// login endpoint can write to the existing append-only table without a
// separate destination.
//
// ADR 0027 §2.5 noted this widening should be free ("text column"); the
// existing schema in fact carries a strict CHECK constraint, so this small
// migration is required. Pure constraint swap — no table / index / column
// shape changes — DOWN reverts to the original {'HALT','RESUME'} set.
//
// Reversible: DOWN deletes any LOGIN_* rows before restoring the narrowed
// constraint — rolling back means the schema no longer recognises those action
// types, so their audit rows are invalid and must be purged.

export class WidenControlAuditActionForLogin20260601000000 implements MigrationInterface {
    name = 'WidenControlAuditActionForLogin20260601000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query(
            'ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' +
                "CHECK (\"action\" IN ('HALT', 'RESUME', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED'))",
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "control_audit" WHERE "action" IN ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGIN_THROTTLED')`);
        await queryRunner.query('ALTER TABLE "control_audit" DROP CONSTRAINT "ck_control_audit_action"');
        await queryRunner.query('ALTER TABLE "control_audit" ADD CONSTRAINT "ck_control_audit_action" ' + "CHECK (\"action\" IN ('HALT', 'RESUME'))");
    }
}
