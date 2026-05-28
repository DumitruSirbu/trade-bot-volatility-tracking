/**
 * M13 fix wave 7 — `aud` claim on engine-minted JWTs.
 *
 * Originally engine tokens omitted `aud` entirely, which silently broke the
 * M13 W1.B MCP bearer verifier (it requires `aud === 'mcp'`). Tests pin:
 *   - explicit `aud: 'mcp'` lands in the payload as `aud: 'mcp'`
 *   - omitted `aud` defaults to `'engine'`
 *   - empty-string `aud` defaults to `'engine'`
 *   - verify() still accepts the payload (well-formedness check tolerates aud)
 *   - legacy tokens without `aud` still verify (back-compat).
 */

import { createHmac } from 'node:crypto';

import { AuthScopeEnum } from '@bot/shared';

import { AUTH_TOKEN_DEFAULT_AUDIENCE, AuthTokenService } from '../AuthModule';
import { DerivedKeyService } from '../DerivedKeyService';

const VALID_SECRET_HEX = 'a'.repeat(64);

function buildTokenService(): AuthTokenService {
    const master = Buffer.from(VALID_SECRET_HEX, 'hex');
    const secretProvider = { getSigningSecret: jest.fn().mockReturnValue(master) };
    const derivedKeys = new DerivedKeyService(secretProvider as never);
    derivedKeys.onModuleInit();
    return new AuthTokenService(derivedKeys);
}

function decodePayload(token: string): Record<string, unknown> {
    const segment = token.split('.')[1];
    const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
    const json = Buffer.from(segment.replace(/-/gu, '+').replace(/_/gu, '/') + pad, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
}

describe('AuthTokenService.issue — aud claim (M13 fix wave 7)', () => {
    it('stamps aud="mcp" when caller passes aud:"mcp"', () => {
        // BUILD
        const service = buildTokenService();

        // OPERATE
        const issued = service.issue({
            sub: 'agent',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
            aud: 'mcp',
        });

        // CHECK
        const payload = decodePayload(issued.token);
        expect(payload.aud).toBe('mcp');
    });

    it('defaults aud to "engine" when caller omits aud', () => {
        // BUILD
        const service = buildTokenService();

        // OPERATE
        const issued = service.issue({
            sub: 'cli-operator',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
        });

        // CHECK
        const payload = decodePayload(issued.token);
        expect(payload.aud).toBe(AUTH_TOKEN_DEFAULT_AUDIENCE);
        expect(payload.aud).toBe('engine');
    });

    it('defaults aud to "engine" when caller passes aud=""', () => {
        // BUILD
        const service = buildTokenService();

        // OPERATE
        const issued = service.issue({
            sub: 'cli-operator',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
            aud: '',
        });

        // CHECK
        const payload = decodePayload(issued.token);
        expect(payload.aud).toBe('engine');
    });

    it('round-trips through verify() with aud="mcp" (verify ignores audience policy itself)', () => {
        // BUILD
        const service = buildTokenService();
        const issued = service.issue({
            sub: 'agent',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
            aud: 'mcp',
        });

        // OPERATE
        const result = service.verify(issued.token, new Date());

        // CHECK — verify resolves the subject; the aud-allowlist check lives in
        // each consumer (MCP bearer verifier owns it for M13).
        expect((result as { sub?: string }).sub).toBe('agent');
        expect((result as { error?: string }).error).toBeUndefined();
    });

    it('accepts a legacy payload with no aud field (back-compat for M9-era tokens)', () => {
        // BUILD — hand-build a token that mimics the pre-M13 wire shape.
        const service = buildTokenService();

        // Easier: cast the issue input so we can reach into private path. We
        // already proved the default path. For legacy, we manually strip aud
        // by re-encoding the payload without it.
        const issued = service.issue({
            sub: 'legacy',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
        });

        const [headerSeg, payloadSeg] = issued.token.split('.');
        const pad = payloadSeg.length % 4 === 0 ? '' : '='.repeat(4 - (payloadSeg.length % 4));
        const json = Buffer.from(payloadSeg.replace(/-/gu, '+').replace(/_/gu, '/') + pad, 'base64').toString('utf8');
        const obj = JSON.parse(json) as Record<string, unknown>;
        delete obj.aud;
        const legacyPayloadSeg = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');

        // Re-sign with the derived auth key.
        const masterMaterial = Buffer.from(VALID_SECRET_HEX, 'hex');
        const derivedKeys = new DerivedKeyService({ getSigningSecret: () => masterMaterial } as never);
        derivedKeys.onModuleInit();
        const sig = createHmac('sha256', derivedKeys.getAuthKey())
            .update(`${headerSeg}.${legacyPayloadSeg}`)
            .digest()
            .toString('base64')
            .replace(/=+$/u, '')
            .replace(/\+/gu, '-')
            .replace(/\//gu, '_');
        const legacyToken = `${headerSeg}.${legacyPayloadSeg}.${sig}`;

        // OPERATE
        const result = service.verify(legacyToken, new Date());

        // CHECK — well-formedness must tolerate missing aud (legacy back-compat).
        expect((result as { sub?: string }).sub).toBe('legacy');
        expect((result as { error?: string }).error).toBeUndefined();
    });
});
