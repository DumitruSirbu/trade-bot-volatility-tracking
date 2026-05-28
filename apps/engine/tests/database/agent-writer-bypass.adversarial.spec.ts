/**
 * M13 W6a — Vector 4: agent_writer DB-role bypass attempts (ADR 0036 §5).
 *
 * PG-gated. Connects as `agent_writer` and attempts every bypass the threat
 * model enumerates. Every attempt MUST raise SQLSTATE 42501
 * (insufficient_privilege) or 25006 (read_only_sql_transaction — the role-
 * level flag fires first). Both codes are acceptable for the privilege check
 * because Postgres may enforce the role-level `default_transaction_read_only`
 * before the explicit REVOKE depending on the statement type.
 *
 * Bypass vectors tested:
 *   [A] UPDATE strategy_versions SET status='active' on a fresh draft row.
 *   [B] INSERT INTO strategy_versions (..., status) VALUES (..., 'active')
 *       directly, bypassing the SDF.
 *   [C] ALTER FUNCTION draft_strategy_version(...) — cannot modify SDF.
 *   [D] DROP FUNCTION draft_strategy_version(...) — cannot remove the SDF.
 *   [E] INSERT INTO agent_run_history with explicit PK (agent_run_id) column
 *       — column-level grant excludes the PK column.
 *   [F] DELETE FROM agent_run_history — no DELETE grant.
 *   [G] UPDATE agent_run_history — no UPDATE grant.
 *
 * Start Postgres:
 *   DB_PORT=5433 docker compose up -d postgres
 *   pnpm --filter @bot/engine migration:run
 *
 * Set agent_writer password to sentinel:
 *   psql -c "ALTER ROLE agent_writer PASSWORD 'CHANGE_ME_BEFORE_PROD';"
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
// SQLSTATE constants
// ---------------------------------------------------------------------------

/** 42501 — insufficient_privilege */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 25006 — read_only_sql_transaction */
const READ_ONLY_SQL_TRANSACTION = '25006';

type PgError = Error & { code?: string };

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Asserts a SQL statement fails with SQLSTATE 42501 or 25006.
 * Accepts both because Postgres may enforce the role-level read-only flag
 * before the explicit REVOKE check depending on statement type.
 */
async function assertPrivilegeRejection(client: Client, sql: string): Promise<void> {
    expect.hasAssertions();
    try {
        await client.query(sql);
        throw new Error(`Expected privilege rejection but statement succeeded: ${sql}`);
    } catch (err) {
        const pgErr = err as PgError;
        const acceptable = [INSUFFICIENT_PRIVILEGE, READ_ONLY_SQL_TRANSACTION];
        if (!acceptable.includes(pgErr.code ?? '')) {
            throw new Error(`Expected SQLSTATE 42501 or 25006 but got '${pgErr.code ?? 'no code'}': ${pgErr.message}. SQL was: ${sql}`);
        }
        expect(acceptable).toContain(pgErr.code);
    }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent_writer role — bypass attempts (M13 W6a vector 4, ADR 0036 §5)', () => {
    let adminClient: Client | null = null;
    let writerClient: Client | null = null;
    let suiteSkipped = false;

    /** strategy_versions_id of the fresh draft inserted via admin for bypass tests */
    let freshDraftId: number | null = null;
    /** agent_run_history row inserted via admin for history bypass tests */
    let freshHistoryId: number | null = null;

    beforeAll(async () => {
        adminClient = await tryConnect(ENGINE_DB_URL);
        writerClient = await tryConnect(AGENT_WRITER_URL);

        if (adminClient === null || writerClient === null) {
            suiteSkipped = true;
            console.warn(
                '[SKIPPED] agent-writer-bypass.adversarial: no live Postgres reachable or agent_writer role missing.\n' +
                    'Start Postgres with `DB_PORT=5433 docker compose up -d postgres`, run migrations, ' +
                    'and set: psql -c "ALTER ROLE agent_writer PASSWORD \'CHANGE_ME_BEFORE_PROD\';"',
            );
            return;
        }

        // Seed a real active parent version via admin so the SDF has a valid parent.
        const parentName = `bypass-adversarial-${Date.now()}`;
        const parentRows = (
            await adminClient.query<{ strategy_versions_id: number }>(
                `INSERT INTO strategy_versions (name, version, direction, params, status)
                 VALUES ($1, 1, 'mean_reversion', '{}'::jsonb, 'active')
                 RETURNING strategy_versions_id`,
                [parentName],
            )
        ).rows;
        const parentId = parentRows[0]!.strategy_versions_id;

        // Insert a draft row via admin so bypass tests [A] have a target.
        const weekIso = `2099-W99-bypass-${Date.now()}`;
        const draftRows = (
            await adminClient.query<{ strategy_versions_id: number }>(`SELECT draft_strategy_version($1, $2::jsonb, $3, $4) AS strategy_versions_id`, [
                parentId,
                '{"signalThreshold":1.9}',
                'bypass-test-rationale',
                weekIso,
            ])
        ).rows;
        freshDraftId = draftRows[0]?.strategy_versions_id ?? null;

        // Insert a row into agent_run_history via admin for history bypass tests.
        // We use a future week_iso that won't conflict with the SDF's uniqueness.
        const historyRows = (
            await adminClient.query<{ agent_run_id: number }>(
                `INSERT INTO agent_run_history
                   (week_iso, parent_version_id, model_id, terminal_state, started_at)
                 VALUES ($1, $2, 'test-model', 'COMPLETED', NOW())
                 RETURNING agent_run_id`,
                [`2099-W98-bypass-${Date.now()}`, parentId],
            )
        ).rows;
        freshHistoryId = historyRows[0]?.agent_run_id ?? null;
    }, 30_000);

    afterAll(async () => {
        // Clean up: delete seeded rows via admin.
        if (adminClient !== null) {
            if (freshHistoryId !== null) {
                await adminClient.query(`DELETE FROM agent_run_history WHERE agent_run_id = $1`, [freshHistoryId]).catch(() => undefined);
            }
            if (freshDraftId !== null) {
                await adminClient
                    .query(
                        `DELETE FROM strategy_versions WHERE parent_version_id = (SELECT parent_version_id FROM strategy_versions WHERE strategy_versions_id = $1)`,
                        [freshDraftId],
                    )
                    .catch(() => undefined);
                await adminClient.query(`DELETE FROM strategy_versions WHERE strategy_versions_id = $1`, [freshDraftId]).catch(() => undefined);
            }
            // Delete the parent version rows created with the bypass-adversarial prefix.
            await adminClient.query(`DELETE FROM strategy_versions WHERE name LIKE 'bypass-adversarial-%'`).catch(() => undefined);
            await adminClient.end().catch(() => undefined);
        }
        if (writerClient !== null) {
            await writerClient.end().catch(() => undefined);
        }
    }, 30_000);

    function skipIfNotReachable(): boolean {
        if (suiteSkipped) {
            console.warn('[SKIP] Postgres not reachable — test skipped');
            return true;
        }
        return false;
    }

    // [A] Cannot UPDATE strategy_versions SET status='active'
    it('[A] UPDATE strategy_versions SET status=active on a fresh draft row → 42501', async () => {
        if (skipIfNotReachable()) return;
        if (freshDraftId === null) {
            console.warn('[SKIP-A] freshDraftId is null — SDF seed failed. Skipping.');
            return;
        }
        await assertPrivilegeRejection(writerClient!, `UPDATE strategy_versions SET status = 'active' WHERE strategy_versions_id = ${freshDraftId}`);
    });

    // [B] Cannot INSERT INTO strategy_versions directly with status='active'
    it("[B] INSERT INTO strategy_versions (..., status='active') directly bypassing SDF → 42501", async () => {
        if (skipIfNotReachable()) return;
        await assertPrivilegeRejection(
            writerClient!,
            `INSERT INTO strategy_versions (name, version, direction, params, status) ` +
                `VALUES ('bypass-direct-insert', 99, 'mean_reversion', '{}'::jsonb, 'active')`,
        );
    });

    // [C] Cannot ALTER FUNCTION draft_strategy_version
    it('[C] ALTER FUNCTION draft_strategy_version(...) → 42501', async () => {
        if (skipIfNotReachable()) return;
        await assertPrivilegeRejection(writerClient!, `ALTER FUNCTION draft_strategy_version(integer, jsonb, text, text) COST 200`);
    });

    // [D] Cannot DROP FUNCTION draft_strategy_version
    it('[D] DROP FUNCTION draft_strategy_version(...) → 42501', async () => {
        if (skipIfNotReachable()) return;
        await assertPrivilegeRejection(writerClient!, `DROP FUNCTION draft_strategy_version(integer, jsonb, text, text)`);
    });

    // [E] Cannot INSERT INTO agent_run_history with explicit PK column
    it('[E] INSERT INTO agent_run_history with explicit agent_run_id (PK) → 42501', async () => {
        if (skipIfNotReachable()) return;
        await assertPrivilegeRejection(
            writerClient!,
            `INSERT INTO agent_run_history (agent_run_id, week_iso, parent_version_id, model_id, terminal_state, started_at) ` +
                `VALUES (999999, '2099-W97-bypass', 1, 'bypass-model', 'COMPLETED', NOW())`,
        );
    });

    // [F] Cannot DELETE FROM agent_run_history
    it('[F] DELETE FROM agent_run_history → 42501', async () => {
        if (skipIfNotReachable()) return;
        if (freshHistoryId === null) {
            console.warn('[SKIP-F] freshHistoryId is null. Skipping.');
            return;
        }
        await assertPrivilegeRejection(writerClient!, `DELETE FROM agent_run_history WHERE agent_run_id = ${freshHistoryId}`);
    });

    // [G] Cannot UPDATE agent_run_history
    it('[G] UPDATE agent_run_history SET terminal_state=FAILED → 42501', async () => {
        if (skipIfNotReachable()) return;
        if (freshHistoryId === null) {
            console.warn('[SKIP-G] freshHistoryId is null. Skipping.');
            return;
        }
        await assertPrivilegeRejection(writerClient!, `UPDATE agent_run_history SET terminal_state = 'FAILED' WHERE agent_run_id = ${freshHistoryId}`);
    });
});
