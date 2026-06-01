import { MigrationInterface, QueryRunner } from 'typeorm';

// M12 W0 — creates the `mcp_reader` Postgres role consumed by the read-only
// MCP server (apps/mcp). Locks down DML and DDL by grant set + role-level
// session settings; per ADR 0034 §2 the role itself enforces the structural
// "no writes from MCP" invariant — application code in @bot/analysis is a
// secondary guarantee.
//
// Role properties (ADR 0034 §2.1):
//   - LOGIN, NOINHERIT, no superuser, no createrole, no createdb.
//   - default_transaction_read_only = on   (writes rejected at txn start).
//   - statement_timeout              = 30s (caps any single query).
//   - lock_timeout                   = 5s  (MCP never blocks the writer).
//   - idle_in_transaction_session_timeout = 60s (no held-open xact abuse).
//
// Password is loaded from the env at engine bootstrap (MCP_DB_PASSWORD) and
// applied via a separate operational step — migrations are committed to git
// and must not embed secrets. The role is created with a sentinel password
// (`SENTINEL_PASSWORD` below) that MUST be ALTERed before MCP can connect.
// `packages/analysis/src/db/DataSourceFactory.ts` refuses to initialise
// while `MCP_DB_PASSWORD` still matches this sentinel — the operator runbook
// at `docs/runbooks/mcp-deployment.md` documents the ALTER ROLE rotation
// step (see also ADR 0034 §2 — role lockdown invariants).
//
// Grants (ADR 0034 §2.5 — read-only analytical surface):
//   candles, tick_aggregates, instruments, universe_membership,
//   funding_rates, open_interest, book_snapshots,
//   strategy_versions, positions, transactions, decisions, risk_state,
//   account_snapshots.
//
// NOT granted (sensitive / audit / paper-mode-secret-adjacent):
//   auth_tokens / revoked_jti, control_audit, login_rate_limit_state,
//   boot_mode_history*, paper_account_state*, paper_state_audit,
//   paper_simulator_idempotency, paper_account_snapshots,
//   paper_account_state_history, paper_account_state_meta,
//   comparison_reports, migrations.
//
// New tables added in future milestones default to NO grant for mcp_reader.
// To opt a new table into MCP visibility, author a follow-up migration that
// GRANTs SELECT explicitly. The grant-policy block in
// `docs/architecture/data-model.md` is the human-facing reminder.
//
// Reversible: down() revokes all grants and DROPs the role. NOTE: mcp_reader
// is a CLUSTER-GLOBAL role. In a multi-DB cluster (CI/test runs trade_bot,
// trade_bot_test and trade_bot_migration_test in one cluster) a single-DB
// revert cannot DROP the role while a sibling DB still grants to it — in that
// case the role is retained (revert tolerates dependent_objects_still_exist)
// rather than aborting the revert chain.

const MCP_READER_TABLES = [
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

const SENTINEL_PASSWORD = 'mcp_reader_change_me_at_deploy';

export class CreateMcpReaderRole20260619000000 implements MigrationInterface {
    name = 'CreateMcpReaderRole20260619000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // Resolve the connected database name dynamically. The engine
        // DataSource is configured via `DATABASE_URL`, which means
        // `connection.options.database` is undefined at runtime — fall back
        // to `current_database()` so the migration runs against whatever DB
        // the connection actually targets (works for local dev + CI alike).
        const dbNameRow = await queryRunner.query(`SELECT current_database() AS name`);
        const databaseName: string = dbNameRow[0].name;

        // Create the role idempotently — DO block tolerates re-run after a
        // partial migration failure during local dev.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
                    CREATE ROLE "mcp_reader"
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

        // Role-level session settings — ADR 0034 §2.1. These apply to every
        // login session of mcp_reader without the client having to set them.
        await queryRunner.query(`ALTER ROLE "mcp_reader" SET default_transaction_read_only = on`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" SET statement_timeout = '30s'`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" SET lock_timeout = '5s'`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" SET idle_in_transaction_session_timeout = '60s'`);

        // Database + schema connect rights.
        await queryRunner.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "mcp_reader"`);
        await queryRunner.query(`GRANT USAGE ON SCHEMA public TO "mcp_reader"`);

        // Table whitelist — SELECT only.
        for (const table of MCP_READER_TABLES) {
            await queryRunner.query(`GRANT SELECT ON TABLE "${table}" TO "mcp_reader"`);
        }

        // Defensive: explicitly REVOKE every other DML/DDL on the whitelisted
        // tables. `default_transaction_read_only` already prevents writes at
        // the transaction layer, but a belt-and-suspenders REVOKE makes the
        // grant set easy to audit with `\dp` in psql.
        for (const table of MCP_READER_TABLES) {
            await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "${table}" FROM "mcp_reader"`);
        }

        // No default privileges for future tables — new tables remain
        // invisible to mcp_reader until a follow-up migration grants SELECT
        // explicitly. This is the safe-by-default policy documented in
        // `docs/architecture/data-model.md`.
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const dbNameRow = await queryRunner.query(`SELECT current_database() AS name`);
        const databaseName: string = dbNameRow[0].name;

        // Drop grants in reverse order. REVOKE is idempotent in PG, so a
        // partial-up state still rolls back cleanly.
        for (const table of MCP_READER_TABLES) {
            await queryRunner.query(`REVOKE ALL ON TABLE "${table}" FROM "mcp_reader"`);
        }

        await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM "mcp_reader"`);
        await queryRunner.query(`REVOKE CONNECT ON DATABASE "${databaseName}" FROM "mcp_reader"`);

        // Reset role-level settings before drop — DROP ROLE fails if the role
        // still owns objects; resetting settings is cosmetic but keeps the
        // revert auditable.
        await queryRunner.query(`ALTER ROLE "mcp_reader" RESET default_transaction_read_only`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" RESET statement_timeout`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" RESET lock_timeout`);
        await queryRunner.query(`ALTER ROLE "mcp_reader" RESET idle_in_transaction_session_timeout`);

        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
                    -- Clears every privilege granted to mcp_reader in the CURRENT database
                    -- (the manual per-table REVOKEs above are a subset of this).
                    DROP OWNED BY "mcp_reader";

                    -- mcp_reader is a CLUSTER-GLOBAL role. In the multi-DB CI/test cluster
                    -- (trade_bot, trade_bot_test, trade_bot_migration_test) a single-DB
                    -- revert cannot drop it while a sibling DB still grants to it. Tolerate
                    -- that so the revert chain never aborts.
                    BEGIN
                        DROP ROLE "mcp_reader";
                    EXCEPTION WHEN dependent_objects_still_exist THEN
                        RAISE NOTICE 'mcp_reader retained: still referenced by another database in the cluster';
                    END;
                END IF;
            END
            $$;
        `);
    }
}
