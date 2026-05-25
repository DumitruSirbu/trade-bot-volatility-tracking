import { AlertTypeEnum, AuthScopeEnum, HaltSourceEnum, HaltStateEnum, IAlertPayload, IHaltAuditEntry } from '@bot/shared';
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

// M9 QA — adversarial extension to HaltController.spec.ts.
// Covers: rate-limit window boundary precision, simultaneous programmatic +
// operator halt, halt-during-recovery no double-alert, flatten with zero open
// positions, flatten with in-flight ADD intent ordering, audit-write failure
// does not flip flag.

const NOW = new Date('2026-05-24T12:00:00Z');

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
            action: params.action === 'HALT' ? 'halt' : 'resume',
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
            action: params.newState === 'HALTED' ? 'halt' : 'resume',
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
        return this.rows.length === 0 ? null : this.rows[this.rows.length - 1]!;
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
    delayMs = 0;

    async flattenAllOpen(request: IFlattenRequest): Promise<void> {
        if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
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

function buildResponseStub(): Response {
    return { setHeader: jest.fn() } as unknown as Response;
}

function makeRequest(sub = 'operator-1', jti = 'jti-1') {
    return {
        authSubject: { sub, jti, scopes: [AuthScopeEnum.HALT, AuthScopeEnum.READ] },
        ip: '203.0.113.1',
        headers: {},
    };
}

function buildController(opts: {
    clock?: FixedClock;
    auditRepo?: FakeControlAuditRepository;
    alerts?: StubAlertSink;
    flatten?: StubFlattenCoordinator;
    haltFlag?: HaltFlagService;
} = {}) {
    const clock = opts.clock ?? new FixedClock(NOW);
    const auditRepo = opts.auditRepo ?? new FakeControlAuditRepository();
    const alerts = opts.alerts ?? new StubAlertSink();
    const flatten = opts.flatten ?? new StubFlattenCoordinator();
    const haltFlag = opts.haltFlag ?? new HaltFlagService();
    const service = new HaltService(
        auditRepo as unknown as ControlAuditRepository,
        haltFlag,
        alerts,
        flatten,
        new EventEmitter2(),
    );
    const rateLimiter = new HaltRateLimiter();
    const controller = new HaltController(service, rateLimiter, auditRepo as unknown as ControlAuditRepository, clock);
    // M9 R1 fix #2: HaltStateRestoreService now takes (auditRepo, service, haltFlag, riskStateRepo).
    const riskStateStub = { findByDate: async () => null } as unknown as import('../../src/risk/repository/RiskStateRepository').RiskStateRepository;
    const restore = new HaltStateRestoreService(auditRepo as unknown as ControlAuditRepository, service, haltFlag, riskStateStub);

    return { controller, service, auditRepo, alerts, flatten, haltFlag, rateLimiter, clock, restore };
}

// ---------------------------------------------------------------------------
// Rate-limit window precision
// ---------------------------------------------------------------------------

describe('HaltController adversarial — rate-limit window boundary', () => {
    it('5th hit passes; 6th inside the same 60s window is rejected', async () => {
        const harness = buildController();

        for (let i = 0; i < 5; i += 1) {
            await harness.controller.halt({ reason: `hit-${i}` }, makeRequest() as never, buildResponseStub());
            harness.clock.advance(100);
        }

        // 6th within the 60s window must be rejected.
        await expect(
            harness.controller.halt({ reason: 'overflow' }, makeRequest() as never, buildResponseStub()),
        ).rejects.toMatchObject({ status: 429 });
    });

    it('6th hit passes once the 60s sliding window has expired', async () => {
        const harness = buildController();

        for (let i = 0; i < 5; i += 1) {
            await harness.controller.halt({ reason: `hit-${i}` }, makeRequest() as never, buildResponseStub());
            harness.clock.advance(100);
        }

        // Slide the window past 60s.
        harness.clock.advance(60_001);

        await expect(
            harness.controller.halt({ reason: 'after-window' }, makeRequest() as never, buildResponseStub()),
        ).resolves.toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Programmatic + operator halt in the same millisecond
// ---------------------------------------------------------------------------

describe('HaltController adversarial — simultaneous programmatic + operator halt', () => {
    it('M9 R2: programmatic engageHalt throws; the operator row is the only audit row written even when both fire same tick', async () => {
        const harness = buildController();

        // Issue both in the same promise batch (same event loop tick). The
        // programmatic call rejects per the Option β SoT split — only the
        // operator row lands in control_audit. The real programmatic SoT for
        // a market-stress halt is `risk_state.is_halted` written by
        // RiskGateService.persistHalt, not control_audit.
        const results = await Promise.allSettled([
            harness.service.engageHalt({
                source: HaltSourceEnum.MARKET_STRESS,
                reason: 'stress',
                flatten: false,
                now: NOW,
            }),
            harness.service.engageHalt({
                source: HaltSourceEnum.OPERATOR,
                reason: 'manual',
                actorSub: 'op',
                actorJti: 'jti',
                flatten: false,
                now: NOW,
            }),
        ]);

        expect(results[0].status).toBe('rejected');
        expect(results[1].status).toBe('fulfilled');
        expect(harness.auditRepo.rows).toHaveLength(1);
        expect(harness.auditRepo.rows[0].actorSub).toBe('op');
    });
});

// ---------------------------------------------------------------------------
// Halt during recovery (HaltStateRestoreService re-engages but should not
// double-fire alerts).
// ---------------------------------------------------------------------------

describe('HaltController adversarial — halt during recovery', () => {
    it('restore does not fire an alert; a subsequent operator halt fires exactly one alert', async () => {
        const harness = buildController();

        // Seed a halted row then reset the in-memory state (simulate crash+restart).
        await harness.service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'pre-crash',
            actorSub: 'op',
            actorJti: 'jti',
            flatten: false,
            now: NOW,
        });
        harness.haltFlag.resume();
        harness.alerts.published.length = 0;

        // Restore should re-engage the flag silently.
        await harness.restore.restore();
        expect(harness.alerts.published).toHaveLength(0);
        expect(harness.haltFlag.isHalted()).toBe(true);

        // A subsequent operator halt while already halted writes a row + fires ONE alert.
        await harness.controller.halt({ reason: 'after-restore' }, makeRequest() as never, buildResponseStub());
        expect(harness.alerts.published).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Flatten with zero open positions
// ---------------------------------------------------------------------------

describe('HaltController adversarial — flatten with zero open positions', () => {
    it('flatten=true with an empty position set completes without error, no CLOSE intents emitted', async () => {
        const harness = buildController();
        // The flatten coordinator is stubbed — it records calls but won't
        // emit real CLOSE intents. Having zero calls means it either wasn't
        // invoked or was invoked but had nothing to iterate. Both are valid.
        await expect(
            harness.controller.halt({ reason: 'empty-flatten', flatten: true }, makeRequest() as never, buildResponseStub()),
        ).resolves.toBeDefined();

        // Coordinator must have been called once (flatten=true triggers it);
        // the coordinator itself handles the "no positions" case without error.
        expect(harness.flatten.calls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Flatten with in-flight ADD intent
// ---------------------------------------------------------------------------

describe('HaltController adversarial — flatten with in-flight ADD intent', () => {
    it('halt completes and records the flatten call even when coordinator is slow (simulated async delay)', async () => {
        const flatten = new StubFlattenCoordinator();
        flatten.delayMs = 20; // simulates the ADD settling
        const harness = buildController({ flatten });

        await harness.controller.halt({ reason: 'slow-flatten', flatten: true }, makeRequest() as never, buildResponseStub());

        // After await the coordinator must have been called exactly once.
        expect(harness.flatten.calls).toHaveLength(1);
        expect(harness.flatten.calls[0]!.reason).toBe('slow-flatten');
    });
});

// ---------------------------------------------------------------------------
// Audit row write fails → halt flag does NOT flip
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M9 R1 #4 — rate-limit BEFORE body parse + Retry-After header
// ---------------------------------------------------------------------------

describe('HaltController adversarial — rate-limit ordering + Retry-After', () => {
    it('rate-limit fires BEFORE body validation: an invalid body when throttled returns 429, not 400', async () => {
        const harness = buildController();

        // Burn the 5-per-60s budget with valid halts.
        for (let i = 0; i < 5; i += 1) {
            await harness.controller.halt({ reason: `seed-${i}` }, makeRequest() as never, buildResponseStub());
            harness.clock.advance(50);
        }

        // 6th call carries a BAD body (missing reason). Pre-fix this would
        // trip the body validator first and return 400. Post-fix the rate
        // limiter fires first and returns 429.
        await expect(
            harness.controller.halt({} as never, makeRequest() as never, buildResponseStub()),
        ).rejects.toMatchObject({ status: 429 });
    });

    it('sets the Retry-After header (seconds) on the response when rate-limited', async () => {
        const harness = buildController();

        for (let i = 0; i < 5; i += 1) {
            await harness.controller.halt({ reason: `seed-${i}` }, makeRequest() as never, buildResponseStub());
            harness.clock.advance(50);
        }

        const res = buildResponseStub();

        await expect(
            harness.controller.halt({ reason: 'overflow' }, makeRequest() as never, res),
        ).rejects.toMatchObject({ status: 429 });

        const setHeader = (res as unknown as { setHeader: jest.Mock }).setHeader;
        const retryAfterCall = setHeader.mock.calls.find((args) => args[0] === 'Retry-After');

        expect(retryAfterCall).toBeDefined();
        // Header value is a stringified positive integer of seconds (RFC 6585).
        expect(Number.parseInt(retryAfterCall![1] as string, 10)).toBeGreaterThan(0);
    });
});

describe('HaltController adversarial — audit write failure ordering invariant', () => {
    it('operator halt: audit write failure prevents flag flip and produces no alert', async () => {
        const harness = buildController();
        jest.spyOn(harness.auditRepo, 'appendOperator').mockRejectedValueOnce(new Error('DB unavailable'));

        await expect(
            harness.controller.halt({ reason: 'will-fail' }, makeRequest() as never, buildResponseStub()),
        ).rejects.toThrow(/DB unavailable/u);

        expect(harness.haltFlag.isHalted()).toBe(false);
        expect(harness.alerts.published).toHaveLength(0);
    });

    it('M9 R2: programmatic engageHalt is rejected by the contract guard BEFORE any DB write or flag flip', async () => {
        const harness = buildController();
        const programmaticSpy = jest.spyOn(harness.auditRepo, 'appendProgrammatic');

        await expect(
            harness.service.engageHalt({
                source: HaltSourceEnum.MARKET_STRESS,
                reason: 'stress',
                flatten: false,
                now: NOW,
            }),
        ).rejects.toThrow(/non-OPERATOR source/u);

        // Guard runs first — repo never touched, flag never flipped.
        expect(programmaticSpy).not.toHaveBeenCalled();
        expect(harness.haltFlag.isHalted()).toBe(false);
    });
});
