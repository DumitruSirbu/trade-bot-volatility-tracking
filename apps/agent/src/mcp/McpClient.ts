// M13 W1.D — Agent-side MCP JSON-RPC client (ADR 0035 §2.5, ADR 0038).
//
// Network-only contact with `apps/mcp` over loopback HTTP + Bearer auth. Every
// response is validated through a Zod schema (see `./schemas.ts`); no MCP
// internals are imported. `McpClientError` is the single failure surface for
// transport errors, JSON-RPC error envelopes, and schema-parse failures so
// callers can branch on `kind` without parsing error strings.

import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { z } from 'zod';

import {
    BacktestReportSchema,
    type BacktestReportParsed,
    GetDecisionsResultSchema,
    type GetDecisionsResultParsed,
    HaltStateViewSchema,
    type HaltStateViewParsed,
    ListPositionsResultSchema,
    type ListPositionsResultParsed,
    PerformanceByVersionViewSchema,
    type PerformanceByVersionViewParsed,
    VersionComparisonResultSchema,
    type VersionComparisonResultParsed,
} from './schemas.js';

const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;
const RUN_BACKTEST_SOCKET_TIMEOUT_MS = 10 * 60_000 + 30_000;

export type McpClientErrorKind = 'TRANSPORT' | 'TIMEOUT' | 'HTTP_STATUS' | 'INVALID_RESPONSE' | 'RPC_ERROR' | 'SCHEMA_PARSE';

export class McpClientError extends Error {
    public readonly kind: McpClientErrorKind;
    public readonly tool: string;
    public readonly cause?: unknown;

    constructor(kind: McpClientErrorKind, tool: string, message: string, cause?: unknown) {
        super(`[mcp:${tool}] ${kind}: ${message}`);
        this.name = 'McpClientError';
        this.kind = kind;
        this.tool = tool;
        this.cause = cause;
    }
}

export interface IGetPerformanceArgs {
    readonly versionId: number;
    readonly from: string;
    readonly to: string;
    readonly acknowledgedLargeRange?: boolean;
}

export interface ICompareVersionsArgs {
    readonly aVersionId: number;
    readonly bVersionId: number;
    readonly from: string;
    readonly to: string;
    readonly acknowledgedLargeRange?: boolean;
}

export interface IListPositionsArgs {
    readonly from: string;
    readonly to: string;
    readonly symbol?: string;
    readonly versionId?: number;
    readonly status?: 'open' | 'closed';
    readonly cursor?: string;
    readonly limit?: number;
}

export interface IGetDecisionsArgs {
    readonly symbol: string;
    readonly from: string;
    readonly to: string;
    readonly includeSnapshot?: boolean;
}

export interface IRunBacktestArgs {
    readonly versionId: number;
    readonly from: string;
    readonly to: string;
}

interface IJsonRpcSuccess {
    readonly jsonrpc: '2.0';
    readonly id: number | string | null;
    readonly result: unknown;
}

interface IJsonRpcFailure {
    readonly jsonrpc: '2.0';
    readonly id: number | string | null;
    readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class McpClient {
    private readonly baseUrl: URL;
    private readonly bearer: string;
    private readonly agent: HttpAgent | HttpsAgent;
    private readonly requestFn: typeof httpRequest;
    private nextRpcId = 1;

    constructor(baseUrl: string, bearer: string) {
        if (bearer.length === 0) {
            throw new Error('McpClient: bearer must be non-empty');
        }
        this.baseUrl = new URL(baseUrl);
        this.bearer = bearer;
        const isHttps = this.baseUrl.protocol === 'https:';
        this.agent = isHttps ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
        this.requestFn = isHttps ? (httpsRequest as unknown as typeof httpRequest) : httpRequest;
    }

    public async getPerformance(args: IGetPerformanceArgs): Promise<PerformanceByVersionViewParsed> {
        return this.callTool('get_performance', args, PerformanceByVersionViewSchema, DEFAULT_SOCKET_TIMEOUT_MS);
    }

    public async compareVersions(args: ICompareVersionsArgs): Promise<VersionComparisonResultParsed> {
        return this.callTool('compare_versions', args, VersionComparisonResultSchema, DEFAULT_SOCKET_TIMEOUT_MS);
    }

    public async listPositions(args: IListPositionsArgs): Promise<ListPositionsResultParsed> {
        return this.callTool('list_positions', args, ListPositionsResultSchema, DEFAULT_SOCKET_TIMEOUT_MS);
    }

    public async getDecisions(args: IGetDecisionsArgs): Promise<GetDecisionsResultParsed> {
        return this.callTool('get_decisions', args, GetDecisionsResultSchema, DEFAULT_SOCKET_TIMEOUT_MS);
    }

    public async runBacktest(args: IRunBacktestArgs): Promise<BacktestReportParsed> {
        return this.callTool('run_backtest', args, BacktestReportSchema, RUN_BACKTEST_SOCKET_TIMEOUT_MS);
    }

    public async getHaltState(): Promise<HaltStateViewParsed> {
        return this.callTool('get_halt_state', {}, HaltStateViewSchema, DEFAULT_SOCKET_TIMEOUT_MS);
    }

    public destroy(): void {
        this.agent.destroy();
    }

    private async callTool<S extends z.ZodTypeAny>(toolName: string, args: unknown, schema: S, timeoutMs: number): Promise<z.infer<S>> {
        const envelope = await this.sendRpc(toolName, args, timeoutMs);
        const structured = extractStructuredContent(envelope.result);
        if (structured === undefined) {
            throw new McpClientError('INVALID_RESPONSE', toolName, 'response missing structuredContent');
        }
        const parsed = schema.safeParse(structured);
        if (!parsed.success) {
            throw new McpClientError('SCHEMA_PARSE', toolName, parsed.error.message, parsed.error);
        }
        return parsed.data;
    }

    private async sendRpc(toolName: string, args: unknown, timeoutMs: number): Promise<IJsonRpcSuccess> {
        const id = this.nextRpcId++;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
        });
        const raw = await this.transportRequest(toolName, body, timeoutMs);
        const envelope = parseRpcEnvelope(toolName, raw);
        if ('error' in envelope) {
            throw new McpClientError('RPC_ERROR', toolName, envelope.error.message, envelope.error);
        }
        return envelope;
    }

    private transportRequest(toolName: string, body: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = this.requestFn(
                {
                    method: 'POST',
                    protocol: this.baseUrl.protocol,
                    hostname: this.baseUrl.hostname,
                    port: this.baseUrl.port,
                    path: '/jsonrpc',
                    agent: this.agent,
                    headers: {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(body).toString(),
                        authorization: `Bearer ${this.bearer}`,
                    },
                },
                (res: IncomingMessage) => collectResponseBody(toolName, res, resolve, reject),
            );
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new McpClientError('TIMEOUT', toolName, `socket timeout after ${timeoutMs}ms`));
            });
            req.on('error', (err) => reject(new McpClientError('TRANSPORT', toolName, err.message, err)));
            req.write(body);
            req.end();
        });
    }
}

function collectResponseBody(toolName: string, res: IncomingMessage, resolve: (s: string) => void, reject: (e: McpClientError) => void): void {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
            resolve(text);
            return;
        }
        // 401/4xx with a JSON-RPC envelope is handled by the envelope parser.
        if (text.length > 0 && text.startsWith('{')) {
            resolve(text);
            return;
        }
        reject(new McpClientError('HTTP_STATUS', toolName, `unexpected HTTP ${status}: ${text.slice(0, 256)}`));
    });
    res.on('error', (err) => reject(new McpClientError('TRANSPORT', toolName, err.message, err)));
}

function parseRpcEnvelope(toolName: string, raw: string): IJsonRpcSuccess | IJsonRpcFailure {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new McpClientError('INVALID_RESPONSE', toolName, 'response body is not JSON', err);
    }
    if (parsed === null || typeof parsed !== 'object') {
        throw new McpClientError('INVALID_RESPONSE', toolName, 'response is not an object');
    }
    const v = parsed as Record<string, unknown>;
    if (v.jsonrpc !== '2.0') {
        throw new McpClientError('INVALID_RESPONSE', toolName, 'missing jsonrpc=2.0 field');
    }
    const id = v.id as number | string | null;
    if ('error' in v && v.error !== undefined) {
        const error = v.error as IJsonRpcFailure['error'];
        return { jsonrpc: '2.0', id, error };
    }
    if ('result' in v) {
        return { jsonrpc: '2.0', id, result: v.result };
    }
    throw new McpClientError('INVALID_RESPONSE', toolName, 'envelope has neither result nor error');
}

function extractStructuredContent(result: unknown): unknown {
    if (result === null || typeof result !== 'object') {
        return undefined;
    }
    const r = result as Record<string, unknown>;
    return r.structuredContent;
}
