// M13 W3 — pg Pool wrapper for apps/agent.
//
// Mirrors M12 `DataSourceFactory` patterns: validates env at construction,
// refuses to boot if the password matches the sentinel baked into the
// `agent_writer` role-creation migration, sizes the pool to 2 (the agent
// issues at most one SDF call + one history INSERT per run), and exposes a
// minimal query/close surface so the rest of the persistence layer stays
// thin and testable.
//
// The role expected here is `agent_writer` (ADR 0036). Any other role makes
// the SDF call fail at GRANT-check time — the constructor refuses such
// configurations up-front with a clear log so the operator sees the bad
// wiring at boot, not deep inside the loop.

import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

const EXPECTED_ROLE = 'agent_writer';
const SENTINEL_PASSWORD = 'CHANGE_ME_BEFORE_PROD';
const DEFAULT_PORT = 5432;
const POOL_MAX = 2;
const POOL_MIN = 0;
const POOL_IDLE_MS = 10_000;
const APPLICATION_NAME = 'agent_writer';

export class AgentPgConfigError extends Error {
    readonly missingEnvVar: string;

    constructor(envVar: string, detail: string) {
        super(`Agent pg config invalid (${envVar}): ${detail}`);
        this.name = 'AgentPgConfigError';
        this.missingEnvVar = envVar;
    }
}

export interface IAgentPgEnv {
    readonly AGENT_DB_HOST?: string;
    readonly AGENT_DB_PORT?: string;
    readonly AGENT_DB_NAME?: string;
    readonly AGENT_DB_USER?: string;
    readonly AGENT_DB_PASSWORD?: string;
    readonly AGENT_DB_SSL?: string;
}

export interface IAgentPgClient {
    query<T extends QueryResultRow = QueryResultRow>(sql: string, params: ReadonlyArray<unknown>): Promise<T[]>;
    close(): Promise<void>;
}

export function buildAgentPoolConfig(env: IAgentPgEnv): PoolConfig {
    const host = readRequired(env, 'AGENT_DB_HOST');
    const port = parsePortOrThrow(env.AGENT_DB_PORT);
    const database = readRequired(env, 'AGENT_DB_NAME');
    const user = env.AGENT_DB_USER && env.AGENT_DB_USER.length > 0 ? env.AGENT_DB_USER : EXPECTED_ROLE;

    if (user !== EXPECTED_ROLE) {
        throw new AgentPgConfigError(
            'AGENT_DB_USER',
            `must be "${EXPECTED_ROLE}" (got "${user}"); the agent's least-privilege role is the only acceptable login per ADR 0036`,
        );
    }

    const password = readRequired(env, 'AGENT_DB_PASSWORD');

    if (password === SENTINEL_PASSWORD) {
        throw new AgentPgConfigError(
            'AGENT_DB_PASSWORD',
            'still set to the migration sentinel; rotate the agent_writer role password before launch',
        );
    }

    const ssl = parseSslFlag(env.AGENT_DB_SSL);

    return {
        host,
        port,
        database,
        user,
        password,
        max: POOL_MAX,
        min: POOL_MIN,
        idleTimeoutMillis: POOL_IDLE_MS,
        application_name: APPLICATION_NAME,
        ssl,
    };
}

export class AgentPgClient implements IAgentPgClient {
    private readonly pool: Pool;

    constructor(env: IAgentPgEnv = process.env as IAgentPgEnv) {
        const config = buildAgentPoolConfig(env);
        this.pool = new Pool(config);
    }

    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: ReadonlyArray<unknown>): Promise<T[]> {
        const result = await this.pool.query<T>(sql, params as unknown[]);
        return result.rows;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

function readRequired(env: IAgentPgEnv, key: keyof IAgentPgEnv): string {
    const value = env[key];

    if (value === undefined || value === null || value.length === 0) {
        throw new AgentPgConfigError(String(key), 'env var is missing or empty');
    }

    return value;
}

function parsePortOrThrow(raw: string | undefined): number {
    if (raw === undefined || raw.length === 0) {
        return DEFAULT_PORT;
    }

    const parsed = Number(raw);

    if (! Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new AgentPgConfigError('AGENT_DB_PORT', `not a valid TCP port: "${raw}"`);
    }

    return parsed;
}

function parseSslFlag(raw: string | undefined): false | { rejectUnauthorized: boolean } {
    if (raw === undefined || raw.length === 0) {
        return false;
    }

    const normalised = raw.toLowerCase();

    if (normalised === '0' || normalised === 'false' || normalised === 'off' || normalised === 'disable') {
        return false;
    }

    if (normalised === 'verify-full' || normalised === 'verify-ca') {
        return { rejectUnauthorized: true };
    }

    throw new AgentPgConfigError(
        'AGENT_DB_SSL',
        `explicit verification mode required ('verify-full' or 'verify-ca'); insecure modes not supported (got "${raw}")`,
    );
}
