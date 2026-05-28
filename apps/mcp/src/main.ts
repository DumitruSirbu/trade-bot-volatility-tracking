// M12 W3 — MCP server entrypoint.
// M13 W1.B (ADR 0038) — added transport selector: MCP_TRANSPORT={stdio|http}.
//
// Boot sequence (ordered, intentional):
//   1. Configure stderr logging — stdout is reserved for the stdio JSON-RPC
//      transport; ANY accidental stdout write corrupts the protocol stream.
//      (HTTP transport is stdout-safe, but we keep the discipline uniform.)
//   2. Run the runtime boundary guard FIRST so we fail fast if engine code
//      somehow loaded into this address space (ADR 0033 §2.4 layer C).
//   3. Build the @bot/analysis DataSource (the only PG handle in the
//      process) and initialize it.
//   4. Instantiate the ToolRegistry + register all read-only tools.
//   5. Read MCP_TRANSPORT (default 'stdio' — preserves M12 compatibility).
//      Boot the chosen transport; HTTP additionally requires AUTH_HMAC_SECRET
//      (master secret — derived via HKDF to match the engine's signing key)
//      and binds to 127.0.0.1.
//   6. Install SIGINT/SIGTERM hooks for clean shutdown.
//
// Boundary invariant (ADR 0033 §2.2): this file imports
// `@modelcontextprotocol/sdk`, `@bot/analysis`, `@bot/shared`, and sibling
// MCP modules only. Zero edges to @bot/engine.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpDataSource } from '@bot/analysis';

import { runBoundaryGuard } from './boundary/RuntimeGuard.js';
import { McpToolError } from './errors/McpToolError.js';
import { IHttpTransportHandle, MCP_HTTP_DEFAULT_PORT, startHttpTransport } from './transport/HttpTransport.js';
import { IRevokedJtiChecker } from './transport/bearerVerifier.js';
import { deriveAuthKey } from './transport/deriveAuthKey.js';
import { registerAllTools } from './tools/registerAllTools.js';
import { ToolRegistry } from './tools/ToolRegistry.js';

const SERVER_NAME = '@bot/mcp';
const SERVER_VERSION = '0.0.1';

const TRANSPORT_STDIO = 'stdio';
const TRANSPORT_HTTP = 'http';

const AUTH_MIN_SECRET_BYTES = 32;

/** Stderr logger. Under stdio transport, stdout is RESERVED for the protocol. */
function logInfo(message: string): void {
    process.stderr.write(`[mcp] ${message}\n`);
}

function logError(message: string, cause?: unknown): void {
    const causeStr = cause instanceof Error ? `: ${cause.message}` : cause !== undefined ? `: ${String(cause)}` : '';
    process.stderr.write(`[mcp] ERROR ${message}${causeStr}\n`);
}

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

interface IMcpRuntime {
    readonly server: Server;
    readonly stdioTransport: StdioServerTransport | null;
    readonly httpTransport: IHttpTransportHandle | null;
    readonly dataSource: AnalysisDataSource;
}

function readTransportSelector(): 'stdio' | 'http' {
    const raw = process.env.MCP_TRANSPORT ?? TRANSPORT_STDIO;

    if (raw === TRANSPORT_STDIO || raw === TRANSPORT_HTTP) {
        return raw;
    }
    throw new Error(`MCP_TRANSPORT must be '${TRANSPORT_STDIO}' or '${TRANSPORT_HTTP}' (got '${raw}')`);
}

interface IHttpBindConfig {
    readonly host: string;
    readonly allowNetworkBind: boolean;
}

function readHttpBindConfig(): IHttpBindConfig {
    const rawHost = process.env.MCP_HTTP_BIND_HOST;
    const rawAllow = process.env.MCP_HTTP_ALLOW_NETWORK_BIND;
    const host = rawHost === undefined || rawHost.length === 0 ? '127.0.0.1' : rawHost;
    const allowNetworkBind = rawAllow === '1' || rawAllow === 'true';

    if (host !== '127.0.0.1' && !allowNetworkBind) {
        throw new Error(`MCP_HTTP_BIND_HOST='${host}' requires MCP_HTTP_ALLOW_NETWORK_BIND=1 (compose-network opt-in)`);
    }

    return { host, allowNetworkBind };
}

function readHttpPort(): number {
    const raw = process.env.MCP_HTTP_PORT;

    if (raw === undefined || raw.length === 0) {
        return MCP_HTTP_DEFAULT_PORT;
    }
    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`MCP_HTTP_PORT must be an integer in [0, 65535] (got '${raw}')`);
    }

    return parsed;
}

function readAuthSecret(): Buffer {
    // M13 live-smoke gap #5: MCP must verify tokens signed by the engine. The
    // engine signs with HKDF-Expand(AUTH_HMAC_SECRET, 'auth v1', 32B) — see
    // apps/engine/src/auth/DerivedKeyService.ts. We read the same master env
    // var and derive the same sub-key so signatures verify.
    const raw = process.env.AUTH_HMAC_SECRET;

    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('AUTH_HMAC_SECRET must be set when MCP_TRANSPORT=http');
    }
    const master = Buffer.from(raw, 'utf8');

    if (master.byteLength < AUTH_MIN_SECRET_BYTES) {
        throw new Error(`AUTH_HMAC_SECRET must be >= ${AUTH_MIN_SECRET_BYTES} bytes (got ${master.byteLength})`);
    }

    return deriveAuthKey(master);
}

/**
 * Adapter from analysis TypeORM DataSource to the verifier's
 * IRevokedJtiChecker port. SELECT-only; mcp_reader has SELECT on revoked_jti
 * (ADR 0038 §3.1 amendment to ADR 0034 §2.5).
 */
/** Minimal structural shape required from the DataSource for revocation SELECT. */
interface IQueryRunner {
    query(sql: string, params?: unknown[]): Promise<unknown>;
}

function buildRevokedJtiChecker(ds: IQueryRunner): IRevokedJtiChecker {
    return {
        isRevoked: async (jti: string): Promise<boolean> => {
            const rows = (await ds.query('SELECT 1 FROM revoked_jti WHERE jti = $1 LIMIT 1', [jti])) as unknown[];

            return Array.isArray(rows) && rows.length > 0;
        },
    };
}

function buildSdkServer(registry: ToolRegistry): Server {
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: registry.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: rawArgs } = request.params;
        try {
            const result = await registry.callTool(name, rawArgs ?? {});

            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result as Record<string, unknown>,
            };
        } catch (err) {
            if (err instanceof McpToolError) {
                logError(`tool '${name}' failed [${err.kind}]: ${err.message}`, err.getInternalCause());

                return err.toToolResult();
            }
            logError(`tool '${name}' threw unexpected error`, err);

            return McpToolError.internal('Unexpected internal error').toToolResult();
        }
    });

    return server;
}

async function buildRuntime(): Promise<IMcpRuntime> {
    const registry = new ToolRegistry();

    const dataSource = createMcpDataSource();
    await dataSource.initialize();
    logInfo('analysis DataSource initialized');

    registerAllTools(registry, dataSource);

    const transportName = readTransportSelector();
    const server = buildSdkServer(registry);

    if (transportName === TRANSPORT_HTTP) {
        const authSecret = readAuthSecret();
        const port = readHttpPort();
        const bind = readHttpBindConfig();
        const revoked = buildRevokedJtiChecker(dataSource);
        const httpTransport = await startHttpTransport({
            registry,
            authSecret,
            revoked,
            port,
            bindHost: bind.host,
            allowNetworkBind: bind.allowNetworkBind,
        });
        logInfo(`http transport listening on ${bind.host}:${httpTransport.port} — ${registry.listTools().length} tools`);

        return { server, stdioTransport: null, httpTransport, dataSource };
    }

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    logInfo(`stdio transport connected — listing ${registry.listTools().length} tools`);

    return { server, stdioTransport, httpTransport: null, dataSource };
}

async function shutdown(runtime: IMcpRuntime | null, signal: string, exitCode: number): Promise<void> {
    logInfo(`received ${signal}, shutting down`);
    if (runtime !== null) {
        if (runtime.httpTransport !== null) {
            try {
                await runtime.httpTransport.close();
            } catch (err) {
                logError('failed to close HTTP transport', err);
            }
        }
        try {
            await runtime.server.close();
        } catch (err) {
            logError('failed to close MCP server', err);
        }
        try {
            if (runtime.dataSource.isInitialized) {
                await runtime.dataSource.destroy();
            }
        } catch (err) {
            logError('failed to destroy analysis DataSource', err);
        }
    }
    process.exit(exitCode);
}

async function main(): Promise<void> {
    // Layer C boundary guard — runs BEFORE any tool registration, BEFORE
    // any DB connection. If engine modules slipped in, we exit immediately.
    runBoundaryGuard();

    let runtime: IMcpRuntime | null = null;

    const installSignalHandler = (signal: NodeJS.Signals): void => {
        process.on(signal, () => {
            void shutdown(runtime, signal, 0);
        });
    };
    installSignalHandler('SIGINT');
    installSignalHandler('SIGTERM');

    try {
        runtime = await buildRuntime();
        logInfo(`${SERVER_NAME}@${SERVER_VERSION} ready`);
    } catch (err) {
        logError('boot failed', err);
        await shutdown(runtime, 'boot-failure', 1);
    }
}

void main();
