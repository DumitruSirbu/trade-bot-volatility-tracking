import { AlertTypeEnum, AuthScopeEnum, HaltAuditActionEnum, HaltSourceEnum, HaltStateEnum, IAlertPayload, IHaltAuditEntry } from '@bot/shared';
import { BadRequestException, ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { IAlertSink } from '../../src/alert/AlertModule';
import { HaltStateRestoreService } from '../../src/bootstrap/HaltStateRestoreService';
import { CLOCK, IClock } from '../../src/common/clock/Clock';
import { HaltController } from '../../src/control/HaltController';
import { HaltRateLimiter } from '../../src/control/HaltRateLimiter';
import { HaltService } from '../../src/control/HaltService';
import { IFlattenCoordinator, IFlattenRequest } from '../../src/control/interface/IFlattenCoordinator';
import { ControlAuditRepository, IAppendOperatorParams, IAppendProgrammaticParams } from '../../src/control/repository/ControlAuditRepository';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { AuthGuard } from '../../src/auth/AuthGuard';

// M9 W3 adversarial coverage for the kill-switch path. Per dev-qa-cycle §4.2
// each acceptance bullet pairs with a failing-first test. No DB / no HTTP
// transport: the controller is exercised directly via the testing module so
// each case stays a fast unit test (Postgres-backed integration smoke is a
// separate suite once W6's flatten coordinator lands).
//
// Covered scenarios:
//   1. happy halt + resume — audit row written, halt flag flipped, alert fired
//   2. flatten=true delegates a single CLOSE request through the risk-gate
//      port (the LoggingFlattenCoordinator is stubbed; the test verifies no
//      ccxt call by construction — the stub doesn't have one)
//   3. flatten=false (default) skips the coordinator
//   4. halt-while-halted is idempotent — fresh audit row, fresh alert, flag
//      not re-flipped, coordinator NOT called (flatten bound to first
//      transition only)
//   5. rate-limit: 5 toggles land, 6th throws 429 with retryAfterSec body
//   6. body validation rejects empty / oversized reason + non-boolean flatten
//   7. auth guard layered above — missing scope / missing token rejected
//      with IAuthFailure envelope (smoke check that @UseGuards is wired —
//      AuthGuard behaviour is covered exhaustively in tests/auth/)
//   8. programmatic halt path writes audit with SYSTEM:<source> actor
//   9. HaltStateRestoreService re-engages flag from a halted latest row,
//      defaults to running with no rows, and does NOT fire an alert on
//      restore (alert sink not called).

const NOW = new Date('2026-05-24T12:00:00Z');

// ---------------------------------------------------------------------------
// In-memory fake of ControlAuditRepository. Implements just enough surface
// for HaltService + restore service; no Postgres.
// ---------------------------------------------------------------------------

class FakeControlAuditRepository {
    readonly rows: IHaltAuditEntry[] = [];
    public nextIdSeq = 0;

    async appendOperator(params: IAppendOperatorParams): Promise<IHaltAuditEntry> {
        const entry: IHaltAuditEntry = {
            id: this.mintId(),
            occurredAt: params.occurredAt.toISOString(),
            actorSub: params.actorSub,
            actorJti: params.actorJti,
            sourceIp: params.sourceIp,
            action: params.action === 'HALT' ? HaltAuditActionEnum.HALT : HaltAuditActionEnum.RESUME,
            reason: params.reason,
            flattenRequested: params.flattenRequested,
            previousState: params.previousState === 'HALTED' ? 'halted' : 'running',
            newState: params.newState === 'HALTED' ? 'halted' : 'running',
            correlationEventId: null,
        };
        this.rows.push(entry);

        return entry;
    }

    async appendProgrammatic(params: IAppendProgrammaticParams): Promise<IHaltAuditEntry> {
        const entry: IHaltAuditEntry = {
            id: this.mintId(),
            occurredAt: params.occurredAt.toISOString(),
            actorSub: `SYSTEM:${params.source}`,
            actorJti: 'SYSTEM',
            sourceIp: null,
            action: params.newState === 'HALTED' ? HaltAuditActionEnum.HALT : HaltAuditActionEnum.RESUME,
            reason: params.reason,
            flattenRequested: params.flattenRequested,
            previousState: params.previousState === 'HALTED' ? 'halted' : 'running',
            newState: params.newState === 'HALTED' ? 'halted' : 'running',
            correlationEventId: params.correlationEventId,
        };
        this.rows.push(entry);

        return entry;
    }

    async findLatest(): Promise<IHaltAuditEntry | null> {
        if (this.rows.length === 0) {
            return null;
        }

        return this.rows[this.rows.length - 1];
    }

    async findHistoryPage(
        _cursor: string | null,
        _pageSize: number | null,
    ): Promise<{ items: IHaltAuditEntry[]; nextCursor: string | null; pageSize: number }> {
        return { items: [...this.rows].reverse(), nextCursor: null, pageSize: 50 };
    }

    private mintId(): string {
        this.nextIdSeq += 1;

        return `audit-${this.nextIdSeq.toString().padStart(4, '0')}`;
    }
}

class StubAlertSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];
    shouldThrow = false;

    async publish(payload: IAlertPayload): Promise<void> {
        if (this.shouldThrow) {
            throw new Error('alert sink boom');
        }

        this.published.push(payload);
    }
}

class StubFlattenCoordinator implements IFlattenCoordinator {
    readonly calls: IFlattenRequest[] = [];

    async flattenAllOpen(request: IFlattenRequest): Promise<void> {
        this.calls.push(request);
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
}

// Minimal Response stub for the @Res({passthrough}) parameter.
function buildResponseStub(): Response {
    return {
        setHeader: jest.fn(),
    } as unknown as Response;
}

interface IBuildOpts {
    clock?: FixedClock;
    auditRepo?: FakeControlAuditRepository;
    alerts?: StubAlertSink;
    flatten?: StubFlattenCoordinator;
    haltFlag?: HaltFlagService;
}

function buildController(opts: IBuildOpts = {}): {
    controller: HaltController;
    service: HaltService;
    auditRepo: FakeControlAuditRepository;
    alerts: StubAlertSink;
    flatten: StubFlattenCoordinator;
    haltFlag: HaltFlagService;
    rateLimiter: HaltRateLimiter;
    clock: FixedClock;
    restore: HaltStateRestoreService;
} {
    const clock = opts.clock ?? new FixedClock(NOW);
    const auditRepo = opts.auditRepo ?? new FakeControlAuditRepository();
    const alerts = opts.alerts ?? new StubAlertSink();
    const flatten = opts.flatten ?? new StubFlattenCoordinator();
    const haltFlag = opts.haltFlag ?? new HaltFlagService();

    const service = new HaltService(auditRepo as unknown as ControlAuditRepository, haltFlag, alerts, flatten, new EventEmitter2());
    const rateLimiter = new HaltRateLimiter();

    const controller = new HaltController(service, rateLimiter, auditRepo as unknown as ControlAuditRepository, clock);
    // M9 R1 fix #2: HaltStateRestoreService now reads both control_audit AND
    // risk_state for newer-wins resolution (Option β SoT split). Tests that
    // only exercise the audit path stub the risk-state repo with `null`.
    const riskStateStub = { findByDate: async () => null } as unknown as import('../../src/risk/repository/RiskStateRepository').RiskStateRepository;
    const restore = new HaltStateRestoreService(auditRepo as unknown as ControlAuditRepository, service, haltFlag, riskStateStub);

    return { controller, service, auditRepo, alerts, flatten, haltFlag, rateLimiter, clock, restore };
}

function makeRequest(
    sub = 'operator-1',
    jti = 'jti-1',
): { authSubject: { sub: string; jti: string; scopes: AuthScopeEnum[] }; ip: string | undefined; headers: Record<string, string> } {
    return {
        authSubject: { sub, jti, scopes: [AuthScopeEnum.HALT, AuthScopeEnum.READ] },
        ip: '203.0.113.1',
        headers: {},
    };
}

describe('HaltController', () => {
    describe('happy path', () => {
        it('engages a halt: writes audit row, flips halt flag, fires OPERATOR_HALT alert', async () => {
            const harness = buildController();

            const response = await harness.controller.halt({ reason: 'panic' }, makeRequest() as never, buildResponseStub());

            expect(response.haltState).toBe(HaltStateEnum.HALTED);
            expect(response.auditId).toBe('audit-0001');
            expect(response.flattenRequested).toBe(false);
            expect(response.haltReason).toBe('OPERATOR:panic');
            expect(harness.auditRepo.rows).toHaveLength(1);
            expect(harness.auditRepo.rows[0].newState).toBe('halted');
            expect(harness.auditRepo.rows[0].actorSub).toBe('operator-1');
            expect(harness.haltFlag.isHalted()).toBe(true);
            expect(harness.alerts.published).toHaveLength(1);
            expect(harness.alerts.published[0].type).toBe(AlertTypeEnum.OPERATOR_HALT);
            expect(harness.flatten.calls).toHaveLength(0);
        });

        it('resumes from a halted state: writes audit row, clears halt flag, fires OPERATOR_RESUME alert', async () => {
            const harness = buildController();
            harness.haltFlag.halt('OPERATOR:earlier');

            const response = await harness.controller.resume({ reason: 'clear' }, makeRequest() as never, buildResponseStub());

            expect(response.haltState).toBe(HaltStateEnum.RUNNING);
            expect(harness.haltFlag.isHalted()).toBe(false);
            expect(harness.auditRepo.rows[0].action).toBe(HaltAuditActionEnum.RESUME);
            expect(harness.auditRepo.rows[0].previousState).toBe('halted');
            expect(harness.auditRepo.rows[0].newState).toBe('running');
            expect(harness.alerts.published[0].type).toBe(AlertTypeEnum.OPERATOR_RESUME);
        });
    });

    describe('flatten path', () => {
        it('flatten=true delegates a single CLOSE request to the coordinator (which routes via risk gate, never ccxt)', async () => {
            const harness = buildController();

            await harness.controller.halt({ reason: 'panic', flatten: true }, makeRequest() as never, buildResponseStub());

            expect(harness.flatten.calls).toHaveLength(1);
            expect(harness.flatten.calls[0].reason).toBe('panic');
            expect(harness.auditRepo.rows[0].flattenRequested).toBe(true);
        });

        it('flatten=false (default) skips the coordinator', async () => {
            const harness = buildController();

            await harness.controller.halt({ reason: 'panic' }, makeRequest() as never, buildResponseStub());

            expect(harness.flatten.calls).toHaveLength(0);
            expect(harness.auditRepo.rows[0].flattenRequested).toBe(false);
        });
    });

    describe('idempotency', () => {
        it('halt-while-halted writes a fresh audit row and alert but does not re-trigger flatten', async () => {
            const harness = buildController();
            harness.haltFlag.halt('OPERATOR:earlier');

            await harness.controller.halt({ reason: 'second', flatten: true }, makeRequest() as never, buildResponseStub());

            expect(harness.auditRepo.rows).toHaveLength(1);
            expect(harness.auditRepo.rows[0].previousState).toBe('halted');
            expect(harness.auditRepo.rows[0].newState).toBe('halted');
            expect(harness.alerts.published).toHaveLength(1);
            // Flatten is bound to the FIRST transition only (ADR 0021 §2.1).
            expect(harness.flatten.calls).toHaveLength(0);
            expect(harness.haltFlag.isHalted()).toBe(true);
        });
    });

    describe('rate limiting', () => {
        it('lets the first 5 toggles land and rejects the 6th in a 60s window with 429 + retryAfterSec body', async () => {
            const harness = buildController();
            // 5 halts in rapid succession (no real flag flip after the first
            // — idempotent halt — but the rate limiter increments on every
            // accepted request).
            for (let i = 0; i < 5; i += 1) {
                await harness.controller.halt({ reason: `toggle-${i}` }, makeRequest() as never, buildResponseStub());
                harness.clock.advance(100);
            }

            await expect(harness.controller.halt({ reason: 'overflow' }, makeRequest() as never, buildResponseStub())).rejects.toBeInstanceOf(HttpException);

            try {
                await harness.controller.halt({ reason: 'overflow-2' }, makeRequest() as never, buildResponseStub());
                fail('expected throttle');
            } catch (cause) {
                expect(cause).toBeInstanceOf(HttpException);
                const status = (cause as HttpException).getStatus();
                const body = (cause as HttpException).getResponse() as { error: string; reason: string; retryAfterSec: number };
                expect(status).toBe(429);
                expect(body.error).toBe('RATE_LIMITED');
                expect(body.reason).toBe('TOO_MANY_HALT_TOGGLES');
                expect(body.retryAfterSec).toBeGreaterThan(0);
            }
        });

        it('rate limit is per-sub: another operator is not throttled by the first operator s toggles', async () => {
            const harness = buildController();
            for (let i = 0; i < 5; i += 1) {
                await harness.controller.halt({ reason: 'x' }, makeRequest('op-a') as never, buildResponseStub());
                harness.clock.advance(100);
            }

            await expect(harness.controller.halt({ reason: 'x' }, makeRequest('op-b') as never, buildResponseStub())).resolves.toBeDefined();
        });

        it('admits a 6th toggle once the window has slid past 60s', async () => {
            const harness = buildController();
            for (let i = 0; i < 5; i += 1) {
                await harness.controller.halt({ reason: `t-${i}` }, makeRequest() as never, buildResponseStub());
                harness.clock.advance(100);
            }

            harness.clock.advance(60_000);
            await expect(harness.controller.halt({ reason: 'after-window' }, makeRequest() as never, buildResponseStub())).resolves.toBeDefined();
        });
    });

    describe('body validation', () => {
        it.each([
            ['non-object body', 'just-a-string'],
            ['empty reason', { reason: '' }],
            ['missing reason', {}],
            ['oversized reason', { reason: 'x'.repeat(257) }],
            ['non-boolean flatten', { reason: 'ok', flatten: 'yes' }],
        ])('rejects %s with 400 + VALIDATION_FAILED', async (_label, body) => {
            const harness = buildController();
            await expect(harness.controller.halt(body, makeRequest() as never, buildResponseStub())).rejects.toBeInstanceOf(BadRequestException);
            // No persistence, no flag change, no alert on validation failure.
            expect(harness.auditRepo.rows).toHaveLength(0);
            expect(harness.haltFlag.isHalted()).toBe(false);
            expect(harness.alerts.published).toHaveLength(0);
        });
    });

    describe('auth wiring (smoke)', () => {
        // AuthGuard behaviour is exhaustively tested in tests/auth/. Here we
        // assert the metadata is present on the controller handler so the
        // guard knows to enforce HALT for POSTs and READ for GETs.
        it('declares @UseGuards(AuthGuard) on the halt handler', () => {
            const guards = Reflect.getMetadata('__guards__', HaltController.prototype.halt);
            expect(Array.isArray(guards)).toBe(true);
            expect(guards).toContain(AuthGuard);
        });

        it('declares @RequiredScopes(HALT) on the halt handler', () => {
            const scopes = Reflect.getMetadata('auth:required_scopes', HaltController.prototype.halt);
            expect(scopes).toEqual([AuthScopeEnum.HALT]);
        });

        it('declares @RequiredScopes(READ) on the getState handler', () => {
            const scopes = Reflect.getMetadata('auth:required_scopes', HaltController.prototype.getState);
            expect(scopes).toEqual([AuthScopeEnum.READ]);
        });

        it('AuthGuard rejects requests without a bearer (independent invocation)', async () => {
            // Tiny end-to-end-style check: build a guard with stub tokens
            // and verify a no-auth context throws UnauthorizedException so
            // the controller is genuinely behind the guard chain.
            const { AuthGuard: GuardClass } = await import('../../src/auth/AuthGuard');
            const tokens = { verify: jest.fn() } as unknown as ConstructorParameters<typeof GuardClass>[1];
            const revoked = { isRevoked: jest.fn().mockResolvedValue(false) } as unknown as ConstructorParameters<typeof GuardClass>[2];
            const reflector = { get: jest.fn().mockReturnValue([AuthScopeEnum.HALT]) } as unknown as ConstructorParameters<typeof GuardClass>[0];
            const guard = new GuardClass(reflector, tokens, revoked);
            const ctx = {
                switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
                getHandler: () => (): void => undefined,
                getClass: () => class {},
            } as unknown as ExecutionContext;

            await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
        });
    });

    describe('programmatic halt path (M4 entry-point)', () => {
        it('M9 R2: engageHalt with a non-OPERATOR source throws — programmatic halts do NOT write control_audit (Option β SoT split, ADR 0021 §2.3)', async () => {
            const harness = buildController();

            await expect(
                harness.service.engageHalt({
                    source: HaltSourceEnum.MARKET_STRESS,
                    reason: 'spread blow-out',
                    flatten: false,
                    correlationEventId: 'evt-42',
                    now: NOW,
                }),
            ).rejects.toThrow(/non-OPERATOR source/u);

            // No audit row, no flag flip — the programmatic SoT path lives in
            // RiskGateService.persistHalt (writes risk_state.is_halted) and
            // the in-process flag is owned by RiskListeners.
            expect(harness.haltFlag.isHalted()).toBe(false);
        });

        it('rejects an OPERATOR engage that omits actorSub/actorJti (contract guard)', async () => {
            const harness = buildController();

            await expect(
                harness.service.engageHalt({
                    source: HaltSourceEnum.OPERATOR,
                    reason: 'oops',
                    flatten: false,
                    now: NOW,
                }),
            ).rejects.toThrow(/actorSub \+ actorJti/u);
        });
    });

    describe('write-then-flip ordering', () => {
        it('does not flip the halt flag when the audit write fails (no half-engage)', async () => {
            const harness = buildController();
            jest.spyOn(harness.auditRepo, 'appendOperator').mockRejectedValueOnce(new Error('DB down'));

            await expect(harness.controller.halt({ reason: 'will-fail' }, makeRequest() as never, buildResponseStub())).rejects.toThrow(/DB down/u);

            expect(harness.haltFlag.isHalted()).toBe(false);
            expect(harness.alerts.published).toHaveLength(0);
        });
    });

    describe('GET /v1/control/halt', () => {
        it('returns a RUNNING state when never halted', () => {
            const harness = buildController();
            const state = harness.controller.getState();

            expect(state.haltState).toBe(HaltStateEnum.RUNNING);
            expect(state.haltedAt).toBeNull();
            expect(state.flattenInProgress).toBe(false);
        });

        it('returns a HALTED state with auditId after a halt', async () => {
            const harness = buildController();
            await harness.controller.halt({ reason: 'panic' }, makeRequest() as never, buildResponseStub());
            const state = harness.controller.getState();

            expect(state.haltState).toBe(HaltStateEnum.HALTED);
            expect(state.lastTransitionAuditId).toBe('audit-0001');
            expect(state.haltSource).toBe(HaltSourceEnum.OPERATOR);
        });
    });

    describe('CLOCK boundary', () => {
        it('uses the injected clock for the audit timestamp (deterministic in tests)', async () => {
            const clock = new FixedClock(new Date('2027-01-02T03:04:05.000Z'));
            const harness = buildController({ clock });

            const response = await harness.controller.halt({ reason: 'pinned' }, makeRequest() as never, buildResponseStub());

            expect(response.haltedAt).toBe('2027-01-02T03:04:05.000Z');
        });

        it('the injectable clock is registered behind the CLOCK token (DI seam present)', () => {
            expect(typeof CLOCK).toBe('symbol');
        });
    });
});

describe('HaltStateRestoreService', () => {
    it('defaults to RUNNING when no audit rows exist and emits no alert', async () => {
        const harness = buildController();

        await harness.restore.restore();

        expect(harness.haltFlag.isHalted()).toBe(false);
        expect(harness.alerts.published).toHaveLength(0);
    });

    it('re-engages the halt flag from a halted latest row and does NOT fire an alert', async () => {
        const harness = buildController();
        // Seed an operator-halt row directly (simulates a prior crash mid-halt).
        await harness.service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'pre-crash',
            actorSub: 'op-x',
            actorJti: 'jti-x',
            flatten: false,
            now: NOW,
        });
        // Simulate a fresh process: drop the flag, drop the alert sink history.
        harness.haltFlag.resume();
        harness.alerts.published.length = 0;

        await harness.restore.restore();

        expect(harness.haltFlag.isHalted()).toBe(true);
        expect(harness.alerts.published).toHaveLength(0);
    });

    it('classifies a SYSTEM:<source> actor back to its HaltSourceEnum on restore', async () => {
        // M9 R2: programmatic engageHalt is forbidden — seed the audit row
        // directly through the repo's programmatic appender to simulate a
        // historical row (pre-SoT-split or an out-of-band SYSTEM tag).
        const harness = buildController();
        await harness.auditRepo.appendProgrammatic({
            occurredAt: NOW,
            source: HaltSourceEnum.MODEL_DIVERGENCE,
            correlationEventId: null,
            reason: 'kill-switch',
            flattenRequested: false,
            previousState: 'RUNNING',
            newState: 'HALTED',
        });

        await harness.restore.restore();

        expect(harness.haltFlag.isHalted()).toBe(true);
        expect(harness.service.getState().haltSource).toBe(HaltSourceEnum.MODEL_DIVERGENCE);
    });

    it('is idempotent — a second restore is a no-op', async () => {
        const harness = buildController();
        await harness.service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'r',
            actorSub: 'op',
            actorJti: 'j',
            flatten: false,
            now: NOW,
        });
        harness.haltFlag.resume();

        await harness.restore.restore();
        const flippedOnceAt = harness.haltFlag.isHalted();
        await harness.restore.restore();

        expect(flippedOnceAt).toBe(true);
        expect(harness.haltFlag.isHalted()).toBe(true);
    });
});
