import { AuthScopeEnum } from '@bot/shared';
import { BadRequestException, ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthGuard } from '../../src/auth/AuthGuard';
import { REQUIRED_SCOPES_METADATA_KEY } from '../../src/auth/const/authConsts';
import { REBALANCE_TRIGGER_RATE_LIMIT, REBALANCE_TRIGGER_RATE_TTL_MS } from '../../src/strategy/const';
import { RebalanceDevController } from '../../src/strategy/controller/RebalanceDevController';
import { RebalanceTriggerForbiddenException, RebalanceTriggerRejectedException } from '../../src/strategy/exception';
import { RebalanceSchedulerService } from '../../src/strategy/service/RebalanceSchedulerService';

describe('RebalanceDevController', () => {
    const triggerRebalanceDue = jest.fn();

    beforeEach(async () => {
        triggerRebalanceDue.mockReset();
        triggerRebalanceDue.mockResolvedValue({ accepted: true, nowMs: 1_700_000_000_000 });
    });

    async function buildModule(): Promise<TestingModule> {
        return Test.createTestingModule({
            // The controller references ThrottlerGuard via @UseGuards, so Nest must resolve the
            // guard's deps at compile time even though guards do not run on direct method calls.
            imports: [ThrottlerModule.forRoot([{ ttl: REBALANCE_TRIGGER_RATE_TTL_MS, limit: REBALANCE_TRIGGER_RATE_LIMIT }])],
            controllers: [RebalanceDevController],
            providers: [
                {
                    provide: RebalanceSchedulerService,
                    useValue: { triggerRebalanceDue },
                },
            ],
        })
            .overrideGuard(AuthGuard)
            .useValue({ canActivate: () => true })
            .compile();
    }

    it('returns the scheduler trigger result', async () => {
        const moduleRef = await buildModule();
        const controller = moduleRef.get(RebalanceDevController);

        await expect(controller.triggerRebalance()).resolves.toEqual({ accepted: true, nowMs: 1_700_000_000_000 });
        expect(triggerRebalanceDue).toHaveBeenCalledTimes(1);
    });

    it('translates RebalanceTriggerForbiddenException to HTTP 403 ForbiddenException', async () => {
        triggerRebalanceDue.mockRejectedValue(new RebalanceTriggerForbiddenException('trigger-rebalance is paper-only'));
        const moduleRef = await buildModule();
        const controller = moduleRef.get(RebalanceDevController);

        await expect(controller.triggerRebalance()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('translates RebalanceTriggerRejectedException to HTTP 400 BadRequestException', async () => {
        triggerRebalanceDue.mockRejectedValue(new RebalanceTriggerRejectedException('within cooldown'));
        const moduleRef = await buildModule();
        const controller = moduleRef.get(RebalanceDevController);

        await expect(controller.triggerRebalance()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is decorated with admin scope (smoke — guard metadata present on handler)', () => {
        const scopes = Reflect.getMetadata(REQUIRED_SCOPES_METADATA_KEY, RebalanceDevController.prototype.triggerRebalance);

        expect(scopes).toEqual([AuthScopeEnum.ADMIN]);
    });
});

// ─── HTTP rate limit (security review, defense-in-depth) ──────────────────────
//
// ThrottlerGuard is applied to POST /v1/control/trigger-rebalance so unauthenticated /
// invalid-token spam is bounded independently of the AuthGuard. AuthGuard is overridden to allow
// so this test isolates the throttle: the first request is served (200), a second within the
// 1-per-60s window is rejected (429) — a real HTTP round-trip through the guard pipeline (guards
// do NOT run on direct method calls, so this must go over the wire).
describe('RebalanceDevController — throttler rate limit', () => {
    const triggerRebalanceDue = jest.fn().mockResolvedValue({ accepted: true, nowMs: 1_700_000_000_000 });
    let app: INestApplication;
    let baseUrl: string;

    beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ThrottlerModule.forRoot([{ ttl: REBALANCE_TRIGGER_RATE_TTL_MS, limit: REBALANCE_TRIGGER_RATE_LIMIT }])],
            controllers: [RebalanceDevController],
            providers: [{ provide: RebalanceSchedulerService, useValue: { triggerRebalanceDue } }],
        })
            .overrideGuard(AuthGuard)
            .useValue({ canActivate: () => true })
            .compile();

        app = moduleRef.createNestApplication();
        await app.listen(0);
        baseUrl = await app.getUrl();
    });

    afterEach(async () => {
        await app.close();
    });

    it('serves the first request (200) then rejects the second within the window (429)', async () => {
        const first = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });
        const second = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });

        expect(first.status).toBe(200);
        expect(second.status).toBe(429);
    });

    // Nest's default ThrottlerGuard trackers key on the REQUEST IP, not on any auth
    // credential. Two requests carrying DIFFERENT Authorization headers but originating from
    // the SAME IP (both hit the loopback test server here) therefore share ONE throttle bucket —
    // a legitimate operator token can be blocked by another caller's request sharing the same
    // origin. This test documents that behavior explicitly so a future default-tracker change is
    // a deliberate, reviewed decision rather than a silent regression.
    it('scopes the throttle bucket per source IP, not per caller/token — a second caller from the same IP is also blocked', async () => {
        const first = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, {
            method: 'POST',
            headers: { Authorization: 'Bearer caller-a-token' },
        });
        const second = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, {
            method: 'POST',
            headers: { Authorization: 'Bearer caller-b-token' },
        });

        expect(first.status).toBe(200);
        // Blocked by the shared IP-scoped bucket, not by AuthGuard (which is stubbed to allow
        // everything in this test) — proves the throttle key is IP-based, not token-based.
        expect(second.status).toBe(429);
    });

    it('a 429 response does not leak the scheduler result or any internal error detail', async () => {
        const first = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });
        const second = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });

        expect(first.status).toBe(200);
        expect(second.status).toBe(429);

        const body = (await second.json()) as Record<string, unknown>;
        // Only the generic Nest throttler shape — no scheduler payload (accepted/nowMs), no
        // stack trace, no internal message beyond the fixed "Too Many Requests" text.
        expect(body).not.toHaveProperty('accepted');
        expect(body).not.toHaveProperty('nowMs');
        expect(body).not.toHaveProperty('stack');
        expect(String(body['message'] ?? '')).not.toMatch(/at\s+\S+\(.*:\d+:\d+\)/u); // no stack-trace-shaped text
    });
});

// ─── throttle-before-auth ordering (guard order in @UseGuards matters) ───────
//
// @UseGuards(ThrottlerGuard, AuthGuard) runs ThrottlerGuard FIRST. An unauthenticated /
// invalid-token request must still be counted against the rate limit — not short-circuited by a
// 401 before the throttle counter increments — so unauthenticated spam cannot bypass the
// defense-in-depth rate limit by never presenting a token. AuthGuard is overridden with a stub
// that mirrors ONLY its documented missing-header behavior (401, AuthFailureReasonEnum-shaped
// deny) — this isolates the assertion to guard ORDERING (a property of the @UseGuards decorator
// list, not of AuthGuard's internal token-verification logic) without wiring AuthGuard's full
// AuthTokenService / REVOKED_JTI_REPOSITORY dependency graph.
describe('RebalanceDevController — throttle runs before auth (unauthenticated requests still count)', () => {
    const triggerRebalanceDue = jest.fn().mockResolvedValue({ accepted: true, nowMs: 1_700_000_000_000 });
    let app: INestApplication;
    let baseUrl: string;

    beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ThrottlerModule.forRoot([{ ttl: REBALANCE_TRIGGER_RATE_TTL_MS, limit: REBALANCE_TRIGGER_RATE_LIMIT }])],
            controllers: [RebalanceDevController],
            providers: [{ provide: RebalanceSchedulerService, useValue: { triggerRebalanceDue } }],
        })
            .overrideGuard(AuthGuard)
            .useValue({
                canActivate: (context: ExecutionContext) => {
                    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();

                    if (typeof request.headers.authorization !== 'string' || request.headers.authorization.length === 0) {
                        throw new UnauthorizedException('missing bearer token');
                    }

                    return true;
                },
            })
            .compile();

        app = moduleRef.createNestApplication();
        await app.listen(0);
        baseUrl = await app.getUrl();
    });

    afterEach(async () => {
        await app.close();
    });

    it('an unauthenticated request is rejected by AuthGuard but still consumes the throttle budget', async () => {
        // No Authorization header — the stub AuthGuard rejects with 401.
        const first = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });
        expect(first.status).toBe(401);

        // A second unauthenticated request within the same window: if ThrottlerGuard ran AFTER
        // auth (or did not count unauthenticated hits), this would also be a plain 401. Because
        // ThrottlerGuard is listed FIRST in @UseGuards, it evaluates before AuthGuard and the
        // budget (limit=1) is already exhausted — the second request is rejected with 429, not 401.
        const second = await fetch(`${baseUrl}/v1/control/trigger-rebalance`, { method: 'POST' });
        expect(second.status).toBe(429);

        expect(triggerRebalanceDue).not.toHaveBeenCalled();
    });
});

// ─── PortfolioStrategyModule registration gate (compile-time env check) ──────
//
// The controller's own AuthGuard + admin-scope check is a runtime 403 — but PortfolioStrategyModule
// ALSO decides, at static @Module evaluation time (module import, not DI resolution), whether
// RebalanceDevController is even part of the controllers array. A non-paper env must mean the
// controller genuinely does not exist in the Nest DI graph, not merely that it 403s. Since the
// gating reads process.env.EXCHANGE_ENV once at module-file evaluation, each case here forces a
// fresh module evaluation (jest.isolateModules) under a controlled env value and inspects the
// @Module controllers metadata directly — no DI compilation, so no dependency on the module's
// heavy real providers (DB-backed repositories, etc).
describe('PortfolioStrategyModule — RebalanceDevController registration gate', () => {
    const originalExchangeEnv = process.env.EXCHANGE_ENV;

    afterEach(() => {
        if (originalExchangeEnv === undefined) {
            delete process.env.EXCHANGE_ENV;
        } else {
            process.env.EXCHANGE_ENV = originalExchangeEnv;
        }
    });

    // PortfolioStrategyModule statically imports AuthModule / MarketDataModule / RiskModule /
    // PositionModule / StrategyModule purely for the @Module `imports` array — none of their real
    // providers are instantiated to read `controllers` metadata. Those siblings pull in
    // AppConfigModule (which runs env validation as an IMPORT-TIME side effect via
    // ConfigModule.forRoot), so real requires would blow up outside a fully-populated env. Stubbing
    // them here keeps this test isolated to the one thing under test: the static controllers array.
    function loadControllersUnderEnv(exchangeEnv: string | undefined): unknown[] {
        if (exchangeEnv === undefined) {
            delete process.env.EXCHANGE_ENV;
        } else {
            process.env.EXCHANGE_ENV = exchangeEnv;
        }

        let controllers: unknown[] = [];

        jest.isolateModules(() => {
            jest.doMock('../../src/auth/AuthModule', () => ({
                AuthModule: class StubAuthModule {},
                AuthTokenService: class StubAuthTokenService {},
                RevokedJtiRepository: class StubRevokedJtiRepository {},
            }));
            jest.doMock('../../src/market-data/MarketDataModule', () => ({ MarketDataModule: class StubMarketDataModule {} }));
            jest.doMock('../../src/risk/RiskModule', () => ({ RiskModule: class StubRiskModule {} }));
            jest.doMock('../../src/position/PositionModule', () => ({ PositionModule: class StubPositionModule {} }));
            jest.doMock('../../src/strategy/StrategyModule', () => ({ StrategyModule: class StubStrategyModule {} }));

            // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.isolateModules requires synchronous CJS require to force fresh module evaluation under a mocked env
            const { PortfolioStrategyModule } = require('../../src/strategy/PortfolioStrategyModule');
            controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PortfolioStrategyModule) ?? []) as unknown[];
        });

        return controllers;
    }

    it('registers RebalanceDevController when EXCHANGE_ENV=paper', () => {
        // jest.isolateModules gives a fresh module registry, so the loaded class is a distinct
        // reference from the outer-scope import — assert by name, not by identity.
        const controllers = loadControllersUnderEnv('paper');

        expect(controllers).toHaveLength(1);
        expect((controllers[0] as { name: string }).name).toBe(RebalanceDevController.name);
    });

    it('does NOT register RebalanceDevController when EXCHANGE_ENV=live', () => {
        const controllers = loadControllersUnderEnv('live');

        expect(controllers).toHaveLength(0);
    });

    it('does NOT register RebalanceDevController when EXCHANGE_ENV=testnet', () => {
        const controllers = loadControllersUnderEnv('testnet');

        expect(controllers).toHaveLength(0);
    });

    it('does NOT register RebalanceDevController when EXCHANGE_ENV is unset entirely', () => {
        const controllers = loadControllersUnderEnv(undefined);

        expect(controllers).toHaveLength(0);
    });

    it('does NOT register RebalanceDevController when EXCHANGE_ENV is an empty string', () => {
        const controllers = loadControllersUnderEnv('');

        expect(controllers).toHaveLength(0);
    });

    // Strict equality against the enum value — a differently-cased env var must not slip through.
    it('does NOT register RebalanceDevController when EXCHANGE_ENV is uppercase "PAPER"', () => {
        const controllers = loadControllersUnderEnv('PAPER');

        expect(controllers).toHaveLength(0);
    });
});
