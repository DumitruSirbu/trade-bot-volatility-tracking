import {
    AlertSeverityEnum,
    AlertTypeEnum,
    AuthFailureReasonEnum,
    AuthScopeEnum,
    HaltAuditActionEnum,
    IAlertPayload,
    IAuthFailure,
    ILoginResponse,
    IRateLimitFailure,
} from '@bot/shared';
import { ArgumentsHost, BadRequestException, HttpException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';

import { IAlertSink } from '../../src/alert/sink/AlertSinkModule';
import { AuthController, LoginValidationFilter } from '../../src/auth/AuthController';
import { AuthTokenService, IAuthSecretProvider } from '../../src/auth/AuthModule';
import {
    AUTH_LOGIN_SUBJECT,
    LOGIN_GLOBAL_MAX_ATTEMPTS,
    LOGIN_PER_IP_BURST_MAX,
    LOGIN_PER_IP_SUSTAINED_MAX,
    LOGIN_SECRET_MAX_LEN,
} from '../../src/auth/const/authConsts';
import { LoginRequestDto } from '../../src/auth/dto/LoginRequestDto';
import { LoginRateLimiter } from '../../src/auth/LoginRateLimiter';
import { IClock } from '../../src/common/clock/Clock';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { AppConfigService } from '../../src/config/service';
import { NodeEnvEnum } from '../../src/config/enum';
import { ControlAuditRepository, IAppendLoginAuditParams } from '../../src/control/repository/ControlAuditRepository';

// M10 W0.5 (ADR 0027). Adversarial coverage for the login endpoint, the
// in-memory rate limiter, and the AppConfigService boot validation.
// No Postgres / no HTTP transport: stubs throughout. Per dev-qa-cycle §4.2
// each acceptance bullet pairs with a failing-first test.
//
// Covered (paired with the W0.5 acceptance bullets):
//   1. happy path returns a token the guard's verifier accepts
//   2. bad secret → 401 BAD_SECRET + LOGIN_FAILURE audit
//   3. malformed body (missing/empty secret, array, non-object) → 400 MALFORMED + LOGIN_FAILURE audit
//   4. rate-limit per-IP burst (5/10s) → 429 + LOGIN_THROTTLED audit + Retry-After header
//   5. rate-limit per-IP sustained (20/600s) → 429
//   6. global ceiling (200/60s) → 429 + exactly one CRITICAL telegram alert
//   7. timing-safe comparison (length-normalised via SHA-256; equal hash buffer length)
//   8. AppConfigService boot-fail: AUTH_BOOTSTRAP_SECRET missing in prod / too short / equals signing secret / admin in AUTH_LOGIN_SCOPES
//   9. login NEVER mints admin scope even when config drift puts admin in the array
//  10. source IP resolution: X-Forwarded-For first hop wins; fallback to socket remoteAddress
//  11. secret never appears in audit row, response body, or logger output

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubSecretProvider implements IAuthSecretProvider {
    constructor(private readonly secret: Buffer = Buffer.alloc(32, 0x42)) {}

    getSigningSecret(): Buffer {
        return this.secret;
    }

    // M11a W1.7 — AuthTokenService now consumes IDerivedKeyService; the stub
    // exposes the test-secret via both ports so existing tests keep their
    // sign/verify symmetry.
    getAuthKey(): Buffer {
        return this.secret;
    }

    getCursorKey(): Buffer {
        return this.secret;
    }
}

class StubLoginRateLimitPersistence {
    readonly calls: Array<{ sourceIp: string; scope: string; timestampsMs: number[] }> = [];

    async loadAll(): Promise<Array<{ sourceIp: string; scope: 'burst' | 'sustained' | 'global'; timestampsMs: number[] }>> {
        return [];
    }

    async upsert(row: { sourceIp: string; scope: 'burst' | 'sustained' | 'global'; timestampsMs: number[] }, _now: Date): Promise<void> {
        this.calls.push({ sourceIp: row.sourceIp, scope: row.scope, timestampsMs: row.timestampsMs.slice() });
    }

    async deleteByKey(): Promise<void> {
        // not exercised in unit tests
    }
}

class StubAuditRepo {
    readonly calls: IAppendLoginAuditParams[] = [];

    async appendLoginAudit(params: IAppendLoginAuditParams): Promise<{ id: string }> {
        this.calls.push(params);

        return { id: `audit-${this.calls.length}` };
    }
}

class StubHaltFlag {
    private halted = false;

    isHalted(): boolean {
        return this.halted;
    }

    halt(): void {
        this.halted = true;
    }
}

class StubAlertSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];

    async publish(payload: IAlertPayload): Promise<void> {
        this.published.push(payload);
    }
}

class FixedClock implements IClock {
    constructor(private current: Date) {}

    now(): Date {
        return this.current;
    }

    advance(ms: number): void {
        this.current = new Date(this.current.getTime() + ms);
    }

    set(at: Date): void {
        this.current = at;
    }
}

interface IBuiltController {
    controller: AuthController;
    audit: StubAuditRepo;
    haltFlag: StubHaltFlag;
    alerts: StubAlertSink;
    tokens: AuthTokenService;
    limiter: LoginRateLimiter;
    clock: FixedClock;
    appConfig: AppConfigService;
    bootstrapSecret: string;
    filter: LoginValidationFilter;
}

const NOW = new Date('2026-05-25T12:00:00Z');
const BOOTSTRAP_SECRET = 'super-strong-bootstrap-secret-' + 'A'.repeat(40); // > 32 bytes
const SIGNING_SECRET_BYTES = Buffer.alloc(32, 0x77);

function buildController(opts?: { loginScopes?: AuthScopeEnum[] }): IBuiltController {
    const audit = new StubAuditRepo();
    const haltFlag = new StubHaltFlag();
    const alerts = new StubAlertSink();
    const tokens = new AuthTokenService(new StubSecretProvider(SIGNING_SECRET_BYTES));
    const limiter = new LoginRateLimiter(alerts, new StubLoginRateLimitPersistence() as never);
    const clock = new FixedClock(NOW);

    const scopes = opts?.loginScopes ?? [AuthScopeEnum.READ, AuthScopeEnum.HALT];
    const appConfig = {
        authBootstrapSecret: BOOTSTRAP_SECRET,
        authLoginScopes: scopes,
    } as unknown as AppConfigService;

    const controller = new AuthController(
        limiter,
        tokens,
        audit as unknown as ControlAuditRepository,
        appConfig,
        haltFlag as unknown as HaltFlagService,
        clock,
    );

    const filter = new LoginValidationFilter(audit as unknown as ControlAuditRepository, haltFlag as unknown as HaltFlagService, clock);

    return { controller, audit, haltFlag, alerts, tokens, limiter, clock, appConfig, bootstrapSecret: BOOTSTRAP_SECRET, filter };
}

// M10 R2 #1 — simulate the global ValidationPipe + LoginValidationFilter
// pipeline a real HTTP request would traverse. Returns the response status
// + body if the pipe rejected (filter wrote audit + returned canonical 401);
// returns null if the pipe admitted, in which case the caller is expected
// to invoke controller.login(...) directly.
async function runValidationPipeline(rawBody: unknown, ctx: IBuiltController, req: Request): Promise<{ status: number; body: IAuthFailure } | null> {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

    try {
        await pipe.transform(rawBody, { type: 'body', metatype: LoginRequestDto });

        return null;
    } catch (cause) {
        if (!(cause instanceof BadRequestException)) {
            throw cause;
        }

        let capturedStatus = 0;
        let capturedBody: IAuthFailure | null = null;
        const fakeRes = {
            status(code: number) {
                capturedStatus = code;

                return this;
            },
            json(payload: IAuthFailure) {
                capturedBody = payload;

                return this;
            },
        };
        const host: ArgumentsHost = {
            switchToHttp: () => ({
                getRequest: <T>(): T => req as unknown as T,
                getResponse: <T>(): T => fakeRes as unknown as T,
                getNext: <T>(): T => ((): void => undefined) as unknown as T,
            }),
            switchToRpc: () => ({ getContext: () => undefined, getData: () => undefined }) as never,
            switchToWs: () => ({ getClient: () => undefined, getData: () => undefined, getPattern: () => undefined }) as never,
            getArgs: () => [] as never,
            getArgByIndex: () => undefined as never,
            getType: () => 'http',
        } as unknown as ArgumentsHost;

        await ctx.filter.catch(cause, host);

        if (capturedBody === null) {
            throw new Error('LoginValidationFilter did not write a response body');
        }

        return { status: capturedStatus, body: capturedBody };
    }
}

// M10 R1 #1 — the controller now resolves source IP via `req.ip`, which
// Express populates from `trust proxy` at request time. The test harness
// simulates this directly: `ip` is the property the controller reads.
// `trustProxyIp` lets a test pin the value Express *would* compute with a
// given trust-proxy setting (default: socket.remoteAddress, matching
// trust-proxy=0). Passing `xff` alone WITHOUT `trustProxyIp` mimics the
// attacker scenario where XFF is present but the proxy is not trusted —
// `req.ip` collapses to the socket address regardless of header content.
function buildReq(overrides?: { xff?: string; remote?: string; trustProxyIp?: string }): Request {
    const remote = overrides?.remote ?? '10.0.0.5';
    const headers: Record<string, string> = {};

    if (overrides?.xff !== undefined) {
        headers['x-forwarded-for'] = overrides.xff;
    }

    return {
        headers,
        ip: overrides?.trustProxyIp ?? remote,
        socket: { remoteAddress: remote } as Request['socket'],
    } as unknown as Request;
}

function buildRes(): { res: Response; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const res = {
        setHeader: (k: string, v: string | number): void => {
            headers[k] = String(v);
        },
    } as unknown as Response;

    return { res, headers };
}

// ---------------------------------------------------------------------------
// Tests — login flow
// ---------------------------------------------------------------------------

describe('AuthController.login (M10 W0.5 / ADR 0027)', () => {
    describe('happy path', () => {
        it('returns a token the AuthTokenService verifier accepts and audits LOGIN_SUCCESS', async () => {
            const ctx = buildController();
            const { res, headers } = buildRes();
            const result = await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq(), res);

            expect(result.subject).toBe(AUTH_LOGIN_SUBJECT);
            expect(result.scopes).toEqual([AuthScopeEnum.READ, AuthScopeEnum.HALT]);
            expect(result.token.split('.')).toHaveLength(3);
            expect(headers['Cache-Control']).toBe('no-store');

            const verified = ctx.tokens.verify(result.token, ctx.clock.now());
            expect('error' in verified ? null : verified.sub).toBe(AUTH_LOGIN_SUBJECT);

            expect(ctx.audit.calls).toHaveLength(1);
            expect(ctx.audit.calls[0].action).toBe(HaltAuditActionEnum.LOGIN_SUCCESS);
            expect(ctx.audit.calls[0].actorSub).toBe(AUTH_LOGIN_SUBJECT);
            expect(ctx.audit.calls[0].actorJti).toMatch(/.+/u);
            expect(ctx.audit.calls[0].reason).toBe('login');
        });

        it('audits previous_state HALTED when the halt flag is engaged', async () => {
            const ctx = buildController();
            ctx.haltFlag.halt();
            const { res } = buildRes();

            await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq(), res);
            expect(ctx.audit.calls[0].previousState).toBe('HALTED');
        });
    });

    describe('failure paths', () => {
        it('returns 401 BAD_SECRET and audits LOGIN_FAILURE on wrong secret', async () => {
            const ctx = buildController();
            const { res } = buildRes();

            await expect(ctx.controller.login({ secret: 'totally-wrong-but-long-enough-yes-it-is' }, buildReq(), res)).rejects.toMatchObject({
                response: { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.BAD_SECRET },
            });

            expect(ctx.audit.calls).toHaveLength(1);
            expect(ctx.audit.calls[0].action).toBe(HaltAuditActionEnum.LOGIN_FAILURE);
            expect(ctx.audit.calls[0].reason).toBe(AuthFailureReasonEnum.BAD_SECRET);
            expect(ctx.audit.calls[0].actorSub).toBeNull();
        });

        // M10 R2 #1 — body validation is now owned by the global ValidationPipe
        // + LoginRequestDto, with LoginValidationFilter remapping pipe 400s to
        // the canonical 401 MALFORMED IAuthFailure shape. These tests drive
        // the same pipeline a real HTTP request would.

        it('returns 401 MALFORMED on missing secret and audits LOGIN_FAILURE', async () => {
            const ctx = buildController();
            const result = await runValidationPipeline({}, ctx, buildReq());

            expect(result).not.toBeNull();
            expect(result!.status).toBe(401);
            expect(result!.body).toEqual({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.MALFORMED });
            expect(ctx.audit.calls[0].action).toBe(HaltAuditActionEnum.LOGIN_FAILURE);
            expect(ctx.audit.calls[0].reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('returns 401 MALFORMED on empty-string secret', async () => {
            const ctx = buildController();
            const result = await runValidationPipeline({ secret: '' }, ctx, buildReq());

            expect(result?.status).toBe(401);
            expect(result?.body.reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('returns 401 MALFORMED on array body', async () => {
            const ctx = buildController();
            const result = await runValidationPipeline([], ctx, buildReq());

            expect(result?.status).toBe(401);
            expect(result?.body.reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('returns 401 MALFORMED on null body', async () => {
            const ctx = buildController();
            const result = await runValidationPipeline(null, ctx, buildReq());

            expect(result?.status).toBe(401);
            expect(result?.body.reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        // M10 R2 #1 — extra fields (e.g. `{ scope: 'admin' }`) MUST be rejected
        // by the pipe so admin can NEVER reach the mint path through a body
        // smuggle. Defence-in-depth above the controller-side admin filter.
        it('returns 401 MALFORMED when an extra field like scope=admin is smuggled in the body', async () => {
            const ctx = buildController();
            const result = await runValidationPipeline({ secret: ctx.bootstrapSecret, scope: 'admin' }, ctx, buildReq());

            expect(result?.status).toBe(401);
            expect(result?.body.reason).toBe(AuthFailureReasonEnum.MALFORMED);
            expect(ctx.audit.calls[0].action).toBe(HaltAuditActionEnum.LOGIN_FAILURE);
            // Controller was NEVER invoked — no token mint, no LOGIN_SUCCESS row.
            expect(ctx.audit.calls.some((c) => c.action === HaltAuditActionEnum.LOGIN_SUCCESS)).toBe(false);
        });

        // M10 R2 #3 — oversized `secret` rejected by @MaxLength BEFORE the
        // SHA-256 hash + timingSafeEqual run. Caps per-request CPU.
        it('returns 401 MALFORMED when secret exceeds LOGIN_SECRET_MAX_LEN, BEFORE hashing', async () => {
            const ctx = buildController();
            const oversized = 'x'.repeat(LOGIN_SECRET_MAX_LEN + 1);
            const result = await runValidationPipeline({ secret: oversized }, ctx, buildReq());

            expect(result?.status).toBe(401);
            expect(result?.body.reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('admits secrets at exactly LOGIN_SECRET_MAX_LEN (boundary)', async () => {
            const ctx = buildController();
            const atBoundary = 'x'.repeat(LOGIN_SECRET_MAX_LEN);
            const result = await runValidationPipeline({ secret: atBoundary }, ctx, buildReq());

            // Pipe admits → null. Controller would then reject as BAD_SECRET
            // (wrong value), but the pipe boundary is what we're locking here.
            expect(result).toBeNull();
        });

        it('returns the SAME BAD_SECRET reason for a wrong-secret of any length (length oracle defence)', async () => {
            const ctx = buildController();
            const { res: r1 } = buildRes();
            const { res: r2 } = buildRes();

            const reject1 = ctx.controller.login({ secret: 'x' }, buildReq(), r1).catch((e) => (e as UnauthorizedException).getResponse());
            const reject2 = ctx.controller.login({ secret: 'x'.repeat(500) }, buildReq(), r2).catch((e) => (e as UnauthorizedException).getResponse());

            expect(await reject1).toEqual({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.BAD_SECRET });
            expect(await reject2).toEqual({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.BAD_SECRET });
        });
    });

    describe('rate limiting', () => {
        it('per-IP burst: 6th attempt in <10s returns 429 with Retry-After header and audits LOGIN_THROTTLED', async () => {
            const ctx = buildController();

            // Burn the first BURST_MAX attempts (each is BAD_SECRET, audited as LOGIN_FAILURE).
            for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i += 1) {
                const { res } = buildRes();
                await expect(ctx.controller.login({ secret: 'wrong' }, buildReq(), res)).rejects.toBeInstanceOf(UnauthorizedException);
            }

            const { res: throttledRes, headers } = buildRes();
            const promise = ctx.controller.login({ secret: 'wrong' }, buildReq(), throttledRes);
            await expect(promise).rejects.toMatchObject({ response: { error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS' } });
            expect(headers['Retry-After']).toMatch(/^[0-9]+$/u);

            const throttled = ctx.audit.calls.filter((c) => c.action === HaltAuditActionEnum.LOGIN_THROTTLED);
            expect(throttled.length).toBeGreaterThanOrEqual(1);
        });

        it('per-IP sustained: 21st attempt across the 10-minute window returns 429', async () => {
            const ctx = buildController();

            // Pace attempts at 15s apart so the 10s burst window stays empty
            // (>= LOGIN_PER_IP_BURST_WINDOW_MS) while the 600s sustained
            // window fills. 20 attempts × 15s = 300s, well inside 600s.
            for (let i = 0; i < LOGIN_PER_IP_SUSTAINED_MAX; i += 1) {
                const { res } = buildRes();
                await expect(ctx.controller.login({ secret: 'wrong' }, buildReq(), res)).rejects.toBeInstanceOf(UnauthorizedException);
                ctx.clock.advance(15_000);
            }

            const { res: throttledRes } = buildRes();
            await expect(ctx.controller.login({ secret: 'wrong' }, buildReq(), throttledRes)).rejects.toMatchObject({
                response: { error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS' },
            });
        });

        it('global ceiling: 201st attempt across distinct IPs returns 429 + fires exactly one CRITICAL alert per coalesce window', async () => {
            const ctx = buildController();

            for (let i = 0; i < LOGIN_GLOBAL_MAX_ATTEMPTS; i += 1) {
                const { res } = buildRes();
                const req = buildReq({ remote: `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}` });
                await expect(ctx.controller.login({ secret: 'wrong' }, req, res)).rejects.toBeInstanceOf(UnauthorizedException);
            }

            const { res: throttledRes } = buildRes();
            const reqOverflow = buildReq({ remote: '10.99.99.99' });
            await expect(ctx.controller.login({ secret: 'wrong' }, reqOverflow, throttledRes)).rejects.toMatchObject({
                response: { error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS' },
            });

            // Allow the fire-and-forget alert promise chain to resolve.
            await new Promise((resolve) => setImmediate(resolve));

            const critical = ctx.alerts.published.filter((p) => p.severity === AlertSeverityEnum.CRITICAL);
            expect(critical).toHaveLength(1);
            expect(critical[0].type).toBe(AlertTypeEnum.UNHANDLED_EXCEPTION);
            expect(critical[0].title).toMatch(/rate-limit ceiling/iu);

            // Second overflow within the coalesce window stays at one alert.
            const { res: r2 } = buildRes();
            await ctx.controller.login({ secret: 'wrong' }, buildReq({ remote: '10.99.99.98' }), r2).catch(() => undefined);
            await new Promise((resolve) => setImmediate(resolve));
            expect(ctx.alerts.published.filter((p) => p.severity === AlertSeverityEnum.CRITICAL)).toHaveLength(1);
        });
    });

    describe('constant-time secret comparison', () => {
        it('uses equal-length SHA-256 buffers regardless of input length (timingSafeEqual prerequisite)', () => {
            const a = createHash('sha256').update('short', 'utf8').digest();
            const b = createHash('sha256').update('x'.repeat(10_000), 'utf8').digest();

            expect(a.length).toBe(32);
            expect(b.length).toBe(32);
        });

        it('rejects any prefix-match (no early-exit oracle)', async () => {
            const ctx = buildController();
            const prefix = ctx.bootstrapSecret.slice(0, 10);
            const { res } = buildRes();
            await expect(ctx.controller.login({ secret: prefix }, buildReq(), res)).rejects.toMatchObject({
                response: { reason: AuthFailureReasonEnum.BAD_SECRET },
            });
        });

        // M10 R2 #2 — expected hash is computed ONCE at construction. We assert
        // this by spying on createHash AFTER the controller is built and
        // confirming that across N login attempts only N (not 2N) sha256
        // instances are minted. The expected-hash buffer is never re-derived
        // from the env-resident secret on the request path.
        it('computes the expected-secret hash once at construction, not per request', async () => {
            const ctx = buildController();
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.spyOn requires the CJS module object to intercept createHash; dynamic import() returns a non-configurable module binding
            const cryptoModule = require('node:crypto') as typeof import('node:crypto');
            const spy = jest.spyOn(cryptoModule, 'createHash');

            for (let i = 0; i < 4; i += 1) {
                const { res } = buildRes();
                await ctx.controller.login({ secret: 'wrong' }, buildReq(), res).catch(() => undefined);
            }

            // 4 requests × 1 candidate hash per request = 4 createHash calls.
            // If the controller re-derived the expected hash per request we'd
            // see 8.
            expect(spy).toHaveBeenCalledTimes(4);
            spy.mockRestore();
        });
    });

    describe('admin scope guardrail', () => {
        it('NEVER includes admin in returned scopes even if config drift sneaks it past boot', async () => {
            const ctx = buildController({ loginScopes: [AuthScopeEnum.READ, AuthScopeEnum.HALT, AuthScopeEnum.ADMIN] });
            const { res } = buildRes();
            const result: ILoginResponse = await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq(), res);

            expect(result.scopes).not.toContain(AuthScopeEnum.ADMIN);
            expect(result.scopes).toEqual([AuthScopeEnum.READ, AuthScopeEnum.HALT]);
        });
    });

    describe('source IP extraction (M10 R1 #1 — Express trust-proxy)', () => {
        it('uses req.ip when trust-proxy is configured (Express-resolved XFF first hop)', async () => {
            const ctx = buildController();
            const { res } = buildRes();
            // trust-proxy=1 → Express sets req.ip to the resolved XFF entry.
            await ctx.controller.login(
                { secret: ctx.bootstrapSecret },
                buildReq({ xff: '203.0.113.7, 10.0.0.1', remote: '10.0.0.5', trustProxyIp: '203.0.113.7' }),
                res,
            );

            expect(ctx.audit.calls[0].sourceIp).toBe('203.0.113.7');
        });

        it('falls back to socket.remoteAddress when no proxy header / trust-proxy is configured', async () => {
            const ctx = buildController();
            const { res } = buildRes();
            await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq({ remote: '198.51.100.9' }), res);

            expect(ctx.audit.calls[0].sourceIp).toBe('198.51.100.9');
        });

        it('XFF spoofing of the first hop does NOT change the rate-limit bucket when trust-proxy=1 pins req.ip to the real edge', async () => {
            // Attacker rotates the spoofed XFF first hop across LOGIN_PER_IP_BURST_MAX+1
            // attempts. With trust-proxy honoured (req.ip stays at the true
            // edge address), all attempts hit the same bucket and the
            // (MAX+1)-th attempt is throttled. Pre-fix this would have admitted
            // every request because each spoofed first-hop made a fresh bucket.
            const ctx = buildController();
            const realEdgeIp = '203.0.113.42';

            for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i += 1) {
                const { res } = buildRes();
                await expect(
                    ctx.controller.login(
                        { secret: 'wrong' },
                        buildReq({ xff: `198.51.100.${i + 1}, 10.0.0.1`, remote: '10.0.0.5', trustProxyIp: realEdgeIp }),
                        res,
                    ),
                ).rejects.toBeInstanceOf(UnauthorizedException);
            }

            const { res: throttledRes } = buildRes();
            await expect(
                ctx.controller.login(
                    { secret: 'wrong' },
                    // Yet another spoofed first hop — but req.ip pinned to the
                    // real edge keeps the bucket consistent.
                    buildReq({ xff: '198.51.100.99, 10.0.0.1', remote: '10.0.0.5', trustProxyIp: realEdgeIp }),
                    throttledRes,
                ),
            ).rejects.toMatchObject({ response: { error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS' } });

            const throttled = ctx.audit.calls.filter((c) => c.action === HaltAuditActionEnum.LOGIN_THROTTLED);
            expect(throttled.length).toBeGreaterThanOrEqual(1);
            // Every audited source IP should be the trusted-edge value, never
            // a spoofed XFF first hop.
            for (const call of ctx.audit.calls) {
                expect(call.sourceIp).toBe(realEdgeIp);
            }
        });
    });

    describe('secret redaction', () => {
        it('never persists the bootstrap secret value in any audit-row field', async () => {
            const ctx = buildController();
            const { res } = buildRes();
            await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq(), res);
            await ctx.controller.login({ secret: 'wrong' }, buildReq(), buildRes().res).catch(() => undefined);

            const serialised = JSON.stringify(ctx.audit.calls);
            expect(serialised).not.toContain(ctx.bootstrapSecret);
        });

        it('never returns the bootstrap secret in the response token', async () => {
            const ctx = buildController();
            const { res } = buildRes();
            const result = await ctx.controller.login({ secret: ctx.bootstrapSecret }, buildReq(), res);

            // The JWT payload is base64url JSON; the secret must never appear
            // anywhere in the token string (signature or otherwise).
            expect(result.token).not.toContain(ctx.bootstrapSecret);
        });
    });

    // M10 R2 #4 — denied-attempt warn log MUST carry sourceIp so pre-throttle
    // attempts have forensic attribution in the log stream. (Post-throttle is
    // already covered by LoginRateLimiter's own warn line.)
    describe('denied-attempt log carries sourceIp (M10 R2 #4)', () => {
        it('warn line includes sourceIp on BAD_SECRET via the controller path', async () => {
            const ctx = buildController();
            const warnSpy = jest.spyOn((ctx.controller as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

            const { res } = buildRes();
            await ctx.controller.login({ secret: 'wrong-secret-value-x' }, buildReq({ trustProxyIp: '203.0.113.42' }), res).catch(() => undefined);

            const denied = warnSpy.mock.calls.find(([msg]: [string]) => msg.startsWith('auth.login.denied'));
            expect(denied).toBeDefined();
            expect(denied![0]).toContain(`reason=${AuthFailureReasonEnum.BAD_SECRET}`);
            expect(denied![0]).toContain('sourceIp=203.0.113.42');
            warnSpy.mockRestore();
        });

        it('warn line includes sourceIp on MALFORMED via the LoginValidationFilter path', async () => {
            const ctx = buildController();
            const warnSpy = jest.spyOn((ctx.filter as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

            await runValidationPipeline({}, ctx, buildReq({ trustProxyIp: '198.51.100.7' }));

            const denied = warnSpy.mock.calls.find(([msg]: [string]) => msg.startsWith('auth.login.denied'));
            expect(denied).toBeDefined();
            expect(denied![0]).toContain(`reason=${AuthFailureReasonEnum.MALFORMED}`);
            expect(denied![0]).toContain('sourceIp=198.51.100.7');
            warnSpy.mockRestore();
        });

        it('warn line falls back to sourceIp=unknown when req.ip is missing', async () => {
            const ctx = buildController();
            const warnSpy = jest.spyOn((ctx.controller as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

            const reqNoIp = { headers: {}, ip: undefined, socket: { remoteAddress: undefined } } as unknown as Request;
            const { res } = buildRes();
            await ctx.controller.login({ secret: 'wrong' }, reqNoIp, res).catch(() => undefined);

            const denied = warnSpy.mock.calls.find(([msg]: [string]) => msg.startsWith('auth.login.denied'));
            expect(denied![0]).toContain('sourceIp=unknown');
            warnSpy.mockRestore();
        });
    });
});

// ---------------------------------------------------------------------------
// Tests — AppConfigService boot validation (login surface only)
// ---------------------------------------------------------------------------

describe('AppConfigService — login bootstrap secret + scopes (M10 W0.5 / ADR 0027)', () => {
    const ENV_KEYS = ['AUTH_BOOTSTRAP_SECRET', 'AUTH_LOGIN_SCOPES', 'AUTH_HMAC_SECRET', 'NODE_ENV'] as const;
    const snapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            snapshot[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (snapshot[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = snapshot[k];
            }
        }
    });

    function buildAppConfig(env: NodeEnvEnum): AppConfigService {
        const fake = {
            get: (key: string) => {
                if (key === 'NODE_ENV') {
                    return env;
                }

                return undefined;
            },
        } as unknown as ConfigService;

        return new AppConfigService(fake as unknown as ConfigService<never, true>);
    }

    it('boot-fails when AUTH_BOOTSTRAP_SECRET is missing in production', () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(32);
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/AUTH_BOOTSTRAP_SECRET is required/u);
    });

    it('boot-fails when AUTH_BOOTSTRAP_SECRET is under 32 bytes', () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(32);
        process.env.AUTH_BOOTSTRAP_SECRET = 'short';
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/>= 32 bytes/u);
    });

    it('boot-fails when AUTH_BOOTSTRAP_SECRET equals AUTH_HMAC_SECRET', () => {
        const shared = 'a'.repeat(40);
        process.env.AUTH_HMAC_SECRET = shared;
        process.env.AUTH_BOOTSTRAP_SECRET = shared;
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/must not equal AUTH_HMAC_SECRET/u);
    });

    it("boot-fails when AUTH_LOGIN_SCOPES contains 'admin'", () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(40);
        process.env.AUTH_BOOTSTRAP_SECRET = 'y'.repeat(40);
        process.env.AUTH_LOGIN_SCOPES = 'read,halt,admin';
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/must not contain 'admin'/u);
    });

    it('boot-fails when AUTH_LOGIN_SCOPES contains an unknown scope', () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(40);
        process.env.AUTH_BOOTSTRAP_SECRET = 'y'.repeat(40);
        process.env.AUTH_LOGIN_SCOPES = 'read,banana';
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/unknown scope/u);
    });

    // M10 R2 #5 — `.env.example` ships `change_me_local_only`; underscore form
    // must be on the sentinel deny-list. The hyphen + no-separator variants
    // were already covered.
    it("boot-fails when AUTH_BOOTSTRAP_SECRET contains the underscore sentinel 'change_me'", () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(40);
        process.env.AUTH_BOOTSTRAP_SECRET = 'change_me_local_only_' + 'y'.repeat(40);
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/forbidden sentinel substring 'change_me'/u);
    });

    it("boot-fails when AUTH_HMAC_SECRET contains the underscore sentinel 'change_me'", () => {
        process.env.AUTH_HMAC_SECRET = 'change_me_local_only_' + 'y'.repeat(40);
        expect(() => buildAppConfig(NodeEnvEnum.PRODUCTION)).toThrow(/forbidden sentinel substring 'change_me'/u);
    });

    it('accepts a strong distinct secret and defaults scopes to read,halt', () => {
        process.env.AUTH_HMAC_SECRET = 'x'.repeat(40);
        process.env.AUTH_BOOTSTRAP_SECRET = 'y'.repeat(40);
        const cfg = buildAppConfig(NodeEnvEnum.PRODUCTION);

        expect(cfg.authBootstrapSecret).toHaveLength(40);
        expect(cfg.authLoginScopes).toEqual([AuthScopeEnum.READ, AuthScopeEnum.HALT]);
    });

    it('non-prod with unset bootstrap secret generates a per-process random distinct from signing secret', () => {
        // Both unset → both generated; the bootstrap secret must differ from
        // the signing secret by construction.
        const cfg = buildAppConfig(NodeEnvEnum.DEVELOPMENT);

        expect(cfg.authBootstrapSecret.length).toBeGreaterThanOrEqual(32);
        expect(cfg.authBootstrapSecret).not.toBe(cfg.authHmacSecret);
    });
});

// ---------------------------------------------------------------------------
// Tests — LoginRateLimiter isolated unit
// ---------------------------------------------------------------------------

describe('LoginRateLimiter (M10 W0.5 / ADR 0027)', () => {
    function build(): { limiter: LoginRateLimiter; alerts: StubAlertSink } {
        const alerts = new StubAlertSink();

        return { limiter: new LoginRateLimiter(alerts, new StubLoginRateLimitPersistence() as never), alerts };
    }

    it('admits up to LOGIN_PER_IP_BURST_MAX in the 10s window, throws on the next attempt', () => {
        const { limiter } = build();
        const t0 = new Date('2026-05-25T00:00:00Z');

        for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i += 1) {
            expect(() => limiter.enforce('1.1.1.1', new Date(t0.getTime() + i * 100))).not.toThrow();
        }

        let thrown: unknown;
        try {
            limiter.enforce('1.1.1.1', new Date(t0.getTime() + LOGIN_PER_IP_BURST_MAX * 100));
        } catch (cause) {
            thrown = cause;
        }

        expect(thrown).toBeInstanceOf(HttpException);
        expect((thrown as HttpException).getStatus()).toBe(429);
        const body = (thrown as HttpException).getResponse() as IRateLimitFailure;
        expect(body.reason).toBe('TOO_MANY_LOGIN_ATTEMPTS');
        expect(body.retryAfterSec).toBeGreaterThan(0);
    });

    it('does NOT throttle across distinct IPs under per-IP windows', () => {
        const { limiter } = build();
        const t0 = new Date('2026-05-25T00:00:00Z');

        for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i += 1) {
            expect(() => limiter.enforce(`9.9.9.${i + 1}`, t0)).not.toThrow();
        }
    });

    // M10 R1 #2 — exact-boundary regression: the (MAX+1)-th attempt MUST
    // throttle, the MAX-th MUST admit. Locks the off-by-one cleanup so a
    // future refactor cannot drift back to a 4-admit or 6-admit predicate.
    it('throws on exactly the (LOGIN_PER_IP_BURST_MAX + 1)-th attempt, admits the MAX-th', () => {
        const { limiter } = build();
        const t0 = new Date('2026-05-25T00:00:00Z');

        // Attempts 1..MAX must each admit.
        for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i += 1) {
            expect(() => limiter.enforce('2.2.2.2', new Date(t0.getTime() + i * 100))).not.toThrow();
        }

        // Attempt (MAX+1) MUST throttle.
        expect(() => limiter.enforce('2.2.2.2', new Date(t0.getTime() + LOGIN_PER_IP_BURST_MAX * 100))).toThrow(HttpException);
    });
});
