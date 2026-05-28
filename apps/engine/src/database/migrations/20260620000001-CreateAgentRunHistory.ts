import { MigrationInterface, QueryRunner } from 'typeorm';

// M13 W0 (ADR 0036 §"agent_run_history") — one row per weekly agent run.
//
// The agent_writer role gets a NARROW column-level INSERT grant: every
// column EXCEPT the BIGSERIAL primary key. agent_run_id is server-assigned
// via the sequence (USAGE+SELECT granted below), preventing the agent
// from forging an id or colliding with concurrent runs.
//
// No UPDATE/DELETE for agent_writer on this table. Terminal-state commits
// happen via the engine's full-rights connection. The unique (week_iso)
// constraint guarantees at most one run row per ISO week.
//
// Reversible: down() DROP TABLE cascades grants + sequence.

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

export class CreateAgentRunHistory20260620000001 implements MigrationInterface {
    name = 'CreateAgentRunHistory20260620000001';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "agent_run_history" (
                "agent_run_id"          BIGSERIAL PRIMARY KEY,
                "week_iso"              TEXT NOT NULL UNIQUE,
                "parent_version_id"     INTEGER NOT NULL
                    REFERENCES "strategy_versions"("strategy_versions_id")
                    ON DELETE RESTRICT ON UPDATE CASCADE,
                "draft_version_id"      INTEGER NULL
                    REFERENCES "strategy_versions"("strategy_versions_id")
                    ON DELETE SET NULL ON UPDATE CASCADE,
                "model_id"              TEXT NOT NULL,
                "report_md_path"        TEXT NULL,
                "report_json_path"      TEXT NULL,
                "terminal_state"        TEXT NOT NULL
                    CHECK ("terminal_state" IN ('COMPLETED','SKIPPED_HALTED','IDEMPOTENT_SKIP','FAILED')),
                "failure_reason"        TEXT NULL,
                "started_at"            TIMESTAMPTZ NOT NULL,
                "finished_at"           TIMESTAMPTZ NULL,
                "bootstrap_ci_lo"       NUMERIC NULL,
                "bootstrap_ci_hi"       NUMERIC NULL,
                "passes_promotion_gate" BOOLEAN NULL
            )
        `);

        // mcp_reader: read-only access for the MCP analysis surface.
        await queryRunner.query(`GRANT SELECT ON TABLE "agent_run_history" TO "mcp_reader"`);

        // agent_writer: narrow column-level INSERT — every column except
        // the BIGSERIAL primary key. The id is server-assigned via the
        // sequence (USAGE+SELECT granted below).
        const insertColumnList = AGENT_WRITER_INSERT_COLUMNS.map((c) => `"${c}"`).join(', ');
        await queryRunner.query(`GRANT INSERT (${insertColumnList}) ON TABLE "agent_run_history" TO "agent_writer"`);
        await queryRunner.query(`GRANT SELECT ON TABLE "agent_run_history" TO "agent_writer"`);

        // BIGSERIAL needs the agent role to advance the sequence. USAGE
        // alone is enough for nextval; SELECT lets the role read currval.
        await queryRunner.query(`GRANT USAGE, SELECT ON SEQUENCE "agent_run_history_agent_run_id_seq" TO "agent_writer"`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // DROP TABLE cascades the implicit BIGSERIAL sequence and every
        // grant on the table + sequence.
        await queryRunner.query(`DROP TABLE IF EXISTS "agent_run_history"`);
    }
}
