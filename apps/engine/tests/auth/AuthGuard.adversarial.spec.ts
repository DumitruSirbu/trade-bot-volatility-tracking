import { AuthFailureReasonEnum, AuthScopeEnum } from '@bot/shared';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthGuard } from '../../src/auth/AuthGuard';
import { AuthTokenService, EnvAuthSecretProvider, IRevokedJtiRepositoryPort } from '../../src/auth/AuthModule';
import { AuthCorsInterceptor } from '../../src/auth/AuthCorsInterceptor';
import { AUTH_CORS_ALLOWLIST_ENV } from '../../src/auth/const/authConsts';
import { AppConfigService } from '../../src/config/service';
import { NodeEnvEnum } from '../../src/config/enum';

// M9 QA — adversarial extension to AuthGuard.spec.ts.
// Covers: expired-in-flight, header injection (CR/LF), CORS preflight on
// non-allowed origin, and scope downgrade (HALT token vs no-ADMIN action).
// Per dev-qa-cycle §2.2: these are failure-mode assertions, not happy-path.

class StubSecretProvider {
    constructor(private readonly secret: Buffer = Buffer.alloc(32, 0x42)) {}

    getSigningSecret(): Buffer {
        return this.secret;
    }

    // M11a W1.7 — also satisfy the IDerivedKeyService surface AuthTokenService
    // now consumes. The legacy getSigningSecret remains for any direct
    // IAuthSecretProvider consumers.
    getAuthKey(): Buffer {
        return this.secret;
    }

    getCursorKey(): Buffer {
        return this.secret;
    }
}

class StubRevokedRepo implements IRevokedJtiRepositoryPort {
    readonly revokedSet = new Set<string>();

    async isRevoked(jti: string): Promise<boolean> {
        return this.revokedSet.has(jti);
    }

    async revoke(jti: string, revokedBy: string, reason: string | null): Promise<void> {
        this.revokedSet.add(jti);
    }

    async pruneOlderThan(_cutoff: Date): Promise<number> {
        return 0;
    }

    async countAll(): Promise<number> {
        return this.revokedSet.size;
    }
}

function buildGuard(
    requiredScopes: AuthScopeEnum[],
    opts?: { revoked?: StubRevokedRepo; secret?: Buffer },
): {
    guard: AuthGuard;
    tokens: AuthTokenService;
    revoked: StubRevokedRepo;
} {
    const reflector = new Reflector();
    const tokens = new AuthTokenService(new StubSecretProvider(opts?.secret) as never);
    const revoked = opts?.revoked ?? new StubRevokedRepo();
    const guard = new AuthGuard(reflector, tokens, revoked);

    jest.spyOn(reflector, 'get').mockReturnValue(requiredScopes);

    return { guard, tokens, revoked };
}

function buildContext(authorizationHeader: string): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization: authorizationHeader } }),
            getResponse: () => ({}),
            getNext: () => () => undefined,
        }),
        getHandler: () => () => undefined,
        getClass: () => class {},
    } as unknown as ExecutionContext;
}

async function expectFailureReason(
    promise: Promise<unknown>,
    reason: AuthFailureReasonEnum,
): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
    await promise.catch((err: UnauthorizedException) => {
        const body = err.getResponse() as { error: string; reason: AuthFailureReasonEnum };
        expect(body.error).toBe('AUTH_FAILED');
        expect(body.reason).toBe(reason);
    });
}

// ---------------------------------------------------------------------------
// Expired-in-flight
// ---------------------------------------------------------------------------

describe('AuthGuard adversarial — expired-in-flight token', () => {
    it('rejects a token that was valid at issuance but whose exp has passed by the time the guard runs', async () => {
        // Issue a token with 1s TTL, starting 10s in the past so it is
        // already expired at the moment canActivate calls new Date().
        const { guard, tokens } = buildGuard([AuthScopeEnum.READ]);
        const { token } = tokens.issue({
            sub: 'op',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 1,
            now: new Date(Date.now() - 10_000),
        });

        await expectFailureReason(
            guard.canActivate(buildContext(`Bearer ${token}`)),
            AuthFailureReasonEnum.EXPIRED,
        );
    });

    it('token exactly at exp boundary (exp === floor(now/1000)) is rejected, not passed', async () => {
        // Set exp = exactly now (in seconds). The guard checks `exp <= nowSec`
        // so a token at the boundary should be rejected.
        const { guard, tokens } = buildGuard([AuthScopeEnum.READ]);
        const nowMs = Date.now();
        // Issue with 0 effective TTL: exp = iat + DEFAULT. We instead
        // craft the scenario by issuing -1s in the past with ttl=1 so exp=iat+1
        // and iat is 1s ago → exp is now (floor).
        const { token } = tokens.issue({
            sub: 'op',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 1,
            now: new Date(nowMs - 1_001), // iat = floor((now-1001)/1000), exp = iat+1 ≤ nowSec
        });

        const result = guard.canActivate(buildContext(`Bearer ${token}`));
        // Either expired or valid, but must not accept a token whose exp <= nowSec.
        // In this test we expect EXPIRED.
        await expectFailureReason(result, AuthFailureReasonEnum.EXPIRED);
    });
});

// ---------------------------------------------------------------------------
// Header injection: CR/LF attempt to smuggle a second header
// ---------------------------------------------------------------------------

describe('AuthGuard adversarial — CR/LF header injection', () => {
    it('treats a header containing CR/LF as MALFORMED (no second-header injection)', async () => {
        const { guard } = buildGuard([AuthScopeEnum.READ]);
        // Attempt to inject a second header by embedding CRLF inside the
        // Authorization value. The guard must not evaluate the fake
        // "X-Forwarded-For" fragment as a valid bearer.
        const injected = 'Bearer eyJhbGciOiJIUzI1NiJ9.fakepayload.fakesig\r\nX-Forwarded-For: evil';

        await expectFailureReason(
            guard.canActivate(buildContext(injected)),
            AuthFailureReasonEnum.MALFORMED,
        );
    });

    it('bearer value with embedded null byte is treated as MALFORMED', async () => {
        const { guard } = buildGuard([AuthScopeEnum.READ]);
        const injected = 'Bearer valid\x00.but.notreally';

        await expectFailureReason(
            guard.canActivate(buildContext(injected)),
            AuthFailureReasonEnum.MALFORMED,
        );
    });
});

// ---------------------------------------------------------------------------
// Scope downgrade: HALT token requesting ADMIN-equivalent endpoint
// ---------------------------------------------------------------------------

describe('AuthGuard adversarial — scope downgrade', () => {
    it('rejects a HALT-scoped token when the endpoint requires ADMIN scope', async () => {
        // ADR 0020 §2.1: HALT < ADMIN. A HALT token must not satisfy ADMIN.
        const { guard, tokens } = buildGuard([AuthScopeEnum.ADMIN]);
        const { token } = tokens.issue({
            sub: 'op',
            scopes: [AuthScopeEnum.HALT],
            ttlSec: 900,
            now: new Date(),
        });

        await expectFailureReason(
            guard.canActivate(buildContext(`Bearer ${token}`)),
            AuthFailureReasonEnum.BAD_SCOPE,
        );
    });

    it('rejects a READ token when both HALT and ADMIN scopes are required', async () => {
        const { guard, tokens } = buildGuard([AuthScopeEnum.HALT, AuthScopeEnum.ADMIN]);
        const { token } = tokens.issue({
            sub: 'op',
            scopes: [AuthScopeEnum.READ],
            ttlSec: 900,
            now: new Date(),
        });

        await expectFailureReason(
            guard.canActivate(buildContext(`Bearer ${token}`)),
            AuthFailureReasonEnum.BAD_SCOPE,
        );
    });

    it('a token that holds READ+HALT but NOT ADMIN is rejected for ADMIN-scoped route', async () => {
        const { guard, tokens } = buildGuard([AuthScopeEnum.ADMIN]);
        const { token } = tokens.issue({
            sub: 'op',
            scopes: [AuthScopeEnum.READ, AuthScopeEnum.HALT],
            ttlSec: 900,
            now: new Date(),
        });

        await expectFailureReason(
            guard.canActivate(buildContext(`Bearer ${token}`)),
            AuthFailureReasonEnum.BAD_SCOPE,
        );
    });
});

// ---------------------------------------------------------------------------
// CORS preflight from disallowed origin — verifies NOT 200
// ---------------------------------------------------------------------------

describe('AuthCorsInterceptor adversarial — CORS denial shape', () => {
    const ORIGINAL = process.env[AUTH_CORS_ALLOWLIST_ENV];

    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env[AUTH_CORS_ALLOWLIST_ENV];
        } else {
            process.env[AUTH_CORS_ALLOWLIST_ENV] = ORIGINAL;
        }
    });

    it('disallowed origin returns 403 with IAuthFailure shape, not 200', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = 'http://localhost:5173';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const status = jest.fn().mockReturnThis();
        const json = jest.fn();
        const res = {
            status,
            json,
            setHeader: jest.fn(),
            end: jest.fn(),
        } as unknown as Parameters<typeof middleware.use>[1];
        const next = jest.fn();

        middleware.use(
            { method: 'OPTIONS', headers: { origin: 'https://attacker.example.com' } } as never,
            res,
            next,
        );

        // Must not call next, must not return 200.
        expect(next).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalledWith(200);
        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.CORS_FORBIDDEN }),
        );
    });

    it('GET from a disallowed origin is also denied (not just OPTIONS)', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = 'http://localhost:5173';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const status = jest.fn().mockReturnThis();
        const json = jest.fn();
        const res = {
            status,
            json,
            setHeader: jest.fn(),
            end: jest.fn(),
        } as unknown as Parameters<typeof middleware.use>[1];
        const next = jest.fn();

        middleware.use(
            { method: 'GET', headers: { origin: 'https://evil.example.com' } } as never,
            res,
            next,
        );

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it('empty allowlist denies every Origin header', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = '';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const status = jest.fn().mockReturnThis();
        const json = jest.fn();
        const res = {
            status,
            json,
            setHeader: jest.fn(),
            end: jest.fn(),
        } as unknown as Parameters<typeof middleware.use>[1];
        const next = jest.fn();

        middleware.use(
            { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } } as never,
            res,
            next,
        );

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });
});
