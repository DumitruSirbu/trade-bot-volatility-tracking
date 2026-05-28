// M13 live-smoke gap #5 — paired test for the MCP-side HKDF derivation.
//
// Cross-process contract: the engine's DerivedKeyService computes
//   HKDF-SHA256(master, salt=empty, info='auth v1', L=32)
// and signs JWTs with the resulting buffer. MCP must derive byte-identical
// bytes so engine-minted bearers verify here.

import { createHmac, hkdfSync } from 'node:crypto';

import { AuthFailureReasonEnum } from '@bot/shared';

import { verifyBearer, IRevokedJtiChecker, MCP_AUTH_HS256_HEADER_B64URL } from '../../src/transport/bearerVerifier';
import { deriveAuthKey } from '../../src/transport/deriveAuthKey';

function base64UrlEncode(buf: Buffer | string): string {
    const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;

    return b.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function mintToken(payload: object, key: Buffer): string {
    const payloadSeg = base64UrlEncode(JSON.stringify(payload));
    const headerAndPayload = `${MCP_AUTH_HS256_HEADER_B64URL}.${payloadSeg}`;
    const sig = createHmac('sha256', key).update(headerAndPayload).digest();
    const sigSeg = sig.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');

    return `${headerAndPayload}.${sigSeg}`;
}

const NEVER_REVOKED: IRevokedJtiChecker = { isRevoked: async () => false };

describe('deriveAuthKey', () => {
    it('produces 32 bytes of HKDF-SHA256 output matching the engine algorithm', () => {
        const master = 'test-master-secret-at-least-32-bytes-long';
        const derived = deriveAuthKey(master);
        const expected = Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), Buffer.from('auth v1', 'utf8'), 32));

        expect(derived.byteLength).toBe(32);
        expect(derived.equals(expected)).toBe(true);
    });

    it('is deterministic — same master yields the same key', () => {
        const master = 'deterministic-master-deterministic-master';
        const a = deriveAuthKey(master);
        const b = deriveAuthKey(master);

        expect(a.equals(b)).toBe(true);
    });

    it('accepts a Buffer master and a string master interchangeably', () => {
        const master = 'buffer-vs-string-master-buffer-vs-string';
        const fromStr = deriveAuthKey(master);
        const fromBuf = deriveAuthKey(Buffer.from(master, 'utf8'));

        expect(fromStr.equals(fromBuf)).toBe(true);
    });

    it('different masters produce different derived keys', () => {
        const a = deriveAuthKey('master-A-master-A-master-A-master-A');
        const b = deriveAuthKey('master-B-master-B-master-B-master-B');

        expect(a.equals(b)).toBe(false);
    });

    it('verifies a token signed with deriveAuthKey(master) end-to-end', async () => {
        const key = deriveAuthKey('engine-and-mcp-shared-master-secret-32+');
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const token = mintToken({ sub: 'agent', jti: 'jti-ok', aud: 'mcp', exp }, key);

        const verified = await verifyBearer(token, key, NEVER_REVOKED, new Date());

        expect(verified.sub).toBe('agent');
        expect(verified.aud).toBe('mcp');
        expect(verified.jti).toBe('jti-ok');
    });

    it('a token signed under a different master fails with BAD_SIGNATURE', async () => {
        const signingKey = deriveAuthKey('engine-master-engine-master-engine-master');
        const verifyingKey = deriveAuthKey('mcp-master-mcp-master-mcp-master-mcp-mast');
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const token = mintToken({ sub: 'agent', jti: 'jti-x', aud: 'mcp', exp }, signingKey);

        await expect(verifyBearer(token, verifyingKey, NEVER_REVOKED, new Date())).rejects.toMatchObject({
            reason: AuthFailureReasonEnum.BAD_SIGNATURE,
        });
    });
});
