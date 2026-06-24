/**
 * bearerVerifier — M45 D5 adversarial unit tests (E1).
 *
 * Coverage:
 *   E1 — verifyBearer throws BearerVerificationError with reason BAD_AUDIENCE
 *        (not BAD_SCOPE) when the token's `aud` claim does not match 'mcp'.
 *
 * This is a direct unit test of the verifier function, decoupled from the HTTP
 * transport layer. The transport-spoofing integration test (transport-spoofing.spec.ts)
 * covers the same path end-to-end; this test asserts the specific thrown value
 * in isolation so a regression in the reason mapping surfaces immediately.
 */

import { createHmac } from 'node:crypto';
import { AuthFailureReasonEnum } from '@bot/shared';

import { BearerVerificationError, IRevokedJtiChecker, MCP_AUTH_HS256_HEADER_B64URL, verifyBearer } from '../../src/transport/bearerVerifier';

// ─── token utilities ──────────────────────────────────────────────────────────

const TEST_SECRET = Buffer.alloc(32, 0xcc);

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

function mintToken(payload: IPayload, secret: Buffer = TEST_SECRET): string {
    const headerSeg = MCP_AUTH_HS256_HEADER_B64URL;
    const payloadSeg = base64UrlEncode(JSON.stringify(payload));
    const toSign = `${headerSeg}.${payloadSeg}`;
    const sig = createHmac('sha256', secret).update(toSign).digest();
    const sigSeg = sig.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
    return `${toSign}.${sigSeg}`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 7200;

const noopRevoked: IRevokedJtiChecker = {
    isRevoked: async () => false,
};

// ─── E1: wrong audience → BAD_AUDIENCE (not BAD_SCOPE) ───────────────────────

describe('bearerVerifier M45 D5 — E1: wrong audience emits BAD_AUDIENCE reason', () => {
    it('throws BearerVerificationError with reason BAD_AUDIENCE when aud=engine', async () => {
        const token = mintToken({ sub: 'agent', jti: 'm45-e1-a', aud: 'engine', exp: FUTURE_EXP });

        await expect(verifyBearer(token, TEST_SECRET, noopRevoked, new Date())).rejects.toThrow(BearerVerificationError);

        let caught: BearerVerificationError | undefined;
        try {
            await verifyBearer(token, TEST_SECRET, noopRevoked, new Date());
        } catch (err) {
            caught = err as BearerVerificationError;
        }

        expect(caught).toBeDefined();
        expect(caught!.reason).toBe(AuthFailureReasonEnum.BAD_AUDIENCE);
    });

    it('the BAD_AUDIENCE reason is not BAD_SCOPE (regression: was overloading BAD_SCOPE before M45)', async () => {
        const token = mintToken({ sub: 'agent', jti: 'm45-e1-b', aud: 'engine', exp: FUTURE_EXP });

        let caught: BearerVerificationError | undefined;
        try {
            await verifyBearer(token, TEST_SECRET, noopRevoked, new Date());
        } catch (err) {
            caught = err as BearerVerificationError;
        }

        expect(caught).toBeDefined();
        // Explicit regression guard: must NOT be BAD_SCOPE
        expect(caught!.reason).not.toBe(AuthFailureReasonEnum.BAD_SCOPE);
        expect(caught!.reason).toBe(AuthFailureReasonEnum.BAD_AUDIENCE);
    });

    it('throws BAD_AUDIENCE when aud=dashboard (any non-mcp audience is rejected)', async () => {
        const token = mintToken({ sub: 'agent', jti: 'm45-e1-c', aud: 'dashboard', exp: FUTURE_EXP });

        let caught: BearerVerificationError | undefined;
        try {
            await verifyBearer(token, TEST_SECRET, noopRevoked, new Date());
        } catch (err) {
            caught = err as BearerVerificationError;
        }

        expect(caught).toBeDefined();
        expect(caught!.reason).toBe(AuthFailureReasonEnum.BAD_AUDIENCE);
    });

    it('does NOT throw BAD_AUDIENCE when aud=mcp (correct audience passes the check)', async () => {
        const token = mintToken({ sub: 'agent', jti: 'm45-e1-d', aud: 'mcp', exp: FUTURE_EXP });

        // Should resolve without throwing (or throw with a different reason if JTI is revoked etc.)
        // Since noopRevoked always returns false, the token should verify cleanly.
        const result = await verifyBearer(token, TEST_SECRET, noopRevoked, new Date());

        expect(result.aud).toBe('mcp');
        expect(result.sub).toBe('agent');
    });

    it('throws BearerVerificationError not a generic Error on audience mismatch', async () => {
        const token = mintToken({ sub: 'agent', jti: 'm45-e1-e', aud: 'wrong', exp: FUTURE_EXP });

        let caught: unknown;
        try {
            await verifyBearer(token, TEST_SECRET, noopRevoked, new Date());
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(BearerVerificationError);
    });
});
