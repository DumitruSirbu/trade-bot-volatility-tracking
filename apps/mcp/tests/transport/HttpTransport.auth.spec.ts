// M13 W1.B (ADR 0038 §2.2) — bearer-auth + JSON-RPC dispatch acceptance suite.
//
// The transport must reject: missing header, bad signature, expired token,
// wrong audience, revoked jti. A valid `aud=mcp` token must list the tools
// registered on the shared ToolRegistry. The pg client is mocked via the
// IRevokedJtiChecker port; the ToolRegistry is stubbed to a single tool.

import { createHmac } from 'crypto';
import { request } from 'http';
import { AuthFailureReasonEnum } from '@bot/shared';
import { z } from 'zod';

import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { IHttpTransportHandle, startHttpTransport } from '../../src/transport/HttpTransport';
import { IRevokedJtiChecker, MCP_AUTH_HS256_HEADER_B64URL } from '../../src/transport/bearerVerifier';

const SECRET = Buffer.alloc(32, 0x11);

function base64UrlEncode(buf: Buffer | string): string {
    const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;

    return b.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

interface IPayload {
    sub: string;
    jti: string;
    aud: string;
    exp: number;
}

function mintToken(payload: IPayload, secretOverride?: Buffer): string {
    const headerSeg = MCP_AUTH_HS256_HEADER_B64URL;
    const payloadSeg = base64UrlEncode(JSON.stringify(payload));
    const headerAndPayload = `${headerSeg}.${payloadSeg}`;
    const sig = createHmac('sha256', secretOverride ?? SECRET)
        .update(headerAndPayload)
        .digest();
    const sigSeg = sig.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');

    return `${headerAndPayload}.${sigSeg}`;
}

interface IRpcResponse {
    status: number;
    body: { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code: number; message: string; data?: { reason?: string; kind?: string } } };
}

function postJsonRpc(port: number, body: object, bearer: string | null): Promise<IRpcResponse> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
        };
        if (bearer !== null) {
            headers.authorization = `Bearer ${bearer}`;
        }
        const req = request({ host: '127.0.0.1', port, path: '/jsonrpc', method: 'POST', headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? {} : JSON.parse(text) });
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;
const PAST_EXP = Math.floor(Date.now() / 1000) - 60;

describe('HttpTransport bearer auth', () => {
    let handle: IHttpTransportHandle;
    let revokedSet: Set<string>;
    let revokedChecker: IRevokedJtiChecker;

    beforeEach(async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'ping',
            description: 'returns ok',
            paramsSchema: z.object({}).strict(),
            inputJsonSchema: { type: 'object', properties: {} },
            handler: async () => ({ ok: true }),
        });
        revokedSet = new Set();
        revokedChecker = { isRevoked: async (jti: string) => revokedSet.has(jti) };
        handle = await startHttpTransport({ registry, authSecret: SECRET, revoked: revokedChecker, port: 0 });
    });

    afterEach(async () => {
        await handle.close();
    });

    it('rejects requests with no Authorization header (-32000 MISSING)', async () => {
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        expect(res.body.error?.message).toBe('AUTH_FAILED');
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.MISSING);
    });

    it('rejects tokens with a bad signature (-32000 BAD_SIGNATURE)', async () => {
        const wrongKey = Buffer.alloc(32, 0x99);
        const tok = mintToken({ sub: 'agent', jti: 'jti-1', aud: 'mcp', exp: FUTURE_EXP }, wrongKey);
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
    });

    it('rejects expired tokens (-32000 EXPIRED)', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'jti-2', aud: 'mcp', exp: PAST_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.EXPIRED);
    });

    it('rejects tokens with wrong audience (-32000 BAD_SCOPE — pending shared BAD_AUDIENCE)', async () => {
        const tok = mintToken({ sub: 'op', jti: 'jti-3', aud: 'engine', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.BAD_SCOPE);
    });

    it('rejects revoked jti (-32000 REVOKED)', async () => {
        revokedSet.add('jti-4');
        const tok = mintToken({ sub: 'agent', jti: 'jti-4', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.REVOKED);
    });

    it('returns 401 MALFORMED when the revoked-jti checker throws (e.g. DB permission error)', async () => {
        // Simulate the M13 live-smoke gap: `SELECT 1 FROM revoked_jti ...`
        // throws `permission denied for table revoked_jti` because the
        // mcp_reader role lacks SELECT. The transport must still fail
        // closed (401) but ALSO log the underlying error class + message
        // to stderr so the operator can diagnose the missing GRANT.
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

        class PermissionDeniedError extends Error {
            constructor() {
                super('permission denied for table revoked_jti');
                this.name = 'PermissionDeniedError';
            }
        }

        await handle.close();
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'ping',
            description: 'returns ok',
            paramsSchema: z.object({}).strict(),
            inputJsonSchema: { type: 'object', properties: {} },
            handler: async () => ({ ok: true }),
        });
        const throwingChecker: IRevokedJtiChecker = {
            isRevoked: async (): Promise<boolean> => {
                throw new PermissionDeniedError();
            },
        };
        handle = await startHttpTransport({ registry, authSecret: SECRET, revoked: throwingChecker, port: 0 });

        const tok = mintToken({ sub: 'agent', jti: 'jti-db-fail', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 99, method: 'tools/list' }, tok);

        expect(res.status).toBe(401);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.MALFORMED);

        const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(logged).toContain('[mcp] ERROR auth check failed unexpectedly');
        expect(logged).toContain('PermissionDeniedError');
        expect(logged).toContain('permission denied for table revoked_jti');

        stderrSpy.mockRestore();
    });

    it('accepts a valid aud=mcp token and returns the registered tool list', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'jti-5', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, tok);
        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        const result = res.body.result as { tools: Array<{ name: string }> };
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].name).toBe('ping');
    });
});
