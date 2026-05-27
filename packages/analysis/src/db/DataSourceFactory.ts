// M12 W1 — TypeORM DataSource builder for the read-only MCP analysis path.
//
// Pure TS library (no NestJS DI). Caller invokes `createMcpDataSource()` to
// obtain an *un-initialized* DataSource and is responsible for `.initialize()`
// + `.destroy()` lifecycle. Keeping initialization caller-side lets the MCP
// server own connection lifecycle (one DataSource per process, destroyed on
// graceful shutdown) without binding analysis to any framework.
//
// Connection target: per ADR 0034 §2.3, the analysis layer always talks to
// Postgres as the `mcp_reader` role. The role enforces (a) read-only at
// transaction start, (b) 30s statement_timeout, (c) 5s lock_timeout, (d) 60s
// idle-in-transaction timeout. The pool here is independent from the engine's
// own DataSource — they never share connections or a process address space
// (ADR 0033 §2.2).
//
// Pool sizing: `max=3` matches ADR 0034 §2.3 — one active query + one
// streaming follow-up + headroom. `min=0` because MCP is interactive and
// cold-start cost is cheap; we avoid holding warm connections that idle on
// the engine's PG `max_connections` budget.
//
// `application_name=mcp_reader` is set via TypeORM `extra` so pg_stat_activity
// + the engine's PG dashboards can distinguish MCP queries from engine
// writers at a glance.
//
// Env var validation happens at factory invocation so a missing
// MCP_DB_PASSWORD never silently degrades into a connection refused at first
// query time. The thrown `McpDataSourceConfigError` carries the offending var
// name so the operator runbook can pinpoint the fix.

import { DataSource, DataSourceOptions } from 'typeorm';

const DEFAULT_USER = 'mcp_reader';
const DEFAULT_PORT = 5432;
const POOL_MAX = 3;
const POOL_MIN = 0;
const POOL_IDLE_MS = 30_000;
const APPLICATION_NAME = 'mcp_reader';

// Sentinel value baked into the role-creation migration
// (`20260619000000-CreateMcpReaderRole.ts`). Operators must rotate the role
// password via `ALTER ROLE "mcp_reader" PASSWORD '<secret>'` BEFORE pointing
// MCP at the database — see `docs/runbooks/mcp-deployment.md`. Refusing to
// boot here is the second line of defence (the role itself is read-only by
// `default_transaction_read_only`, but the sentinel is a publicly-known
// string and must never reach a live deployment).
const SENTINEL_PASSWORD = 'mcp_reader_change_me_at_deploy';

export class McpDataSourceConfigError extends Error {
    readonly missingEnvVar: string;

    constructor(envVar: string, detail: string) {
        super(`MCP DataSource config invalid (${envVar}): ${detail}`);
        this.name = 'McpDataSourceConfigError';
        this.missingEnvVar = envVar;
    }
}

export interface IMcpDataSourceEnv {
    readonly MCP_DB_HOST?: string;
    readonly MCP_DB_PORT?: string;
    readonly MCP_DB_NAME?: string;
    readonly MCP_DB_USER?: string;
    readonly MCP_DB_PASSWORD?: string;
    readonly MCP_DB_SSL?: string;
}

// Exported for testability — the production callsite delegates to
// `createMcpDataSource()` which reads `process.env` directly.
export function buildMcpDataSourceOptions(env: IMcpDataSourceEnv): DataSourceOptions {
    const host = readRequired(env, 'MCP_DB_HOST');
    const port = parsePortOrThrow(env.MCP_DB_PORT);
    const database = readRequired(env, 'MCP_DB_NAME');
    const username = env.MCP_DB_USER && env.MCP_DB_USER.length > 0 ? env.MCP_DB_USER : DEFAULT_USER;
    const password = readRequired(env, 'MCP_DB_PASSWORD');

    if (password === SENTINEL_PASSWORD) {
        throw new McpDataSourceConfigError(
            'MCP_DB_PASSWORD',
            'still set to the migration sentinel value. Rotate the mcp_reader role password before launch — see docs/runbooks/mcp-deployment.md',
        );
    }

    const ssl = parseSslFlag(env.MCP_DB_SSL);

    return {
        type: 'postgres',
        host,
        port,
        database,
        username,
        password,
        // Analysis queries are issued as raw SQL via `DataSource.query()` —
        // no entity metadata loaded here. Keeps the bundle independent of
        // the engine's TypeORM entity classes (which would itself be a
        // boundary violation under ADR 0033 §2.2).
        entities: [],
        // `synchronize: false` is mandatory (CLAUDE.md hard rule); the
        // analysis layer never owns schema.
        synchronize: false,
        // Migrations are owned by the engine — analysis must not even
        // discover them, let alone run them under mcp_reader (which lacks
        // CREATE/ALTER anyway).
        migrationsRun: false,
        logging: false,
        ssl,
        extra: {
            // pg pool sizing — see header.
            max: POOL_MAX,
            min: POOL_MIN,
            idleTimeoutMillis: POOL_IDLE_MS,
            // Surfaces in pg_stat_activity.application_name; the engine's
            // observability uses this to distinguish MCP from the writer.
            application_name: APPLICATION_NAME,
        },
    };
}

// Production entry point. Returns an *un-initialized* DataSource — the caller
// owns lifecycle so process-shutdown semantics live with the host
// (apps/mcp/src/main.ts at W3).
export function createMcpDataSource(): DataSource {
    const options = buildMcpDataSourceOptions(process.env as IMcpDataSourceEnv);

    return new DataSource(options);
}

function readRequired(env: IMcpDataSourceEnv, key: keyof IMcpDataSourceEnv): string {
    const value = env[key];

    if (value === undefined || value === null || value.length === 0) {
        throw new McpDataSourceConfigError(String(key), 'env var is missing or empty');
    }

    return value;
}

function parsePortOrThrow(raw: string | undefined): number {
    if (raw === undefined || raw.length === 0) {
        return DEFAULT_PORT;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new McpDataSourceConfigError('MCP_DB_PORT', `not a valid TCP port: "${raw}"`);
    }

    return parsed;
}

// SSL parsing is strict — the previous implementation defaulted any truthy
// value to `{ rejectUnauthorized: false }`, which silently accepted
// CA-unverified TLS on `MCP_DB_SSL=true|1|require`. Defense in depth: the
// `mcp_reader` role is read-only at the DB level, but a man-in-the-middle on
// the connection could still leak credentials or DB contents. We now require
// the operator to choose explicitly between TLS-off and a verifying mode.
//
// Accepted values (case-insensitive):
//   - off:               '', 'disable', 'false', 'off', '0'         → no TLS
//   - verifying TLS:     'verify-full', 'verify-ca'                 → { rejectUnauthorized: true }
//   - everything else (incl. 'require', 'true', '1'): throws — these used
//     to mean "TLS without CA verification" and that mode is no longer
//     supported.
function parseSslFlag(raw: string | undefined): boolean | { rejectUnauthorized: boolean } {
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

    throw new McpDataSourceConfigError(
        'MCP_DB_SSL',
        `explicit verification mode required ('verify-full' or 'verify-ca'); insecure modes not supported (got "${raw}")`,
    );
}
