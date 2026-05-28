import { MigrationInterface, QueryRunner } from 'typeorm';

// M13 W6 fix wave 2 (#1) — The `agent_writer` role is created with
// `default_transaction_read_only = on` (see
// 20260620000000-CreateAgentWriterRoleAndSdf.ts). The `draft_strategy_version`
// SDF works around this because `SECURITY DEFINER` functions run as their
// OWNER (the migration role, where the default does not apply) and the SDF
// flips the flag off via `SET LOCAL transaction_read_only = off` inside its
// body. A direct `INSERT … RETURNING` issued by the agent against
// `agent_run_history` would be rejected by Postgres with SQLSTATE 25006
// (`read_only_sql_transaction`).
//
// Fix: route the history INSERT through a second SECURITY DEFINER function
// (`record_agent_run_history`) that mirrors the SDF pattern from migration
// 0. The function is the SOLE write path; the column-level INSERT grant
// previously held by `agent_writer` on `agent_run_history` is revoked here
// (defense in depth — agent_writer can no longer reach the table directly),
// along with the sequence USAGE/SELECT grants (no longer needed because the
// SDF runs as OWNER).
//
// Reversible: down() restores the original column-level grants, drops the
// SDF, and revokes EXECUTE.

const AGENT_WRITER_INSERT_COLUMNS = [
    'week_iso',
    'parent_version_id',
    'draft_version_id',
    'model_id',
    'report_md_path',
    'report_json_path',
    'terminal_state',
    'failure_reason',
    'started_at',
    'finished_at',
    'bootstrap_ci_lo',
    'bootstrap_ci_hi',
    'passes_promotion_gate',
];

const FN_SIG = 'record_agent_run_history(text, integer, integer, text, text, text, text, text, timestamptz, timestamptz, numeric, numeric, boolean)';

export class CreateRecordAgentRunHistorySdf20260620000002 implements MigrationInterface {
    name = 'CreateRecordAgentRunHistorySdf20260620000002';

    async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Create the SDF. Body is a single INSERT … RETURNING with the
        //    same idempotency contract as the raw statement it replaces.
        //    `SET LOCAL transaction_read_only = off` flips the role-default
        //    inside the function's own transaction, mirroring the
        //    `draft_strategy_version` pattern.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION record_agent_run_history(
                p_week_iso              text,
                p_parent_version_id     integer,
                p_draft_version_id      integer,
                p_model_id              text,
                p_report_md_path        text,
                p_report_json_path      text,
                p_terminal_state        text,
                p_failure_reason        text,
                p_started_at            timestamptz,
                p_finished_at           timestamptz,
                p_bootstrap_ci_lo       numeric,
                p_bootstrap_ci_hi       numeric,
                p_passes_promotion_gate boolean
            ) RETURNS bigint
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $fn$
            DECLARE
                v_inserted_id bigint;
            BEGIN
                SET LOCAL transaction_read_only = off;

                INSERT INTO agent_run_history (
                    week_iso,
                    parent_version_id,
                    draft_version_id,
                    model_id,
                    report_md_path,
                    report_json_path,
                    terminal_state,
                    failure_reason,
                    started_at,
                    finished_at,
                    bootstrap_ci_lo,
                    bootstrap_ci_hi,
                    passes_promotion_gate
                ) VALUES (
                    p_week_iso,
                    p_parent_version_id,
                    p_draft_version_id,
                    p_model_id,
                    p_report_md_path,
                    p_report_json_path,
                    p_terminal_state,
                    p_failure_reason,
                    p_started_at,
                    p_finished_at,
                    p_bootstrap_ci_lo,
                    p_bootstrap_ci_hi,
                    p_passes_promotion_gate
                )
                ON CONFLICT (week_iso) DO NOTHING
                RETURNING agent_run_id INTO v_inserted_id;

                RETURN v_inserted_id;
            END;
            $fn$;
        `);

        // 2. Pin ownership to the migration role (mirrors migration 0).
        await queryRunner.query(`ALTER FUNCTION ${FN_SIG} OWNER TO CURRENT_USER`);

        // 3. Revoke PUBLIC's default EXECUTE.
        await queryRunner.query(`REVOKE EXECUTE ON FUNCTION ${FN_SIG} FROM PUBLIC`);

        // 4. Grant EXECUTE to agent_writer — sole history-write capability.
        await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${FN_SIG} TO "agent_writer"`);

        // 5. Defense-in-depth: revoke the column-level INSERT grant +
        //    sequence USAGE/SELECT now that the SDF is the only write path.
        const columnList = AGENT_WRITER_INSERT_COLUMNS.map((c) => `"${c}"`).join(', ');
        await queryRunner.query(`REVOKE INSERT (${columnList}) ON TABLE "agent_run_history" FROM "agent_writer"`);
        await queryRunner.query(`REVOKE USAGE, SELECT ON SEQUENCE "agent_run_history_agent_run_id_seq" FROM "agent_writer"`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // 1. Restore the original column-level grants from migration 1 so
        //    the schema state matches a pre-fix-wave-2 environment.
        const columnList = AGENT_WRITER_INSERT_COLUMNS.map((c) => `"${c}"`).join(', ');
        await queryRunner.query(`GRANT INSERT (${columnList}) ON TABLE "agent_run_history" TO "agent_writer"`);
        await queryRunner.query(`GRANT USAGE, SELECT ON SEQUENCE "agent_run_history_agent_run_id_seq" TO "agent_writer"`);

        // 2. Revoke EXECUTE + drop the SDF.
        await queryRunner.query(`REVOKE EXECUTE ON FUNCTION ${FN_SIG} FROM "agent_writer"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS ${FN_SIG}`);
    }
}
