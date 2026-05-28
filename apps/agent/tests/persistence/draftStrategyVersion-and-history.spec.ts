// M13 W3 — PG-gated integration test for the agent's two write primitives:
// `draftStrategyVersion()` (SDF call) and `insertAgentRunHistory()` (raw
// INSERT). Skipped when RUN_PG_INTEGRATION != '1'.
//
// Preconditions when the gate is on:
//   - Postgres reachable via PG_* env (host/port/db/user/password)
//   - The two M13 migrations have already been applied (the migration suite
//     runs ahead of this spec on CI; locally the operator runs them once).
//   - `agent_writer` role has its sentinel password rotated to whatever
//     `AGENT_DB_PASSWORD` provides.
//
// What we assert:
//   - draftStrategyVersion happy path returns an integer ID, the inserted
//     row has status='draft', and the second call for the same
//     (parentVersionId, weekIso) returns null (SDF idempotency).
//   - insertAgentRunHistory happy path returns an integer; a re-fire for
//     the same weekIso returns null (ON CONFLICT (week_iso) DO NOTHING).

import { TerminalStateEnum } from '@bot/shared';
import { Client } from 'pg';

import { AgentPgClient } from '../../src/persistence/AgentPgClient.js';
import { draftStrategyVersion } from '../../src/persistence/draftStrategyVersion.js';
import { insertAgentRunHistory } from '../../src/persistence/agentRunHistory.js';

const RUN_PG_INTEGRATION = process.env.RUN_PG_INTEGRATION === '1';
const describePg = RUN_PG_INTEGRATION ? describe : describe.skip;

const PG_HOST = process.env.PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.PG_PORT ?? '5432');
const PG_DB = process.env.PG_DB ?? 'bot';
const PG_SUPERUSER = process.env.PG_USER ?? 'postgres';
const PG_SUPERUSER_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const AGENT_PASSWORD = process.env.AGENT_DB_PASSWORD ?? 'agent_writer_test_secret';

describePg('agent persistence — PG-gated integration', () => {
    let superuser: Client;
    let agent: AgentPgClient;
    let parentVersionId: number;
    const weekIso = `2026-W${randomTwoDigit()}`;

    beforeAll(async () => {
        superuser = new Client({
            host: PG_HOST,
            port: PG_PORT,
            database: PG_DB,
            user: PG_SUPERUSER,
            password: PG_SUPERUSER_PASSWORD,
        });
        await superuser.connect();

        // Ensure the agent_writer password matches what the agent client
        // will use, then seed an active strategy_versions row to parent off.
        await superuser.query(`ALTER ROLE "agent_writer" PASSWORD $1`, [AGENT_PASSWORD]);

        const seeded = await superuser.query<{ strategy_versions_id: number }>(
            `INSERT INTO strategy_versions (name, version, direction, params, status, created_at)
             VALUES ($1, $2, 'LONG_ONLY', '{}'::jsonb, 'active', now())
             RETURNING strategy_versions_id`,
            [`m13w3-fixture-${Date.now()}`, 1],
        );
        parentVersionId = seeded.rows[0].strategy_versions_id;

        agent = new AgentPgClient({
            AGENT_DB_HOST: PG_HOST,
            AGENT_DB_PORT: String(PG_PORT),
            AGENT_DB_NAME: PG_DB,
            AGENT_DB_USER: 'agent_writer',
            AGENT_DB_PASSWORD: AGENT_PASSWORD,
        });
    });

    afterAll(async () => {
        if (agent !== undefined) {
            await agent.close();
        }
        if (superuser !== undefined) {
            // Clean rows authored by this run (cascade from history → version)
            await superuser.query(`DELETE FROM agent_run_history WHERE parent_version_id = $1`, [parentVersionId]);
            await superuser.query(`DELETE FROM strategy_versions WHERE parent_version_id = $1`, [parentVersionId]);
            await superuser.query(`DELETE FROM strategy_versions WHERE strategy_versions_id = $1`, [parentVersionId]);
            await superuser.end();
        }
    });

    it('draftStrategyVersion returns an int id on first call, null on idempotent re-fire, status=draft', async () => {
        const firstId = await draftStrategyVersion(agent, {
            parentVersionId,
            params: { signalThreshold: 1.9 },
            rationale: 'paired test',
            weekIso,
        });
        expect(typeof firstId).toBe('number');

        // Idempotency: same (parent, weekIso) returns null.
        const secondId = await draftStrategyVersion(agent, {
            parentVersionId,
            params: { signalThreshold: 1.9 },
            rationale: 'paired test',
            weekIso,
        });
        expect(secondId).toBeNull();

        // Verify via superuser that status is draft (the agent has no
        // INSERT grant; the SDF body hard-coded the literal).
        const row = await superuser.query<{ status: string; week_iso: string | null }>(
            `SELECT status, week_iso FROM strategy_versions WHERE strategy_versions_id = $1`,
            [firstId],
        );
        expect(row.rows[0].status).toBe('draft');
        expect(row.rows[0].week_iso).toBe(weekIso);
    });

    it('insertAgentRunHistory happy path returns int; double-fire for same weekIso returns null', async () => {
        const historyWeek = `2026-W${randomTwoDigit()}`;
        const firstHistoryId = await insertAgentRunHistory(agent, {
            weekIso: historyWeek,
            parentVersionId,
            draftVersionId: null,
            modelId: 'anthropic/claude-opus-4-7',
            reportMdPath: null,
            reportJsonPath: null,
            terminalState: TerminalStateEnum.COMPLETED,
            failureReason: null,
            startedAt: new Date(),
            finishedAt: new Date(),
            bootstrapCiLo: null,
            bootstrapCiHi: null,
            passesPromotionGate: null,
        });
        expect(typeof firstHistoryId).toBe('number');

        const secondHistoryId = await insertAgentRunHistory(agent, {
            weekIso: historyWeek,
            parentVersionId,
            draftVersionId: null,
            modelId: 'anthropic/claude-opus-4-7',
            reportMdPath: null,
            reportJsonPath: null,
            terminalState: TerminalStateEnum.COMPLETED,
            failureReason: null,
            startedAt: new Date(),
            finishedAt: new Date(),
            bootstrapCiLo: null,
            bootstrapCiHi: null,
            passesPromotionGate: null,
        });
        expect(secondHistoryId).toBeNull();
    });
});

function randomTwoDigit(): string {
    const n = 10 + Math.floor(Math.random() * 40);
    return n < 10 ? `0${n}` : String(n);
}
