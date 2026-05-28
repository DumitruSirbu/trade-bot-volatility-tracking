// M13 W5.A — main.ts lockfile contention spec.
//
// Strategy: the test itself acquires the agent's PID lockfile, then spawns
// `node dist/main.js` as a child. The child must observe `ELOCKED` from
// `proper-lockfile`, log `LOCK_HELD`, and exit 0 (NOT a failure — overlapping
// cron triggers are tolerated by design).
//
// We use the compiled `dist/main.js` (built via the `build` script before
// `test`), spawning under a sandboxed env so the child cannot reach Postgres
// or the MCP. Only the lock acquisition + exit-code branch is exercised.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { lock as lockFile } from 'proper-lockfile';

const REPO_ROOT = resolve(__dirname, '../../../..');
const MAIN_JS = resolve(REPO_ROOT, 'apps/agent/dist/main.js');

interface ChildResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

function runChild(env: Record<string, string>): Promise<ChildResult> {
    return new Promise((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, [MAIN_JS], {
            env: { ...env, PATH: process.env.PATH ?? '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', rejectChild);
        child.on('exit', (code) => resolveChild({ exitCode: code ?? -1, stdout, stderr }));
    });
}

describe('main.ts lockfile contention', () => {
    let tmpDir: string;
    let lockPath: string;

    beforeAll(() => {
        if (!existsSync(MAIN_JS)) {
            throw new Error(`dist/main.js missing — run \`pnpm --filter @bot/agent build\` first (looked at ${MAIN_JS})`);
        }
    });

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'agent-lock-spec-'));
        lockPath = join(tmpDir, 'bot-agent.lock');
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('exits 0 with LOCK_HELD log when the lock is already held', async () => {
        const release = await lockFile(lockPath, { realpath: false, stale: 90 * 60 * 1000 });
        try {
            const result = await runChild({
                AGENT_LOCKFILE_PATH: lockPath,
                AGENT_WEEK_ISO: '2026-W22',
                AGENT_PARENT_VERSION_ID: '1',
                // Required by AgentPgClient / AiGatewayClient / McpClient — never
                // exercised on the LOCK_HELD path because contention short-circuits.
                AGENT_DB_HOST: '127.0.0.1',
                AGENT_DB_NAME: 'unused',
                AGENT_DB_PASSWORD: 'unused-real-password',
                AGENT_DB_USER: 'agent_writer',
                AGENT_MCP_URL: 'http://127.0.0.1:1',
                AGENT_MCP_BEARER: 'unused',
                AI_GATEWAY_URL: 'http://127.0.0.1:1',
                AI_GATEWAY_API_KEY: 'unused',
                AI_GATEWAY_MAX_USD_PER_RUN: '1.00',
                LOG_LEVEL: 'info',
            });
            expect(result.exitCode).toBe(0);
            expect(result.stdout + result.stderr).toMatch(/LOCK_HELD/);
        } finally {
            await release();
        }
    }, 30_000);
});
