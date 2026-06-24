// M13 W6a — Vector 5: MCP HTTP transport spoofing (ADR 0038 §2.2).
//
// Extends the existing HttpTransport.auth.spec.ts with adversarial scenarios
// that specifically target the claim-level attack surface:
//   [A] Token with aud='engine' (wrong audience) → -32000 (BAD_AUDIENCE).
//   [B] Token signed with a different HS256 key → -32000 (BAD_SIGNATURE).
//   [C] Revoked JTI present in revoked_jti store → -32000 (REVOKED).
//   [D] Loopback bind: connecting to 127.0.0.1 from the test process works;
//       assert that the server is NOT addressable on 0.0.0.0. If connecting
//       from a non-loopback source IP is not feasible on the test platform,
//       skip with a clear message — the loopback bind is the structural guarantee.
//   [E] Tool not present in the registry → JSON-RPC -32001 (INTERNAL_ERROR
//       because callTool throws McpToolError.NOT_FOUND which maps to -32001).
//
// The transport is started with port=0 (ephemeral) for isolation.

import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';
import { AuthFailureReasonEnum } from '@bot/shared';

import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { startHttpTransport, IHttpTransportHandle } from '../../src/transport/HttpTransport';
import { IRevokedJtiChecker, MCP_AUTH_HS256_HEADER_B64URL } from '../../src/transport/bearerVerifier';

// ---------------------------------------------------------------------------
// Token utilities (mirrored from HttpTransport.auth.spec.ts — kept local to
// avoid shared-fixture coupling that violates F.I.R.S.T. independence).
// ---------------------------------------------------------------------------

const CORRECT_SECRET = Buffer.alloc(32, 0xaa);
const WRONG_SECRET = Buffer.alloc(32, 0xbb);

function base64UrlEncode(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

interface IPayload {
    sub: string;
    jti: string;
    aud: string;
    exp: number;
}

function mintToken(payload: IPayload, secret: Buffer = CORRECT_SECRET): string {
    const headerSeg = MCP_AUTH_HS256_HEADER_B64URL;
    const payloadSeg = base64UrlEncode(JSON.stringify(payload));
    const toSign = `${headerSeg}.${payloadSeg}`;
    const sig = createHmac('sha256', secret).update(toSign).digest();
    const sigSeg = sig.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
    return `${toSign}.${sigSeg}`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 7200;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface IRpcResponse {
    status: number;
    body: {
        jsonrpc?: string;
        id?: unknown;
        result?: unknown;
        error?: { code: number; message: string; data?: { reason?: string; kind?: string } };
    };
}

function postJsonRpc(port: number, body: object, bearer: string | null, host = '127.0.0.1'): Promise<IRpcResponse> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
        };
        if (bearer !== null) {
            headers.authorization = `Bearer ${bearer}`;
        }
        const req = request({ host, port, path: '/jsonrpc', method: 'POST', headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
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

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('HttpTransport — adversarial transport spoofing (M13 W6a vector 5)', () => {
    let handle: IHttpTransportHandle;
    let revokedSet: Set<string>;
    let revokedChecker: IRevokedJtiChecker;
    let registry: ToolRegistry;

    beforeEach(async () => {
        registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'echo',
            description: 'echoes the input',
            paramsSchema: z.object({ msg: z.string() }).strict(),
            inputJsonSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            handler: async (params: { msg: string }) => ({ echoed: params.msg }),
        });
        revokedSet = new Set();
        revokedChecker = { isRevoked: async (jti) => revokedSet.has(jti) };
        handle = await startHttpTransport({
            registry,
            authSecret: CORRECT_SECRET,
            revoked: revokedChecker,
            port: 0,
        });
    });

    afterEach(async () => {
        await handle.close();
    });

    // [A] Wrong audience
    it('[A] token with aud=engine (wrong audience) is rejected with -32000', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'spoof-aud-1', aud: 'engine', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        // M45 D5: an audience-allowlist miss now maps to the dedicated BAD_AUDIENCE reason (ADR 0038 §2.2).
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.BAD_AUDIENCE);
    });

    it('[A] token with aud=dashboard (wrong audience) is rejected with -32000', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'spoof-aud-2', aud: 'dashboard', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
    });

    // [B] Wrong signing key
    it('[B] token signed with a different HS256 key is rejected with -32000 BAD_SIGNATURE', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'spoof-sig-1', aud: 'mcp', exp: FUTURE_EXP }, WRONG_SECRET);
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
    });

    it('[B] token with tampered payload (valid-key signature but wrong payload) is rejected', async () => {
        // Sign with correct key but build the signature over a different payload string.
        const headerSeg = MCP_AUTH_HS256_HEADER_B64URL;
        const realPayload = base64UrlEncode(JSON.stringify({ sub: 'agent', jti: 'spoof-tamper', aud: 'mcp', exp: FUTURE_EXP }));
        const tamperedPayload = base64UrlEncode(JSON.stringify({ sub: 'hacker', jti: 'spoof-tamper', aud: 'mcp', exp: FUTURE_EXP }));
        // Sign the real payload, then swap in the tampered payload segment.
        const sig = createHmac('sha256', CORRECT_SECRET).update(`${headerSeg}.${realPayload}`).digest();
        const sigSeg = sig.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
        const tamperedToken = `${headerSeg}.${tamperedPayload}.${sigSeg}`;
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, tamperedToken);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
    });

    // [C] Revoked JTI
    it('[C] revoked JTI is rejected with -32000 REVOKED', async () => {
        const jti = 'spoof-revoked-jti-42';
        revokedSet.add(jti);
        const tok = mintToken({ sub: 'agent', jti, aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, tok);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe(-32000);
        expect(res.body.error?.data?.reason).toBe(AuthFailureReasonEnum.REVOKED);
    });

    it('[C] same JTI used after revocation is rejected even with valid signature', async () => {
        const jti = 'spoof-revoked-jti-43';
        // First use succeeds.
        const tok = mintToken({ sub: 'agent', jti, aud: 'mcp', exp: FUTURE_EXP });
        const first = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, tok);
        expect(first.body.error?.code).toBeUndefined();

        // Now revoke and retry.
        revokedSet.add(jti);
        const second = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, tok);
        expect(second.status).toBe(401);
        expect(second.body.error?.code).toBe(-32000);
        expect(second.body.error?.data?.reason).toBe(AuthFailureReasonEnum.REVOKED);
    });

    // [D] Loopback bind assertion
    it('[D] server is reachable via 127.0.0.1 with a valid token', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'bind-test-1', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, tok, '127.0.0.1');
        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
    });

    it('[D] server bound address is 127.0.0.1, not 0.0.0.0', () => {
        const addr = handle.server.address();
        const boundAddr = typeof addr === 'object' && addr !== null ? addr.address : null;
        expect(boundAddr).toBe('127.0.0.1');
    });

    // Connecting from a non-loopback source is an OS-level restriction we cannot
    // easily simulate in unit tests (requires network namespace manipulation or
    // a remote process). The loopback bind is the structural guarantee. We document
    // this as a clear skip with the reason rather than a failing assertion.
    it('[D] connecting from 127.0.0.2 — skipped (requires OS-level non-loopback source control)', () => {
        // This is a documented limitation: testing that a non-loopback source IP is
        // refused requires either a Docker network namespace or a separate host process.
        // The loopback bind (127.0.0.1) is enforced structurally by startHttpTransport,
        // which throws if the OS binds to anything other than MCP_HTTP_LOOPBACK_ADDRESS.
        // No assertion is possible in-process; the structural guarantee suffices.
        expect(true).toBe(true); // placeholder to document the deliberate skip
    });

    // [E] Tool not in registry
    it('[E] calling a tool not in the registry returns -32001 (INTERNAL_ERROR / NOT_FOUND)', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'notfound-tool-1', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(
            handle.port,
            {
                jsonrpc: '2.0',
                id: 9,
                method: 'tools/call',
                params: { name: 'nonexistent_tool', arguments: {} },
            },
            tok,
        );
        expect(res.status).toBe(200);
        // ToolRegistry.callTool throws McpToolError.NOT_FOUND → dispatch maps to JSONRPC_INTERNAL_ERROR (-32001).
        expect(res.body.error?.code).toBe(-32001);
        expect(res.body.error?.data?.kind).toBe('NOT_FOUND');
    });

    it('[E] calling a non-existent method (not tools/call or tools/list) returns -32601', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'notfound-method-1', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 10, method: 'tools/delete', params: { name: 'echo' } }, tok);
        expect(res.status).toBe(200);
        expect(res.body.error?.code).toBe(-32601);
    });

    // Boundary: missing tools/call params.name → invalid request
    it('tools/call without params.name returns -32600', async () => {
        const tok = mintToken({ sub: 'agent', jti: 'noname-1', aud: 'mcp', exp: FUTURE_EXP });
        const res = await postJsonRpc(handle.port, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} }, tok);
        expect(res.status).toBe(200);
        expect(res.body.error?.code).toBe(-32600);
    });
});
