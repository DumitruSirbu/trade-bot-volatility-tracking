/**
 * M13 W0 — `agent_run_history` table structure + privilege tests
 * (ADR 0036 §"agent_run_history").
 *
 * Requires a live Postgres instance with all migrations applied, including
 * `20260620000001-CreateAgentRunHistory.ts`.
 *
 * Start Postgres with:
 *   DB_PORT=5433 docker compose up -d postgres
 *
 * Run all migrations:
 *   pnpm --filter @bot/engine migration:run
 *
 * The agent_writer password must match the sentinel (only valid for test):
 *   psql -c "ALTER ROLE agent_writer PASSWORD 'CHANGE_ME_BEFORE_PROD';"
 *
 * If Postgres is unreachable the suite skips with a clear message.
 *
 * Coverage:
 *   [1] All 14 expected columns are present after migration up().
 *   [2] terminal_state CHECK rejects an invalid value.
 *   [3] agent_writer INSERT of all 13 grantable columns succeeds.
 *   [4] agent_writer cannot INSERT with an explicit agent_run_id → 42501.
 *   [5] week_iso UNIQUE constraint rejects a duplicate week_iso.
 */

import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

const ENGINE_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';

const AGENT_WRITER_PASSWORD = process.env['AGENT_WRITER_PASSWORD'] ?? 'CHANGE_ME_BEFORE_PROD';

function buildAgentWriterUrl(engineUrl: string, password: string): string {
    try {
        const url = new URL(engineUrl);
        url.username = 'agent_writer';
        url.password = encodeURIComponent(password);
        return url.toString();
    } catch {
        return `postgresql://agent_writer:${encodeURIComponent(password)}@localhost:5433/trade_bot`;
    }
}

const AGENT_WRITER_URL = buildAgentWriterUrl(ENGINE_DB_URL, AGENT_WRITER_PASSWORD);

// ---------------------------------------------------------------------------
// PG error codes
// ---------------------------------------------------------------------------

/** 42501 — insufficient_privilege */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 25006 — read_only_sql_transaction */
const READ_ONLY_SQL_TRANSACTION = '25006';
/** 23514 — check_violation */
const CHECK_VIOLATION = '23514';
/** 23505 — unique_violation */
const UNIQUE_VIOLATION = '23505';

type PgError = Error & { code?: string };

// ---------------------------------------------------------------------------
// Skip detection
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
 * mode must be set before any query"). This mirrors the production statement
 * ordering so the test is a faithful regression for that path.
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

/** Returns the strategy_versions_id for the v0 active seed row. */
async function fetchActiveParentVersionId(adminClient: Client): Promise<number> {
    const rows = await adminClient.query<{ strategy_versions_id: number }>(
        `SELECT strategy_versions_id FROM strategy_versions
         WHERE name = 'volatility-vwap' AND status = 'active' LIMIT 1`,
    );
    if (rows.rows.length === 0) {
        throw new Error('No active strategy_versions row found — run SeedStrategyVersions migration first');
    }
    return rows.rows[0]!.strategy_versions_id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent_run_history table — structure + privilege (ADR 0036)', () => {
    let adminClient: Client | null = null;
    let writerClient: Client | null = null;
    let suiteSkipped = false;
    let parentVersionId = 0;

    /** Tracks week_iso values inserted during the test run so the cleanup can
     *  delete them regardless of which test inserted them. */
    const insertedWeekIsos: string[] = [];

    beforeAll(async () => {
        adminClient = await tryConnect(ENGINE_DB_URL);
        writerClient = await tryConnect(AGENT_WRITER_URL);

        if (adminClient === null || writerClient === null) {
            suiteSkipped = true;
            console.warn(
                '[SKIPPED] agent-run-history.integration: no live Postgres reachable.\n' +
                    'Start Postgres with `DB_PORT=5433 docker compose up -d postgres` and run migrations.',
            );
            return;
        }

        parentVersionId = await fetchActiveParentVersionId(adminClient);
    }, 15_000);

    afterAll(async () => {
        // Clean up test rows by week_iso (the UNIQUE key) using the admin connection.
        if (adminClient !== null && insertedWeekIsos.length > 0) {
            for (const iso of insertedWeekIsos) {
                await adminClient.query(`DELETE FROM agent_run_history WHERE week_iso = $1`, [iso]).catch(() => {
                    /* ignore errors during cleanup */
                });
            }
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

    // ---- [1] Column completeness ----

    it('[1] agent_run_history has all 14 expected columns after migration up()', async () => {
        if (skipIfNotReachable()) return;

        const expectedColumns = [
            'agent_run_id',
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

        const rows = await adminClient!.query<{ column_name: string }>(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'agent_run_history'
             ORDER BY column_name`,
        );

        const actualColumns = rows.rows.map((r) => r.column_name);

        for (const col of expectedColumns) {
            expect(actualColumns).toContain(col);
        }
    });

    // ---- [2] terminal_state CHECK rejects invalid value ----

    it('[2] INSERT with an invalid terminal_state value is rejected by CHECK constraint', async () => {
        if (skipIfNotReachable()) return;

        const weekIso = `2099-W90-check-${Date.now()}`;

        try {
            await adminClient!.query(
                `INSERT INTO agent_run_history
                     (week_iso, parent_version_id, model_id, terminal_state, started_at)
                 VALUES ($1, $2, 'test-model', 'INVALID_STATE', now())`,
                [weekIso, parentVersionId],
            );
            throw new Error('Expected CHECK violation but INSERT succeeded');
        } catch (err) {
            const pgErr = err as PgError;
            expect(pgErr.code).toBe(CHECK_VIOLATION);
        }
    });

    // ---- [3] Direct INSERT under agent_writer rejected post fix-wave-2 ----
    //
    // M13 W6 fix wave 2 (#1) — the column-level INSERT grant on
    // agent_run_history was REVOKEd; the SDF `record_agent_run_history` is
    // the sole write path. See tests [6]/[7]/[8] for the SDF coverage.
    it('[3] direct INSERT under agent_writer is rejected (column grant REVOKEd by migration 0620000002)', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(
            writerClient!,
            `INSERT INTO agent_run_history
                 (week_iso, parent_version_id, draft_version_id, model_id,
                  report_md_path, report_json_path, terminal_state,
                  failure_reason, started_at, finished_at,
                  bootstrap_ci_lo, bootstrap_ci_hi, passes_promotion_gate)
             VALUES ('2099-W03-blocked', ${parentVersionId}, NULL, 'm',
                     NULL, NULL, 'COMPLETED',
                     NULL, now(), now(),
                     NULL, NULL, NULL)`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [4] agent_writer cannot INSERT with explicit agent_run_id → 42501 ----

    it('[4] agent_writer cannot specify agent_run_id directly → 42501', async () => {
        if (skipIfNotReachable()) return;

        // agent_run_id is the BIGSERIAL PK — not in the column-level grant.
        await assertSqlstateRejection(
            writerClient!,
            `INSERT INTO agent_run_history
                 (agent_run_id, week_iso, parent_version_id, model_id, terminal_state, started_at)
             VALUES (999999, '2099-W04-pk-bypass', ${parentVersionId}, 'test', 'COMPLETED', now())`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [6] record_agent_run_history SDF returns bigint as agent_writer ----

    it('[6] agent_writer can call record_agent_run_history SDF and gets back a bigint id', async () => {
        if (skipIfNotReachable()) return;

        const weekIso = `2099-W06-sdf-${Date.now()}`;
        insertedWeekIsos.push(weekIso);

        const rows = await callWriteSdf<{ agent_run_id: number | string | null }>(
            writerClient!,
            `SELECT record_agent_run_history(
                $1, $2, NULL, 'claude-opus-4-7', '/r/test.md', '/r/test.json',
                'COMPLETED', NULL, now(), now(),
                -0.05, 0.12, true
            ) AS agent_run_id`,
            [weekIso, parentVersionId],
        );

        expect(rows.length).toBe(1);
        const raw = rows[0]!.agent_run_id;
        const asNumber = typeof raw === 'string' ? Number(raw) : raw;
        expect(asNumber).not.toBeNull();
        expect(asNumber).toBeGreaterThan(0);
    });

    // ---- [7] record_agent_run_history is idempotent on (week_iso) ----

    it('[7] second call to record_agent_run_history with same week_iso returns NULL', async () => {
        if (skipIfNotReachable()) return;

        const weekIso = `2099-W07-idem-${Date.now()}`;
        insertedWeekIsos.push(weekIso);

        const first = await callWriteSdf<{ agent_run_id: number | string | null }>(
            writerClient!,
            `SELECT record_agent_run_history(
                $1, $2, NULL, 'm', NULL, NULL,
                'COMPLETED', NULL, now(), now(),
                NULL, NULL, NULL
            ) AS agent_run_id`,
            [weekIso, parentVersionId],
        );
        expect(first[0]!.agent_run_id).not.toBeNull();

        const second = await callWriteSdf<{ agent_run_id: number | string | null }>(
            writerClient!,
            `SELECT record_agent_run_history(
                $1, $2, NULL, 'm', NULL, NULL,
                'COMPLETED', NULL, now(), now(),
                NULL, NULL, NULL
            ) AS agent_run_id`,
            [weekIso, parentVersionId],
        );
        expect(second[0]!.agent_run_id).toBeNull();
    });

    // ---- [8] Direct INSERT under agent_writer is REVOKEd (SDF-only) ----

    it('[8] direct INSERT INTO agent_run_history under agent_writer is rejected (REVOKEd grant)', async () => {
        if (skipIfNotReachable()) return;

        await assertSqlstateRejection(
            writerClient!,
            `INSERT INTO agent_run_history
                 (week_iso, parent_version_id, model_id, terminal_state, started_at)
             VALUES ('2099-W08-bypass', ${parentVersionId}, 'test', 'COMPLETED', now())`,
            INSUFFICIENT_PRIVILEGE,
        );
    });

    // ---- [5] week_iso UNIQUE constraint rejects duplicate ----

    it('[5] week_iso UNIQUE constraint rejects a duplicate INSERT', async () => {
        if (skipIfNotReachable()) return;

        const weekIso = `2099-W05-unique-${Date.now()}`;
        insertedWeekIsos.push(weekIso);

        // First INSERT — must succeed.
        await adminClient!.query(
            `INSERT INTO agent_run_history
                 (week_iso, parent_version_id, model_id, terminal_state, started_at)
             VALUES ($1, $2, 'test-model', 'COMPLETED', now())`,
            [weekIso, parentVersionId],
        );

        // Second INSERT with the same week_iso — must fail with unique violation.
        try {
            await adminClient!.query(
                `INSERT INTO agent_run_history
                     (week_iso, parent_version_id, model_id, terminal_state, started_at)
                 VALUES ($1, $2, 'test-model-2', 'COMPLETED', now())`,
                [weekIso, parentVersionId],
            );
            throw new Error('Expected UNIQUE violation but second INSERT succeeded');
        } catch (err) {
            const pgErr = err as PgError;
            expect(pgErr.code).toBe(UNIQUE_VIOLATION);
        }
    });
});
