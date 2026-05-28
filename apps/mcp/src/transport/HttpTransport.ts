// M13 W1.B (ADR 0038) — localhost HTTP JSON-RPC transport for the MCP server.
//
// Defense-in-depth properties (ADR 0038 §2.1 + §2.2):
//   - Default bind is `127.0.0.1`. Asserted at boot + by
//     `tests/transport/HttpTransport.bind-address.spec.ts`.
//   - Compose-network use case (M13 live-smoke): when running inside the
//     docker-compose private network, the agent container needs to reach
//     `bot-mcp` over service-DNS — which requires the listener to bind to
//     `0.0.0.0` ON THE CONTAINER NETWORK NAMESPACE (the compose network IS
//     the protection boundary, not host loopback). This is gated by an
//     explicit opt-in: callers must set `bindHost` to a non-loopback address
//     AND set `allowNetworkBind: true`. Without the opt-in, any non-loopback
//     bind is rejected — preserving ADR 0038 §2.1 for every other call site.
//   - Every JSON-RPC request requires a valid `aud=mcp` Bearer token. The
//     unauthenticated `/healthz` is the sole exception (compose health probe).
//   - All paths other than `POST /jsonrpc` + `GET /healthz` return 404.
//   - Tool dispatch goes through the SAME ToolRegistry instance as the stdio
//     transport — there is no separate write-capable code path.
//
// Boundary invariant: imports only node `http`, `@bot/shared`, and sibling
// MCP files. Zero edges to @bot/engine.

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AuthFailureReasonEnum } from '@bot/shared';

import { McpToolError } from '../errors/McpToolError.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { BearerVerificationError, IRevokedJtiChecker, verifyBearer } from './bearerVerifier.js';

/** Loopback bind address — never `0.0.0.0`, never an interface IP. */
export const MCP_HTTP_LOOPBACK_ADDRESS = '127.0.0.1';

/** Default port when `MCP_HTTP_PORT` is unset. */
export const MCP_HTTP_DEFAULT_PORT = 5434;

/** Cap on request body size (JSON-RPC requests are tiny). */
const MAX_REQUEST_BODY_BYTES = 1024 * 256;

/** JSON-RPC standard parse error. */
const JSONRPC_PARSE_ERROR = -32700;
/** JSON-RPC standard invalid request. */
const JSONRPC_INVALID_REQUEST = -32600;
/** JSON-RPC standard method-not-found. */
const JSONRPC_METHOD_NOT_FOUND = -32601;
/** Server-defined: auth failure. */
const JSONRPC_AUTH_FAILED = -32000;
/** Server-defined: tool error / internal error. */
const JSONRPC_INTERNAL_ERROR = -32001;

const BEARER_PREFIX = 'bearer ';

interface IJsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: unknown;
}

export interface IHttpTransportConfig {
    readonly registry: ToolRegistry;
    readonly authSecret: Buffer;
    readonly revoked: IRevokedJtiChecker;
    /** Defaults to MCP_HTTP_DEFAULT_PORT. Tests use 0 for ephemeral. */
    readonly port?: number;
    /** Defaults to `127.0.0.1`. Any non-loopback value requires `allowNetworkBind: true`. */
    readonly bindHost?: string;
    /**
     * Compose-network opt-in (M13 live-smoke). When true, `bindHost` may be a
     * non-loopback address (e.g. `0.0.0.0`). Caller is responsible for ensuring
     * the listener is reachable only via a private network boundary.
     */
    readonly allowNetworkBind?: boolean;
    /** Injectable clock for tests. */
    readonly clock?: () => Date;
}

export interface IHttpTransportHandle {
    readonly server: Server;
    readonly port: number;
    close(): Promise<void>;
}

/**
 * Start the HTTP transport. Returns a handle once the listener is bound and
 * has confirmed `127.0.0.1` as its address. Throws if the listener bound to
 * a non-loopback address (defense-in-depth against future config drift).
 */
export async function startHttpTransport(config: IHttpTransportConfig): Promise<IHttpTransportHandle> {
    const port = config.port ?? MCP_HTTP_DEFAULT_PORT;
    const clock = config.clock ?? ((): Date => new Date());
    const requestedHost = config.bindHost ?? MCP_HTTP_LOOPBACK_ADDRESS;
    const isLoopback = requestedHost === MCP_HTTP_LOOPBACK_ADDRESS;

    if (!isLoopback && config.allowNetworkBind !== true) {
        throw new Error(
            `HttpTransport refused to start: bindHost '${requestedHost}' is not loopback and allowNetworkBind is not set (compose-network use must opt in explicitly)`,
        );
    }

    const server = createServer((req, res) => {
        void handleRequest(req, res, config, clock).catch(() => {
            writeInternalError(res);
        });
    });

    await listen(server, port, requestedHost);

    const addr = server.address();
    const boundAddress = typeof addr === 'object' && addr !== null ? addr.address : null;

    if (isLoopback && boundAddress !== MCP_HTTP_LOOPBACK_ADDRESS) {
        await closeServer(server);
        throw new Error(`HttpTransport refused to start: listener bound to '${boundAddress ?? 'unknown'}' instead of '${MCP_HTTP_LOOPBACK_ADDRESS}'`);
    }

    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;

    return {
        server,
        port: boundPort,
        close: async (): Promise<void> => closeServer(server),
    };
}

function listen(server: Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: IHttpTransportConfig, clock: () => Date): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/healthz') {
        handleHealthz(res);

        return;
    }

    if (method !== 'POST' || url !== '/jsonrpc') {
        writeNotFound(res);

        return;
    }

    const authOk = await authenticateRequest(req, res, config, clock);

    if (!authOk) {
        return;
    }

    const rpc = await parseRpcBody(req, res);

    if (rpc === null) {
        return;
    }

    await dispatchRpc(res, rpc, config.registry);
}

function handleHealthz(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
}

function writeNotFound(res: ServerResponse): void {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
}

// Verifies the Bearer header against config. Writes an auth-failure response
// and returns false on any failure path. Returns true on success — the
// caller then proceeds to parse the body. The verified payload's `sub` claim
// is intentionally not returned to the transport (tools do not vary behaviour
// by subject in M13).
async function authenticateRequest(req: IncomingMessage, res: ServerResponse, config: IHttpTransportConfig, clock: () => Date): Promise<boolean> {
    const authHeader = req.headers.authorization;
    const tokenOrNull = extractBearer(typeof authHeader === 'string' ? authHeader : null);

    if (tokenOrNull === null) {
        writeAuthFailure(res, null, AuthFailureReasonEnum.MISSING);

        return false;
    }

    try {
        await verifyBearer(tokenOrNull, config.authSecret, config.revoked, clock());

        return true;
    } catch (err) {
        if (!(err instanceof BearerVerificationError)) {
            // Unexpected failure inside the verifier (e.g. DB error from the
            // revoked-jti checker). Log a structured stderr line so the
            // operator sees the underlying cause — every legitimate bearer
            // would otherwise be silently mislabelled as MALFORMED and the
            // root cause (e.g. missing GRANT) stays invisible. We deliberately
            // log the error class name + a clipped message only; no token,
            // no JTI, no payload — those are the secret material.
            const errAsError = err as Error;
            const errName = errAsError?.constructor?.name ?? 'UnknownError';
            const errMessage = (errAsError?.message ?? '').slice(0, 200);
            process.stderr.write(`[mcp] ERROR auth check failed unexpectedly (not a verifier error). reason=${errName} msg=${errMessage}\n`);
        }
        const reason = err instanceof BearerVerificationError ? err.reason : AuthFailureReasonEnum.MALFORMED;
        writeAuthFailure(res, null, reason);

        return false;
    }
}

// Reads + parses + validates the JSON-RPC envelope. Returns the typed request
// on success; writes the appropriate error response and returns null on any
// failure path so the caller can short-circuit cleanly.
async function parseRpcBody(req: IncomingMessage, res: ServerResponse): Promise<IJsonRpcRequest | null> {
    const rawBody = await readBody(req);

    if (rawBody === null) {
        writeJsonRpcError(res, null, JSONRPC_PARSE_ERROR, 'request body too large or unreadable');

        return null;
    }

    let rpc: IJsonRpcRequest;

    try {
        rpc = JSON.parse(rawBody) as IJsonRpcRequest;
    } catch {
        writeJsonRpcError(res, null, JSONRPC_PARSE_ERROR, 'invalid JSON');

        return null;
    }

    if (!isWellFormedRpc(rpc)) {
        writeJsonRpcError(res, null, JSONRPC_INVALID_REQUEST, 'malformed JSON-RPC envelope');

        return null;
    }

    return rpc;
}

async function dispatchRpc(res: ServerResponse, rpc: IJsonRpcRequest, registry: ToolRegistry): Promise<void> {
    if (rpc.method === 'tools/list') {
        const tools = registry.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        writeJsonRpcResult(res, rpc.id, { tools });

        return;
    }

    if (rpc.method === 'tools/call') {
        const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';

        if (name.length === 0) {
            writeJsonRpcError(res, rpc.id, JSONRPC_INVALID_REQUEST, 'tools/call requires params.name');

            return;
        }

        try {
            const result = await registry.callTool(name, params.arguments ?? {});
            writeJsonRpcResult(res, rpc.id, {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result as Record<string, unknown>,
            });
        } catch (err) {
            if (err instanceof McpToolError) {
                writeJsonRpcError(res, rpc.id, JSONRPC_INTERNAL_ERROR, err.message, { kind: err.kind });

                return;
            }
            writeJsonRpcError(res, rpc.id, JSONRPC_INTERNAL_ERROR, 'unexpected internal error');
        }

        return;
    }

    writeJsonRpcError(res, rpc.id, JSONRPC_METHOD_NOT_FOUND, `unknown method '${rpc.method}'`);
}

function isWellFormedRpc(value: unknown): value is IJsonRpcRequest {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const v = value as Record<string, unknown>;

    if (v.jsonrpc !== '2.0' || typeof v.method !== 'string') {
        return false;
    }

    const id = v.id;

    if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
        return false;
    }

    return true;
}

function extractBearer(header: string | null): string | null {
    if (header === null) {
        return null;
    }

    if (!header.toLowerCase().startsWith(BEARER_PREFIX)) {
        return null;
    }

    const token = header.slice(BEARER_PREFIX.length).trim();

    return token.length === 0 ? null : token;
}

function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
        let total = 0;
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_REQUEST_BODY_BYTES) {
                resolve(null);
                req.destroy();

                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => resolve(null));
    });
}

function writeAuthFailure(res: ServerResponse, id: string | number | null, reason: AuthFailureReasonEnum): void {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
        JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: JSONRPC_AUTH_FAILED, message: 'AUTH_FAILED', data: { reason } },
        }),
    );
}

function writeJsonRpcResult(res: ServerResponse, id: string | number | null, result: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function writeJsonRpcError(res: ServerResponse, id: string | number | null, code: number, message: string, data?: unknown): void {
    const status = code === JSONRPC_AUTH_FAILED ? 401 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }));
}

function writeInternalError(res: ServerResponse): void {
    if (res.headersSent) {
        res.end();

        return;
    }

    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_INTERNAL_ERROR, message: 'INTERNAL_ERROR' } }));
}
