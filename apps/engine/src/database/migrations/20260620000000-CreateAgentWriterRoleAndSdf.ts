import { MigrationInterface, QueryRunner } from 'typeorm';

// M13 W0 — creates the `agent_writer` Postgres role + the
// `draft_strategy_version` SECURITY DEFINER function (SDF). Per ADR 0036,
// the agent's only write path is this SDF, whose body hard-codes
// status='draft'. The role itself has no table-level INSERT/UPDATE/DELETE
// grant on any table; structural least-privilege via grants is the
// primary boundary, the application code in apps/agent is secondary.
//
// Mirrors the ADR 0034 pattern set by `mcp_reader` (see
// `20260619000000-CreateMcpReaderRole.ts`): same role-level session
// settings, same 13-table SELECT whitelist, sentinel password rotated
// out-of-band by the operator at deploy time.
//
// Role properties (ADR 0036 §2.1):
//   - LOGIN, NOINHERIT, no superuser, no createrole, no createdb.
//   - default_transaction_read_only = on   (writes rejected at txn start;
//                                          the SDF flips this off via
//                                          `SET LOCAL` inside its body).
//   - statement_timeout              = 30s.
//   - lock_timeout                   = 5s.
//   - idle_in_transaction_session_timeout = 60s.
//
// SDF properties (ADR 0036 §2.3):
//   - SECURITY DEFINER, owned by the migration role (CURRENT_USER at
//     migration time), so agent_writer cannot ALTER OWNER.
//   - SET search_path = pg_catalog, public — anti search-path-hijack.
//   - status='draft' literal, no parameter.
//   - Validates parent exists AND status='active'.
//   - Idempotent on (parent_version_id, week_iso) — re-fire returns NULL.
//
// Schema additions on `strategy_versions`:
//   - `week_iso  text NULL` (ISO 8601 week, e.g. `2026-W22`).
//   - `rationale text NULL` (operator/agent free text).
//   - Partial UNIQUE INDEX on (parent_version_id, week_iso) WHERE
//     week_iso IS NOT NULL — only agent-drafted rows are constrained;
//     historical hand-authored rows (week_iso IS NULL) remain
//     unconstrained.
//
// Reversible: down() drops EXECUTE, drops the function, drops the index,
// drops the added columns (IF EXISTS — safe if a future migration moved
// them onto the entity), revokes all grants, drops the role.

const AGENT_WRITER_TABLES = [
    'candles',
    'tick_aggregates',
    'instruments',
    'universe_membership',
    'funding_rates',
    'open_interest',
    'book_snapshots',
    'strategy_versions',
    'positions',
    'transactions',
    'decisions',
    'risk_state',
    'account_snapshots',
];

const SENTINEL_PASSWORD = 'CHANGE_ME_BEFORE_PROD';

export class CreateAgentWriterRoleAndSdf20260620000000 implements MigrationInterface {
    name = 'CreateAgentWriterRoleAndSdf20260620000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        const dbNameRow = await queryRunner.query(`SELECT current_database() AS name`);
        const databaseName: string = dbNameRow[0].name;

        // 1. Create the role idempotently.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_writer') THEN
                    CREATE ROLE "agent_writer"
                        WITH LOGIN
                             NOINHERIT
                             NOSUPERUSER
                             NOCREATEDB
                             NOCREATEROLE
                             PASSWORD '${SENTINEL_PASSWORD}';
                END IF;
            END
            $$;
        `);

        // Role-level session settings (ADR 0036 §2.1).
        await queryRunner.query(`ALTER ROLE "agent_writer" SET default_transaction_read_only = on`);
        await queryRunner.query(`ALTER ROLE "agent_writer" SET statement_timeout = '30s'`);
        await queryRunner.query(`ALTER ROLE "agent_writer" SET lock_timeout = '5s'`);
        await queryRunner.query(`ALTER ROLE "agent_writer" SET idle_in_transaction_session_timeout = '60s'`);

        // 2. Database + schema connect rights.
        await queryRunner.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "agent_writer"`);
        await queryRunner.query(`GRANT USAGE ON SCHEMA public TO "agent_writer"`);

        // 3. SELECT-only grant set — identical 13-table whitelist as
        //    `mcp_reader` (ADR 0036 §2.2).
        for (const table of AGENT_WRITER_TABLES) {
            await queryRunner.query(`GRANT SELECT ON TABLE "${table}" TO "agent_writer"`);
        }

        // Defensive belt-and-suspenders REVOKE — no DML/DDL grant exists
        // by default; the explicit REVOKE makes `\dp` auditing obvious.
        for (const table of AGENT_WRITER_TABLES) {
            await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "${table}" FROM "agent_writer"`);
        }

        // 4. Add nullable `week_iso` + `rationale` columns to
        //    strategy_versions if absent (ADR 0036 §2.4).
        const hasWeekIso = await queryRunner.hasColumn('strategy_versions', 'week_iso');
        if (! hasWeekIso) {
            await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "week_iso" text NULL`);
        }

        const hasRationale = await queryRunner.hasColumn('strategy_versions', 'rationale');
        if (! hasRationale) {
            await queryRunner.query(`ALTER TABLE "strategy_versions" ADD COLUMN "rationale" text NULL`);
        }

        // 5. Partial UNIQUE index for agent-drafted rows only.
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uniq_strategy_versions_parent_week"
                ON "strategy_versions" ("parent_version_id", "week_iso")
                WHERE "week_iso" IS NOT NULL
        `);

        // 6. The SDF. status='draft' is a hard-coded literal inside the
        //    INSERT — there is no parameter, variable, or concatenation
        //    path that can shape it. The parent must be active.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION draft_strategy_version(
                p_parent_version_id integer,
                p_params            jsonb,
                p_rationale         text,
                p_week_iso          text
            ) RETURNS integer
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $fn$
            DECLARE
                v_parent_name    text;
                v_parent_status  text;
                v_new_version    integer;
                v_inserted_id    integer;
            BEGIN
                SET LOCAL transaction_read_only = off;

                SELECT name, status INTO v_parent_name, v_parent_status
                FROM strategy_versions
                WHERE strategy_versions_id = p_parent_version_id;

                IF v_parent_name IS NULL THEN
                    RAISE EXCEPTION 'parent_version_id % not found', p_parent_version_id
                        USING ERRCODE = '23503';
                END IF;

                IF v_parent_status <> 'active' THEN
                    RAISE EXCEPTION 'parent_version_id % is not active (status=%)',
                        p_parent_version_id, v_parent_status
                        USING ERRCODE = '22023';
                END IF;

                SELECT COALESCE(MAX(version), 0) + 1 INTO v_new_version
                FROM strategy_versions
                WHERE name = v_parent_name;

                INSERT INTO strategy_versions
                    (name, version, direction, parent_version_id, params, rationale,
                     week_iso, status, created_at)
                SELECT
                    v_parent_name,
                    v_new_version,
                    sv.direction,
                    p_parent_version_id,
                    p_params,
                    p_rationale,
                    p_week_iso,
                    'draft',
                    now()
                FROM strategy_versions sv
                WHERE sv.strategy_versions_id = p_parent_version_id
                ON CONFLICT ("parent_version_id", "week_iso")
                    WHERE "week_iso" IS NOT NULL
                    DO NOTHING
                RETURNING strategy_versions_id INTO v_inserted_id;

                RETURN v_inserted_id;
            END;
            $fn$;
        `);

        // 7. Pin ownership to the migration role explicitly (CURRENT_USER
        //    at migration time). agent_writer is never the owner and
        //    cannot ALTER FUNCTION ... OWNER TO.
        await queryRunner.query(`ALTER FUNCTION draft_strategy_version(integer, jsonb, text, text) OWNER TO CURRENT_USER`);

        // 8. Revoke PUBLIC's default EXECUTE on new functions.
        await queryRunner.query(`REVOKE EXECUTE ON FUNCTION draft_strategy_version(integer, jsonb, text, text) FROM PUBLIC`);

        // 9. Grant EXECUTE to agent_writer — the sole write capability.
        await queryRunner.query(`GRANT EXECUTE ON FUNCTION draft_strategy_version(integer, jsonb, text, text) TO "agent_writer"`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const dbNameRow = await queryRunner.query(`SELECT current_database() AS name`);
        const databaseName: string = dbNameRow[0].name;

        // Drop SDF EXECUTE grant + function.
        await queryRunner.query(`REVOKE EXECUTE ON FUNCTION draft_strategy_version(integer, jsonb, text, text) FROM "agent_writer"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS draft_strategy_version(integer, jsonb, text, text)`);

        // Drop partial UNIQUE index.
        await queryRunner.query(`DROP INDEX IF EXISTS "uniq_strategy_versions_parent_week"`);

        // Drop the columns added by up(). IF EXISTS keeps the down()
        // safe even if a future migration moves these columns onto the
        // entity (in which case the entity-owning migration handles the
        // schema and this DROP is a no-op).
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "rationale"`);
        await queryRunner.query(`ALTER TABLE "strategy_versions" DROP COLUMN IF EXISTS "week_iso"`);

        // Revoke table grants.
        for (const table of AGENT_WRITER_TABLES) {
            await queryRunner.query(`REVOKE ALL ON TABLE "${table}" FROM "agent_writer"`);
        }

        await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM "agent_writer"`);
        await queryRunner.query(`REVOKE CONNECT ON DATABASE "${databaseName}" FROM "agent_writer"`);

        // Reset role-level settings before drop (cosmetic, auditable revert).
        await queryRunner.query(`ALTER ROLE "agent_writer" RESET default_transaction_read_only`);
        await queryRunner.query(`ALTER ROLE "agent_writer" RESET statement_timeout`);
        await queryRunner.query(`ALTER ROLE "agent_writer" RESET lock_timeout`);
        await queryRunner.query(`ALTER ROLE "agent_writer" RESET idle_in_transaction_session_timeout`);

        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_writer') THEN
                    DROP ROLE "agent_writer";
                END IF;
            END
            $$;
        `);
    }
}
