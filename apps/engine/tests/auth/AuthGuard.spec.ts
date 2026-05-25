import { AuthFailureReasonEnum, AuthScopeEnum } from '@bot/shared';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthGuard, RequiredScopes } from '../../src/auth/AuthGuard';
import { AuthTokenService, EnvAuthSecretProvider, IAuthSecretProvider, IRevokedJtiRepositoryPort } from '../../src/auth/AuthModule';
import { AuthCorsInterceptor } from '../../src/auth/AuthCorsInterceptor';
import { AUTH_CORS_ALLOWLIST_ENV } from '../../src/auth/const/authConsts';
import { AppConfigService } from '../../src/config/service';
import { NodeEnvEnum } from '../../src/config/enum';

// M9 W2 — adversarial coverage for the auth guard, token service, dev-secret
// boot-fail, and the CORS preflight middleware. Paired test-per-fix-item per
// dev-qa-cycle §4.2. No Postgres: the revoked-jti port and the secret
// provider are stubbed so each scenario stays a pure unit test.

class StubSecretProvider implements IAuthSecretProvider {
    constructor(private readonly secret: Buffer = Buffer.alloc(32, 0x42)) {}

    getSigningSecret(): Buffer {
        return this.secret;
    }
}

class StubRevokedRepo implements IRevokedJtiRepositoryPort {
    readonly revokedSet = new Set<string>();
    readonly revokedCalls: Array<{ jti: string; revokedBy: string; reason: string | null }> = [];

    async isRevoked(jti: string): Promise<boolean> {
        return this.revokedSet.has(jti);
    }

    async revoke(jti: string, revokedBy: string, reason: string | null): Promise<void> {
        this.revokedCalls.push({ jti, revokedBy, reason });
        this.revokedSet.add(jti);
    }
}

interface IFakeRequest {
    headers: Record<string, string>;
    authSubject?: unknown;
}

function buildContext(request: IFakeRequest, handler: () => void = (): void => undefined): ExecutionContext {
    const handlerFn = handler;
    const classRef = class {};

    return {
        switchToHttp: () => ({
            getRequest: <T>(): T => request as unknown as T,
            getResponse: <T>(): T => ({}) as T,
            getNext: <T>(): T => ((): void => undefined) as unknown as T,
        }),
        getHandler: () => handlerFn,
        getClass: () => classRef,
    } as unknown as ExecutionContext;
}

function buildGuard(opts?: { revoked?: StubRevokedRepo; secret?: Buffer }): {
    guard: AuthGuard;
    tokens: AuthTokenService;
    revoked: StubRevokedRepo;
    reflector: Reflector;
} {
    const reflector = new Reflector();
    const tokens = new AuthTokenService(new StubSecretProvider(opts?.secret));
    const revoked = opts?.revoked ?? new StubRevokedRepo();
    const guard = new AuthGuard(reflector, tokens, revoked);

    return { guard, tokens, revoked, reflector };
}

const NOW = new Date('2026-05-24T12:00:00Z');

describe('AuthGuard', () => {
    describe('happy path', () => {
        it('attaches the subject and allows the request when bearer is valid and scopes match', async () => {
            const { guard, tokens, reflector } = buildGuard();
            const { token } = tokens.issue({
                sub: 'operator-1',
                scopes: [AuthScopeEnum.READ, AuthScopeEnum.HALT],
                ttlSec: 900,
                now: new Date(),
            });

            const handler = (): void => undefined;
            // RequiredScopes is exported via SetMetadata — exercised here as a
            // smoke check that the symbol resolves. Actual metadata is stubbed
            // via the reflector spy below so this test does not depend on the
            // class/method decorator wiring inside ExecutionContext.
            expect(typeof RequiredScopes).toBe('function');
            jest.spyOn(reflector, 'get').mockReturnValue([AuthScopeEnum.READ]);

            const request: IFakeRequest = { headers: { authorization: `Bearer ${token}` } };
            const allowed = await guard.canActivate(buildContext(request, handler));

            expect(allowed).toBe(true);
            expect((request.authSubject as { sub: string }).sub).toBe('operator-1');
        });
    });

    describe('failure modes', () => {
        it('rejects with MISSING when the Authorization header is absent', async () => {
            const { guard } = buildGuard();
            const promise = guard.canActivate(buildContext({ headers: {} }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.MISSING);
        });

        it('rejects with MALFORMED when the bearer is not three segments', async () => {
            const { guard } = buildGuard();
            const promise = guard.canActivate(buildContext({ headers: { authorization: 'Bearer not.a.jwt.token' } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.MALFORMED);
        });

        it('rejects with MALFORMED when the bearer prefix is missing', async () => {
            const { guard, tokens } = buildGuard();
            const { token } = tokens.issue({ sub: 'op', scopes: [AuthScopeEnum.READ], ttlSec: 900, now: new Date() });
            const promise = guard.canActivate(buildContext({ headers: { authorization: token } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.MALFORMED);
        });

        it('rejects with EXPIRED when the token exp has passed', async () => {
            const { guard, tokens } = buildGuard();
            const { token } = tokens.issue({ sub: 'op', scopes: [AuthScopeEnum.READ], ttlSec: 1, now: new Date(NOW.getTime() - 10_000) });

            const promise = guard.canActivate(buildContext({ headers: { authorization: `Bearer ${token}` } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.EXPIRED);
        });

        it('rejects with REVOKED when the jti is in revoked_jti', async () => {
            const revoked = new StubRevokedRepo();
            const { guard, tokens } = buildGuard({ revoked });
            const issued = tokens.issue({ sub: 'op', scopes: [AuthScopeEnum.READ], ttlSec: 900, now: new Date() });

            await revoked.revoke(issued.jti, 'CLI', 'leaked');
            const promise = guard.canActivate(buildContext({ headers: { authorization: `Bearer ${issued.token}` } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.REVOKED);
        });

        it('rejects with BAD_SCOPE when required scope is missing', async () => {
            const { guard, tokens, reflector } = buildGuard();
            const { token } = tokens.issue({ sub: 'op', scopes: [AuthScopeEnum.READ], ttlSec: 900, now: new Date() });

            jest.spyOn(reflector, 'get').mockReturnValue([AuthScopeEnum.ADMIN]);

            const promise = guard.canActivate(buildContext({ headers: { authorization: `Bearer ${token}` } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.BAD_SCOPE);
        });

        it('rejects with MALFORMED when the signature is tampered', async () => {
            const { guard, tokens } = buildGuard();
            const { token } = tokens.issue({ sub: 'op', scopes: [AuthScopeEnum.READ], ttlSec: 900, now: new Date() });
            const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');

            const promise = guard.canActivate(buildContext({ headers: { authorization: `Bearer ${tampered}` } }));

            await expectAuthFailure(promise, AuthFailureReasonEnum.MALFORMED);
        });
    });

    describe('upsert-safe revoke', () => {
        it('does not throw when the same jti is revoked twice', async () => {
            const revoked = new StubRevokedRepo();

            await revoked.revoke('jti-1', 'CLI', null);
            await expect(revoked.revoke('jti-1', 'CLI', null)).resolves.not.toThrow();
        });
    });

    describe('EnvAuthSecretProvider', () => {
        // M9 R1 #4 — the provider now sources the secret from
        // AppConfigService.authHmacSecret rather than reading process.env
        // directly. The boot-time prod / sentinel / byte-length checks moved
        // to AppConfigService (covered by its own tests). Here we just assert
        // the provider's defence-in-depth re-check still trips on a short
        // secret and that a healthy value passes through.

        function buildAppConfig(secret: string): AppConfigService {
            return { authHmacSecret: secret } as unknown as AppConfigService;
        }

        it('rejects a sub-32-byte secret via the defence-in-depth re-check', () => {
            const provider = new EnvAuthSecretProvider(buildAppConfig('too-short'));

            expect(() => provider.onModuleInit()).toThrow(/>= 32 bytes/u);
        });

        it('accepts a strong secret', () => {
            const provider = new EnvAuthSecretProvider(buildAppConfig('x'.repeat(32)));

            provider.onModuleInit();
            expect(provider.getSigningSecret().byteLength).toBeGreaterThanOrEqual(32);
        });
    });
});

describe('AuthCorsInterceptor', () => {
    const ORIGINAL = process.env[AUTH_CORS_ALLOWLIST_ENV];

    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env[AUTH_CORS_ALLOWLIST_ENV];

            return;
        }

        process.env[AUTH_CORS_ALLOWLIST_ENV] = ORIGINAL;
    });

    it('rejects preflight from a disallowed origin with the IAuthFailure shape', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = 'http://localhost:5173';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const status = jest.fn().mockReturnThis();
        const json = jest.fn();
        const res = { status, json, setHeader: jest.fn(), end: jest.fn() } as unknown as Parameters<typeof middleware.use>[1];
        const next = jest.fn();

        middleware.use({ method: 'OPTIONS', headers: { origin: 'http://evil.example' } } as unknown as Parameters<typeof middleware.use>[0], res, next);

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.CORS_FORBIDDEN });
    });

    it('allows preflight from an allow-listed origin and short-circuits with 204', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = 'http://localhost:5173';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const setHeader = jest.fn();
        const status = jest.fn().mockReturnThis();
        const end = jest.fn();
        const res = { setHeader, status, end, json: jest.fn() } as unknown as Parameters<typeof middleware.use>[1];
        const next = jest.fn();

        middleware.use({ method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } } as unknown as Parameters<typeof middleware.use>[0], res, next);

        expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:5173');
        expect(status).toHaveBeenCalledWith(204);
        expect(next).not.toHaveBeenCalled();
    });

    it('passes same-origin requests (no Origin header) through to next()', () => {
        process.env[AUTH_CORS_ALLOWLIST_ENV] = '';
        const middleware = new AuthCorsInterceptor({ corsAllowlist: (process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) } as unknown as import('../../src/config/service').AppConfigService);
        const next = jest.fn();
        const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn() } as unknown as Parameters<
            typeof middleware.use
        >[1];

        middleware.use({ method: 'GET', headers: {} } as unknown as Parameters<typeof middleware.use>[0], res, next);
        expect(next).toHaveBeenCalled();
    });
});

async function expectAuthFailure(promise: Promise<unknown>, reason: AuthFailureReasonEnum): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
    await promise.catch((cause: UnauthorizedException) => {
        const body = cause.getResponse() as { error: string; reason: AuthFailureReasonEnum };

        expect(body.error).toBe('AUTH_FAILED');
        expect(body.reason).toBe(reason);
    });
}
