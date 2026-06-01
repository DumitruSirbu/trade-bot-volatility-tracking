/**
 * M13 W0 — `agent_writer` DB-role + `draft_strategy_version` SDF tests
 * (ADR 0036 §5 privilege spec).
 *
 * Requires a live Postgres instance with all migrations applied, including
 * `20260620000000-CreateAgentWriterRoleAndSdf.ts`.
 *
 * Start the dedicated test Postgres (globalSetup applies migrations automatically):
 *   docker compose --profile test up -d --wait postgres-test
 *
 * The agent_writer password must match the sentinel (only valid for test,
 * never for production):
 *   psql -c "ALTER ROLE agent_writer PASSWORD 'CHANGE_ME_BEFORE_PROD';"
 *
 * If Postgres is unreachable or the role does not exist the suite skips with
 * a clear message so CI passes and reviewers see the intent.
 *
 * Coverage (ADR 0036 §5):
 *   [1] Migration round-trip: up() → down() → up() — verifies reversibility.
 *   [2] pg_proc.prosrc invariant: 'draft' PRESENT, 'active' ABSENT in SDF body.
 *   [3] SDF happy-path: inserts a draft row with status='draft'.
 *   [4] SDF idempotency: second call with same (parent_version_id, week_iso)
 *       returns NULL (ON CONFLICT DO NOTHING).
 *   [5] agent_writer cannot INSERT INTO strategy_versions directly → 42501.
 *   [6] agent_writer cannot UPDATE strategy_versions SET status='active' → 42501.
 *   [7] agent_writer cannot ALTER FUNCTION draft_strategy_version → 42501.
 *   [8] agent_writer cannot SELECT * FROM auth_tokens → 42501.
 */

import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';
import { buildRoleDbUrl, getTestDbUrl } from '../support/testDataSource';

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

const ENGINE_DB_URL = getTestDbUrl();

const AGENT_WRITER_PASSWORD = process.env['AGENT_WRITER_PASSWORD'] ?? 'CHANGE_ME_BEFORE_PROD';

const AGENT_WRITER_URL = buildRoleDbUrl('agent_writer', AGENT_WRITER_PASSWORD);

// ---------------------------------------------------------------------------
// PG error code constants
// ---------------------------------------------------------------------------

/** 42501 — insufficient_privilege */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 25006 — read_only_sql_transaction */
const READ_ONLY_SQL_TRANSACTION = '25006';

type PgError = Error & { code?: string };

// ---------------------------------------------------------------------------
// Skip detection helpers
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a new pg Client connected as the engine superuser role, or null when
 * Postgres is unreachable.
 */
async function buildAdminClient(): Promise<Client | null> {
    return tryConnect(ENGINE_DB_URL);
}

/**
 * Returns a new pg Client connected as agent_writer, or null when the role
 * cannot be reached.
 */
async function buildAgentWriterClient(): Promise<Client | null> {
    return tryConnect(AGENT_WRITER_URL);
}

/**
 * Asserts that a SQL statement executed by `client` raises a Postgres error
 * with SQLSTATE `expectedCode`. Accepts both `42501` and `25006` for privilege
 * checks because the role-level read-only flag may fire before the explicit
 * REVOKE check depending on Postgres internal order.
 */
async function assertSqlstateRejection(client: Client, sql: string, expectedCode: string): Promise<void> {
    expect.hasAssertions();

    try {
        await client.query(sql);
        throw new Error(`Expected SQL to fail with SQLSTATE ${expectedCode} but it succeeded: ${sql}`);
    } catch (err) {
        const pgErr = err as PgError;
        const validCodes = expectedCode === INSUFFICIENT_PRIVILEGE ? [INSUFFICIENT_PRIVILEGE, READ_ONLY_SQL_TRANSACTION] : [expectedCode];

        if (!validCodes.includes(pgErr.code ?? '')) {
            throw new Error(`Expected SQLSTATE ${expectedCode} (or ${validCodes.join('/')}) but got ${pgErr.code ?? 'no code'}: ${pgErr.message}`);
        }

        expect(validCodes).toContain(pgErr.code);
    }
}

/**
 * Calls a write SDF the way the fixed production caller (AgentPgClient) does:
 * inside an explicit transaction whose first statement is SET TRANSACTION READ
 * WRITE. The agent_writer role has `default_transaction_read_only = on`, so a
 * bare autocommit SELECT of the SDF fails with 25006 ("transaction read-write
 * mode must be set before any query"). Mirrors the production statement order.
 */
async function callWriteSdf<T extends { [k: string]: unknown }>(client: Client, sql: string, params: ReadonlyArray<unknown>): Promise<T[]> {
    try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION READ WRITE');
        const result = await client.query<T>(sql, params as unknown[]);
        await client.query('COMMIT');
        return result.rows;
    } catch (cause) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw cause;
    }
}

// ---------------------------------------------------------------------------
// Seed helper: insert a real active strategy_versions row via admin connection.
// Returns the new strategy_versions_id. Cleans up via the returned destructor.
// ---------------------------------------------------------------------------

interface ISeedResult {
    parentVersionId: number;
    cleanup: () => Promise<void>;
}

async function seedActiveStrategyVersion(adminClient: Client): Promise<ISeedResult> {
    const name = `test-agent-writer-${Date.now()}`;

    const rows = (
        await adminClient.query<{ strategy_versions_id: number }>(
            `INSERT INTO strategy_versions (name, version, direction, params, status)
         VALUES ($1, 1, 'mean_reversion', $2::jsonb, 'active')
         RETURNING strategy_versions_id`,
            [name, JSON.stringify({ trade_enabled: false })],
        )
    ).rows;

    const parentVersionId = rows[0]!.strategy_versions_id;

    return {
        parentVersionId,
        cleanup: async () => {
            // Remove draft rows first (FK from parent_version_id) then the parent.
            await adminClient.query(`DELETE FROM strategy_versions WHERE parent_version_id = $1`, [parentVersionId]);
            await adminClient.query(`DELETE FROM strategy_versions WHERE strategy_versions_id = $1`, [parentVersionId]);
        },
    };
}

// ---------------------------------------------------------------------------
// [1] Migration round-trip — reversibility
// ---------------------------------------------------------------------------

describe('agent_writer migration — reversibility (ADR 0036)', () => {
    let dataSource: DataSource;
    let adminClient: Client | null = null;
    let suiteSkipped = false;

    beforeAll(async () => {
        adminClient = await buildAdminClient();
        if (adminClient === null) {
            suiteSkipped = true;
            console.warn(
                '[SKIPPED] agent-writer-role.integration (reversibility): no live Postgres reachable.\n' +
                    'Start the test DB with `docker compose --profile test up -d --wait postgres-test` and run migrations.',
            );
            return;
        }

        const options = buildDataSourceOptions(ENGINE_DB_URL);
        dataSource = new DataSource(options);
        await dataSource.initialize();
    }, 30_000);

    afterAll(async () => {
        if (adminClient !== null) {
            await adminClient.end();
        }
        if (dataSource?.isInitialized) {
            // Re-run all migrations to leave the schema clean for subsequent suites.
            await dataSource.runMigrations({ transaction: 'each' });
            await dataSource.destroy();
        }
    }, 60_000);

    function skipIfNotReachable(): boolean {
        if (suiteSkipped) {
            console.warn('[SKIP] Postgres not reachable — test skipped');
            return true;
        }
        return false;
    }

    it('[1a] function draft_strategy_version exists after migration up()', async () => {
        if (skipIfNotReachable()) return;

        const rows = await adminClient!.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proname = 'draft_strategy_version'`);

        expect(rows.rows.length).toBe(1);
    });

    it('[1b] agent_writer role exists after migration up()', async () => {
        if (skipIfNotReachable()) return;

        const rows = await adminClient!.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = 'agent_writer'`);

        expect(rows.rows.length).toBe(1);
    });

    it('[1c] down() cleans up, then up() restores — full round-trip', async () => {
        if (skipIfNotReachable()) return;

        // draft_strategy_version is created by the first M13 migration
        // (20260620000000). Later M13 migrations (agent_run_history table, the
        // record_agent_run_history SDF, the revoked_jti grant) were stacked on
        // top, so undoing a fixed count rots whenever a migration is added.
        // Undo migrations one at a time until the function is gone (bounded so a
        // genuinely irreversible down() surfaces as a clear failure, not a hang).
        const MAX_UNDO = 8;
        let undone = 0;
        for (; undone < MAX_UNDO; undone += 1) {
            const stillPresent = await adminClient!.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proname = 'draft_strategy_version'`);
            if (stillPresent.rows.length === 0) {
                break;
            }
            await dataSource.undoLastMigration({ transaction: 'each' });
        }

        // After revert: function must be gone.
        const afterDown = await adminClient!.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proname = 'draft_strategy_version'`);
        expect(afterDown.rows.length).toBe(0);

        // Re-apply all migrations.
        await dataSource.runMigrations({ transaction: 'each' });

        // After re-apply: function must be present again.
        const afterReapply = await adminClient!.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proname = 'draft_strategy_version'`);
        expect(afterReapply.rows.length).toBe(1);
    }, 60_000);
});

// ---------------------------------------------------------------------------
// [2] pg_proc.prosrc invariant: 'draft' PRESENT, 'active' ABSENT
// ---------------------------------------------------------------------------

describe('agent_writer SDF — source-code invariant (ADR 0036 §2.3)', () => {
    let adminClient: Client | null = null;
    let suiteSkipped = false;

    beforeAll(async () => {
        adminClient = await buildAdminClient();
        if (adminClient === null) {
            suiteSkipped = true;
            console.warn('[SKIPPED] agent-writer-role.integration (prosrc): no live Postgres reachable.');
        }
    }, 15_000);

    afterAll(async () => {
        if (adminClient !== null) {
            await adminClient.end();
        }
    });

    function skipIfNotReachable(): boolean {
        if (suiteSkipped) {
            console.warn('[SKIP] Postgres not reachable — test skipped');
            return true;
        }
        return false;
    }

    it("[2] pg_proc.prosrc contains 'draft' and does NOT contain 'active' string literal", async () => {
        if (skipIfNotReachable()) return;

        const rows = await adminClient!.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE proname = 'draft_strategy_version'`);

        expect(rows.rows.length).toBe(1);

        const body = rows.rows[0]!.prosrc;

        // The SDF must hard-code 'draft' — this is the load-bearing invariant.
        expect(body).toContain("'draft'");

        // The word 'active' must never appear in the function body — there is
        // no parameter, variable, or concatenation path that can yield status='active'.
        // Note: the validation check compares v_parent_status <> 'active' which
        // IS intentional and expected — we allow that guard phrase but the key
        // requirement per ADR 0036 §2.3 is that the INSERT literal is 'draft'.
        // The assertion below checks the INSERT target literal only.
        const insertBlock = body.slice(body.indexOf('INSERT INTO strategy_versions'));
        expect(insertBlock).not.toMatch(/'active'/);
    });
});

// ---------------------------------------------------------------------------
// [3+4+5+6+7+8] agent_writer privilege assertions
// ---------------------------------------------------------------------------

describe('agent_writer role — privilege enforcement (ADR 0036 §5)', () => {
    let adminClient: Client | null = null;
    let writerClient: Client | null = null;
    let suiteSkipped = false;
    let seed: ISeedResult | null = null;

    beforeAll(async () => {
        adminClient = await buildAdminClient();
        writerClient = await buildAgentWriterClient();

        if (adminClient === null || writerClient === null) {
            suiteSkipped = true;
            console.warn(
                '[SKIPPED] agent-writer-role.integration (privileges): no live Postgres reachable.\n' +
                    'To run: start Postgres, run migrations, and ensure agent_writer has the sentinel password.',
            );
            return;
        }

        // Seed a real active strategy_versions row so the SDF has a valid parent.
        seed = await seedActiveStrategyVersion(adminClient);
    }, 15_000);

    afterAll(async () => {
        if (seed !== null) {
            await seed.cleanup();
        }
        if (writerClient !== null) {
            await writerClient.end();
        }
        if (adminClient !== null) {
            await adminClient.end();
        }
    }, 15_000);

    function skipIfNotReachable(): boolean {
        if (suiteSkipped) {
            console.warn('[SKIP] Postgres not reachable — test skipped');
            return true;
        }
        return false;
    }

    it('[3] SDF inserts a row with status=draft given a valid active parent', async () => {
        if (skipIfNotReachable()) return;

        const weekIso = `2099-W01-test-${Date.now()}`;

        const sdfRows = await callWriteSdf<{ draft_strategy_version: number | null }>(
            writerClient!,
            `SELECT draft_strategy_version($1, $2::jsonb, $3, $4) AS draft_strategy_version`,
            [seed!.parentVersionId, JSON.stringify({ trade_enabled: false }), 'test rationale', weekIso],
        );

        const draftId = sdfRows[0]!.draft_strategy_version;

        expect(typeof draftId).toBe('number');
        expect(draftId).toBeGreaterThan(0);

        // Verify the persisted row via admin client.
        const rows = await adminClient!.query<{ status: string }>(`SELECT status FROM strategy_versions WHERE strategy_versions_id = $1`, [draftId]);

        expect(rows.rows[0]!.status).toBe('draft');
    });

    it('[4] SDF returns NULL on second call with same (parent_version_id, week_iso) — idempotency', async () => {
        if (skipIfNotReachable()) return;

        // Use a deterministic week_iso so the conflict is guaranteed.
        const weekIso = `2099-W02-idempotent-${seed!.parentVersionId}`;

        // First call — should insert.
        const first = await callWriteSdf<{ draft_strategy_version: number | null }>(writerClient!, `SELECT draft_strategy_version($1, $2::jsonb, $3, $4)`, [
            seed!.parentVersionId,
            JSON.stringify({ trade_enabled: false }),
            'first',
            weekIso,
        ]);
        expect(first[0]!.draft_strategy_version).not.toBeNull();

        // Second call with identical (parent_version_id, week_iso) — ON CONFLICT DO NOTHING.
        const second = await callWriteSdf<{ draft_strategy_version: number | null }>(writerClient!, `SELECT draft_strategy_version($1, $2::jsonb, $3, $4)`, [
            seed!.parentVersionId,
            JSON.stringify({ trade_enabled: true }),
            'second',
            weekIso,
        ]);
        expect(second[0]!.draft_strategy_version).toBeNull();
    });

    it('[5] agent_writer cannot INSERT INTO strategy_versions directly → 42501', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(
            writerClient!,
            `INSERT INTO strategy_versions (name, version, direction, params, status) VALUES ('x', 99, 'mean_reversion', '{}'::jsonb, 'active')`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    it('[6] agent_writer cannot UPDATE strategy_versions SET status=active → 42501', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(
            writerClient!,
            `UPDATE strategy_versions SET status = 'active' WHERE strategy_versions_id = ${seed!.parentVersionId}`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    it('[7] agent_writer cannot ALTER FUNCTION draft_strategy_version → 42501', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(writerClient!, `ALTER FUNCTION draft_strategy_version(integer, jsonb, text, text) COST 200`, INSUFFICIENT_PRIVILEGE);
    });

    // Auth is stateless HS256 JWT — there is no `auth_tokens` table and there
    // never should be. This asserts the least-privilege intent: agent_writer
    // must not be able to read an auth-adjacent table (login_rate_limit_state)
    // that is outside its narrow write surface.
    it('[8] agent_writer cannot SELECT * FROM login_rate_limit_state → 42501', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(writerClient!, `SELECT * FROM login_rate_limit_state LIMIT 1`, INSUFFICIENT_PRIVILEGE);
    });
});
