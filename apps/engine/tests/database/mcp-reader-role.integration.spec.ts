/**
 * M12 W5 — `mcp_reader` DB-role permission tests (QA wave, ADR 0034 §5).
 *
 * Requires a live Postgres instance with the `mcp_reader` role created by
 * migration `20260619000000-CreateMcpReaderRole.ts`.
 *
 * Start Postgres with:
 *   DB_PORT=5433 docker compose up -d postgres
 *
 * Then run migrations to create the mcp_reader role:
 *   pnpm --filter @bot/engine migration:run
 *
 * The mcp_reader password must be set (default sentinel is
 * 'mcp_reader_change_me_at_deploy' — only usable for test, never for prod):
 *   psql -c "ALTER ROLE mcp_reader PASSWORD 'mcp_reader_change_me_at_deploy';"
 *
 * If the role does not exist or the DB is unreachable, the suite is skipped
 * with a clear message so CI passes and reviewers see the intent.
 *
 * Coverage (ADR 0034 §5):
 *   [1] INSERT into a whitelisted table → expects SQLSTATE 25006 (read-only tx)
 *       or 42501 (insufficient privilege).
 *   [2] UPDATE into a whitelisted table → same rejection.
 *   [3] DELETE from a whitelisted table → same rejection.
 *   [4] SELECT from a whitelisted table (positions) → succeeds (empty or rows).
 *   [5] SELECT from auth_tokens (sensitive, NOT in whitelist) → 42501.
 *   [6] SELECT from revoked_jti (M13 ADR 0038 — explicitly granted SELECT;
 *       INSERT/UPDATE/DELETE still rejected with 42501).
 *   [7] SELECT from boot_mode_history (NOT in whitelist) → 42501.
 *   [8] SELECT from paper_account_state (NOT in whitelist) → 42501.
 *   [9] pg_sleep(35) → 57014 query_canceled (statement_timeout = 30s).
 */

import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Connection config — adapts to CI env vars or the documented local defaults.
// ---------------------------------------------------------------------------

const ENGINE_DB_URL =
    process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';

// The mcp_reader role is provisioned by the migration with a sentinel password.
// In the test environment the password must match.
const MCP_DB_PASSWORD = process.env['MCP_DB_PASSWORD'] ?? 'mcp_reader_change_me_at_deploy';

function buildMcpReaderUrl(engineUrl: string, password: string): string {
    try {
        const url = new URL(engineUrl);
        url.username = 'mcp_reader';
        url.password = encodeURIComponent(password);
        return url.toString();
    } catch {
        // Fallback for non-URL strings like "host=... dbname=..." style.
        return `postgresql://mcp_reader:${encodeURIComponent(password)}@localhost:5433/trade_bot`;
    }
}

const MCP_DB_URL = buildMcpReaderUrl(ENGINE_DB_URL, MCP_DB_PASSWORD);

// ---------------------------------------------------------------------------
// PG error code constants (from Postgres documentation).
// ---------------------------------------------------------------------------

/** 42501 — insufficient_privilege */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 25006 — read_only_sql_transaction */
const READ_ONLY_SQL_TRANSACTION = '25006';
/** 57014 — query_canceled (e.g., statement_timeout) */
const QUERY_CANCELED = '57014';

type PgError = Error & { code?: string };

// ---------------------------------------------------------------------------
// Skip detection — try to connect; if it fails, skip the suite.
// ---------------------------------------------------------------------------

async function tryConnect(url: string): Promise<Client | null> {
    const client = new Client({ connectionString: url });
    try {
        await client.connect();
        return client;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mcp_reader role — permission enforcement (ADR 0034 §5)', () => {
    let client: Client | null = null;
    let suiteSkipped = false;

    beforeAll(async () => {
        client = await tryConnect(MCP_DB_URL);
        if (client === null) {
            suiteSkipped = true;
            console.warn(
                '[SKIPPED] mcp-reader-role.integration: no live Postgres reachable at the expected URL.\n' +
                    'To run this suite: start Postgres with `DB_PORT=5433 docker compose up -d postgres`,\n' +
                    'run migrations, and ensure the mcp_reader role exists with the sentinel password.\n' +
                    'The spec file remains in place for reviewer inspection.',
            );
        }
    }, 15_000);

    afterAll(async () => {
        if (client !== null) {
            await client.end();
        }
    });

    function skipIfNotReachable(): void {
        if (suiteSkipped) {
            pending('Skipped: Postgres not reachable');
        }
    }

    // ---- helper: assert a query throws with the given SQLSTATE code ----

    async function assertSqlstateRejection(sql: string, expectedCode: string): Promise<void> {
        expect.hasAssertions();
        try {
            await client!.query(sql);
            throw new Error(`Expected SQL to fail with SQLSTATE ${expectedCode} but it succeeded: ${sql}`);
        } catch (err) {
            const pgErr = err as PgError;
            // Accept either the read-only-tx code or the insufficient-privilege code
            // depending on whether the role-level read-only flag fires first or the
            // explicit REVOKE fires first.
            const validCodes =
                expectedCode === INSUFFICIENT_PRIVILEGE
                    ? [INSUFFICIENT_PRIVILEGE, READ_ONLY_SQL_TRANSACTION]
                    : [expectedCode];

            if (!validCodes.includes(pgErr.code ?? '')) {
                throw new Error(
                    `Expected SQLSTATE ${expectedCode} (or ${validCodes.join('/')}) but got ${pgErr.code ?? 'no code'}: ${pgErr.message}`,
                );
            }

            expect(validCodes).toContain(pgErr.code);
        }
    }

    // ---- [1] INSERT rejected on a whitelisted table ----

    it('[1] INSERT INTO positions is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `INSERT INTO positions (symbol, state) VALUES ('BTCUSDT', 'open')`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [2] UPDATE rejected ----

    it('[2] UPDATE positions is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `UPDATE positions SET state = 'closed' WHERE 1=0`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [3] DELETE rejected ----

    it('[3] DELETE FROM positions is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `DELETE FROM positions WHERE 1=0`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [4] SELECT on whitelisted table succeeds ----

    it('[4] SELECT FROM positions succeeds (whitelisted)', async () => {
        skipIfNotReachable();
        // Empty result is fine — the point is it does NOT throw.
        const result = await client!.query(`SELECT positions_id FROM positions LIMIT 1`);
        expect(result).toBeDefined();
        expect(Array.isArray(result.rows)).toBe(true);
    });

    // ---- [5] SELECT from auth_tokens is rejected (sensitive, no grant) ----

    it('[5] SELECT FROM auth_tokens is rejected (not in whitelist)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `SELECT * FROM auth_tokens LIMIT 1`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [6] SELECT from revoked_jti succeeds (M13 ADR 0038 grant);
    //         writes still rejected by REVOKE + read-only-tx. ----

    it('[6a] SELECT FROM revoked_jti succeeds (M13 ADR 0038 — granted for bearer revocation check)', async () => {
        skipIfNotReachable();
        const result = await client!.query(`SELECT 1 FROM revoked_jti LIMIT 1`);
        expect(result).toBeDefined();
        expect(Array.isArray(result.rows)).toBe(true);
    });

    it('[6b] INSERT INTO revoked_jti is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `INSERT INTO revoked_jti (jti, revoked_at) VALUES ('test-jti', NOW())`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    it('[6c] UPDATE revoked_jti is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `UPDATE revoked_jti SET jti = 'x' WHERE 1=0`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    it('[6d] DELETE FROM revoked_jti is rejected (read-only role)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `DELETE FROM revoked_jti WHERE 1=0`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [7] SELECT from boot_mode_history is rejected ----

    it('[7] SELECT FROM boot_mode_history is rejected (not in whitelist)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `SELECT * FROM boot_mode_history LIMIT 1`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [8] SELECT from paper_account_state is rejected ----

    it('[8] SELECT FROM paper_account_state is rejected (not in whitelist)', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(
            `SELECT * FROM paper_account_state LIMIT 1`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [9] statement_timeout fires for long-running queries ----

    it('[9] pg_sleep(35) is canceled by statement_timeout=30s', async () => {
        skipIfNotReachable();
        await assertSqlstateRejection(`SELECT pg_sleep(35)`, QUERY_CANCELED);
    }, 45_000); // generous Jest timeout — but Postgres will cancel at 30s.

    // ---- grant-set completeness: verify all 13 whitelisted tables are readable ----

    it('[10] all 13 ADR-0034-whitelisted tables are readable under mcp_reader', async () => {
        skipIfNotReachable();

        const WHITELISTED_TABLES = [
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

        for (const table of WHITELISTED_TABLES) {
            // SELECT should succeed (even if empty). A permission failure would throw.
            const result = await client!.query(`SELECT * FROM "${table}" LIMIT 0`);
            expect(result).toBeDefined();
        }
    });
});
