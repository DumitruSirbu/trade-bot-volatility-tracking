import { AlertSeverityEnum, AlertTypeEnum, HaltAuditActionEnum, HaltSourceEnum, IAlertPayload, IHaltAuditEntry } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { IAlertSink } from '../../src/alert/AlertModule';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { HaltService, IResumeParams } from '../../src/control/HaltService';
import { IFlattenCoordinator, IFlattenRequest } from '../../src/control/interface/IFlattenCoordinator';
import { IRiskHaltStatePort } from '../../src/control/interface/IRiskHaltStatePort';
import { ControlAuditRepository, IAppendOperatorParams } from '../../src/control/repository/ControlAuditRepository';

// ADR 0021 §5 (M11a soak fix).
//
// Adversarial unit tests for `HaltService.resume()` covering the new
// `RISK_HALT_STATE_PORT` integration: the gate's hot-path halt SoT
// (`risk_state.is_halted`) must be cleared AFTER the audit row is durable
// and BEFORE the in-memory flag is released, using the exact UTC-day
// string that `RiskGateService` writes.
//
// Covered scenarios:
//   1. Happy path — clearHaltForDate receives today's UTC date string derived
//      from params.now (YYYY-MM-DD).
//   2. Call ordering — clearHaltForDate is called after the audit row write
//      and before haltFlag.resume().
//   3. Idempotent resume (already running) — clearHaltForDate is ALWAYS called
//      even when the in-memory flag is already clear, because the DB may still
//      carry is_halted=true from a prior programmatic halt.
//   4. clearHaltForDate failure after audit write — resume() publishes a
//      CRITICAL alert and re-raises; the in-memory flag is NOT cleared so the
//      system stays safely halted (no half-cleared resume).
//   5. UTC date derivation — boundary cases: last millisecond of a day and
//      exact midnight rollover produce the correct YYYY-MM-DD strings.

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeControlAuditRepository {
    readonly rows: IHaltAuditEntry[] = [];
    private nextSeq = 0;

    async appendOperator(params: IAppendOperatorParams): Promise<IHaltAuditEntry> {
        this.nextSeq += 1;
        const entry: IHaltAuditEntry = {
            id: `audit-${String(this.nextSeq).padStart(4, '0')}`,
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

    async findLatest(): Promise<IHaltAuditEntry | null> {
        return this.rows.length === 0 ? null : this.rows[this.rows.length - 1]!;
    }

    async findHistoryPage(): Promise<{ items: IHaltAuditEntry[]; nextCursor: string | null; pageSize: number }> {
        return { items: [...this.rows].reverse(), nextCursor: null, pageSize: 50 };
    }
}

class StubAlertSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];

    async publish(payload: IAlertPayload): Promise<void> {
        this.published.push(payload);
    }
}

class StubFlattenCoordinator implements IFlattenCoordinator {
    readonly calls: IFlattenRequest[] = [];

    async flattenAllOpen(request: IFlattenRequest): Promise<void> {
        this.calls.push(request);
    }
}

// Ordering-aware risk-halt-state stub. Records each call with a sequence
// number so tests can assert that clearHaltForDate lands in the right window
// relative to the audit write and the flag flip.
class OrderingRiskHaltStatePort implements IRiskHaltStatePort {
    readonly clearedDates: string[] = [];
    readonly callOrder: string[] = [];
    shouldThrow = false;

    async clearHaltForDate(utcDateString: string): Promise<void> {
        if (this.shouldThrow) {
            throw new Error('risk_state clear boom');
        }

        this.clearedDates.push(utcDateString);
        this.callOrder.push('clearHaltForDate');
    }
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

const OPERATOR_SUB = 'operator-1';
const OPERATOR_JTI = 'jti-1';

function buildResumeParams(now: Date, overrides: Partial<IResumeParams> = {}): IResumeParams {
    return {
        source: HaltSourceEnum.OPERATOR,
        reason: 'soak verified',
        actorSub: OPERATOR_SUB,
        actorJti: OPERATOR_JTI,
        sourceIp: '10.0.0.1',
        now,
        ...overrides,
    };
}

interface IHarness {
    service: HaltService;
    auditRepo: FakeControlAuditRepository;
    alerts: StubAlertSink;
    haltFlag: HaltFlagService;
    riskHaltState: OrderingRiskHaltStatePort;
}

function buildHarness(riskHaltState?: OrderingRiskHaltStatePort): IHarness {
    const auditRepo = new FakeControlAuditRepository();
    const alerts = new StubAlertSink();
    const flatten = new StubFlattenCoordinator();
    const haltFlag = new HaltFlagService();
    const port = riskHaltState ?? new OrderingRiskHaltStatePort();

    const service = new HaltService(auditRepo as unknown as ControlAuditRepository, haltFlag, alerts, flatten, port, new EventEmitter2());

    return { service, auditRepo, alerts, haltFlag, riskHaltState: port };
}

// Put the service into a halted state via an operator engage so the in-memory
// flag, the audit repo, and call-order stubs all start from a coherent HALTED
// baseline before each resume test.
async function engageHalt(harness: IHarness, now: Date): Promise<void> {
    await harness.service.engageHalt({
        source: HaltSourceEnum.OPERATOR,
        reason: 'pre-halt',
        actorSub: OPERATOR_SUB,
        actorJti: OPERATOR_JTI,
        flatten: false,
        now,
    });
}

// ---------------------------------------------------------------------------
// 1. Happy path — correct UTC date string passed to clearHaltForDate
// ---------------------------------------------------------------------------

describe('HaltService.resume() — ADR 0021 §5 RISK_HALT_STATE_PORT integration', () => {
    describe("happy path: clearHaltForDate receives today's UTC date from params.now", () => {
        it('passes the ISO date prefix (YYYY-MM-DD) of params.now to clearHaltForDate', async () => {
            const now = new Date('2026-05-28T14:30:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates).toHaveLength(1);
            expect(harness.riskHaltState.clearedDates[0]).toBe('2026-05-28');
        });

        it('returns a RUNNING state after a successful resume', async () => {
            const now = new Date('2026-05-28T14:30:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);

            const result = await harness.service.resume(buildResumeParams(now));

            expect(harness.haltFlag.isHalted()).toBe(false);
            expect(result.flattenDispatched).toBe(false);
            expect(result.audit.action).toBe(HaltAuditActionEnum.RESUME);
        });

        it('clears the in-memory halt flag after clearHaltForDate succeeds', async () => {
            const now = new Date('2026-05-28T09:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);

            await harness.service.resume(buildResumeParams(now));

            expect(harness.haltFlag.isHalted()).toBe(false);
        });
    });

    // ---------------------------------------------------------------------------
    // 2. Call ordering — clearHaltForDate after audit write, before flag flip
    // ---------------------------------------------------------------------------

    describe('ordering: clearHaltForDate is called after audit write and before haltFlag.resume()', () => {
        it('audit row is written before clearHaltForDate is called', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const callLog: string[] = [];

            const auditRepo = new FakeControlAuditRepository();
            const originalAppend = auditRepo.appendOperator.bind(auditRepo);
            auditRepo.appendOperator = async (params) => {
                const entry = await originalAppend(params);
                callLog.push('auditWrite');

                return entry;
            };

            const port = new OrderingRiskHaltStatePort();
            const originalClear = port.clearHaltForDate.bind(port);
            port.clearHaltForDate = async (date) => {
                callLog.push('clearHaltForDate');

                return originalClear(date);
            };

            const alerts = new StubAlertSink();
            const haltFlag = new HaltFlagService();
            const flatten = new StubFlattenCoordinator();
            const service = new HaltService(auditRepo as unknown as ControlAuditRepository, haltFlag, alerts, flatten, port, new EventEmitter2());

            // Pre-halt via auditRepo directly to avoid polluting callLog.
            haltFlag.halt('OPERATOR:pre-halt');
            await auditRepo.appendOperator({
                occurredAt: now,
                actorSub: OPERATOR_SUB,
                actorJti: OPERATOR_JTI,
                sourceIp: null,
                action: 'HALT',
                reason: 'pre-halt',
                flattenRequested: false,
                previousState: 'RUNNING',
                newState: 'HALTED',
            });
            callLog.length = 0;

            await service.resume(buildResumeParams(now));

            const auditIndex = callLog.indexOf('auditWrite');
            const clearIndex = callLog.indexOf('clearHaltForDate');

            expect(auditIndex).toBeGreaterThanOrEqual(0);
            expect(clearIndex).toBeGreaterThan(auditIndex);
        });

        it('haltFlag is still engaged immediately after audit write but before clearHaltForDate resolves', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);

            let flagStateAtClearTime: boolean | null = null;

            const originalClear = harness.riskHaltState.clearHaltForDate.bind(harness.riskHaltState);
            harness.riskHaltState.clearHaltForDate = async (date) => {
                flagStateAtClearTime = harness.haltFlag.isHalted();

                return originalClear(date);
            };

            await harness.service.resume(buildResumeParams(now));

            // At the moment clearHaltForDate fires, the in-memory flag must
            // still be set — it is released only AFTER the clear succeeds.
            expect(flagStateAtClearTime).toBe(true);
            // And it is released after resume() completes.
            expect(harness.haltFlag.isHalted()).toBe(false);
        });
    });

    // ---------------------------------------------------------------------------
    // 3. Idempotent resume — clearHaltForDate called even when already running
    // ---------------------------------------------------------------------------

    describe('idempotent resume: clearHaltForDate is called even when in-memory flag is already clear', () => {
        it('calls clearHaltForDate when haltFlag.isHalted() is false (DB may still have is_halted=true)', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const harness = buildHarness();
            // Do NOT engage the halt — the in-memory flag stays clear. This
            // simulates a programmatic halt that set `risk_state.is_halted=true`
            // but whose in-memory flag was already cleared by a prior autoClear.

            // resume() still requires OPERATOR source which fails writeAudit
            // unless we supply actor fields and the halt was at least written
            // once by the audit repo. Seed a HALT audit row directly.
            await harness.auditRepo.appendOperator({
                occurredAt: now,
                actorSub: OPERATOR_SUB,
                actorJti: OPERATOR_JTI,
                sourceIp: null,
                action: 'HALT',
                reason: 'programmatic-was-cleared',
                flattenRequested: false,
                previousState: 'RUNNING',
                newState: 'HALTED',
            });

            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates).toHaveLength(1);
            expect(harness.riskHaltState.clearedDates[0]).toBe('2026-05-28');
        });

        it('writes exactly one audit RESUME row on a resume-while-running', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const harness = buildHarness();
            await harness.auditRepo.appendOperator({
                occurredAt: now,
                actorSub: OPERATOR_SUB,
                actorJti: OPERATOR_JTI,
                sourceIp: null,
                action: 'HALT',
                reason: 'seeded',
                flattenRequested: false,
                previousState: 'RUNNING',
                newState: 'HALTED',
            });
            const rowsBefore = harness.auditRepo.rows.length;

            await harness.service.resume(buildResumeParams(now));

            const resumeRows = harness.auditRepo.rows.filter((r) => r.action === HaltAuditActionEnum.RESUME);

            expect(resumeRows).toHaveLength(1);
            expect(harness.auditRepo.rows.length).toBe(rowsBefore + 1);
        });
    });

    // ---------------------------------------------------------------------------
    // 4. clearHaltForDate failure — CRITICAL alert, re-raise, flag NOT cleared
    // ---------------------------------------------------------------------------

    describe('clearHaltForDate failure: CRITICAL alert published and in-memory flag stays set', () => {
        it('publishes a CRITICAL UNHANDLED_EXCEPTION alert when clearHaltForDate throws', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const port = new OrderingRiskHaltStatePort();
            port.shouldThrow = true;
            const harness = buildHarness(port);
            await engageHalt(harness, now);
            harness.alerts.published.length = 0;

            await expect(harness.service.resume(buildResumeParams(now))).rejects.toThrow(/risk_state clear boom/u);

            const criticals = harness.alerts.published.filter((p) => p.severity === AlertSeverityEnum.CRITICAL && p.type === AlertTypeEnum.UNHANDLED_EXCEPTION);

            expect(criticals).toHaveLength(1);
            expect(criticals[0]!.title).toMatch(/resume risk_state clear failed/u);
        });

        it('re-raises the original error from clearHaltForDate so the caller sees the failure', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const port = new OrderingRiskHaltStatePort();
            port.shouldThrow = true;
            const harness = buildHarness(port);
            await engageHalt(harness, now);

            await expect(harness.service.resume(buildResumeParams(now))).rejects.toThrow(/risk_state clear boom/u);
        });

        it('does NOT clear the in-memory halt flag when clearHaltForDate throws (half-cleared resume stays safe)', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const port = new OrderingRiskHaltStatePort();
            port.shouldThrow = true;
            const harness = buildHarness(port);
            await engageHalt(harness, now);

            await expect(harness.service.resume(buildResumeParams(now))).rejects.toThrow();

            // The system must stay halted — a half-cleared resume is worse
            // than staying halted (ADR 0021 §5.2 loud-not-silent discipline).
            expect(harness.haltFlag.isHalted()).toBe(true);
        });

        it('includes the audit row id in the CRITICAL alert body for traceability', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const port = new OrderingRiskHaltStatePort();
            port.shouldThrow = true;
            const harness = buildHarness(port);
            await engageHalt(harness, now);
            harness.alerts.published.length = 0;

            await expect(harness.service.resume(buildResumeParams(now))).rejects.toThrow();

            const critical = harness.alerts.published.find((p) => p.severity === AlertSeverityEnum.CRITICAL);

            expect(critical).toBeDefined();
            // The alert body must reference the audit row written by this resume.
            expect(critical!.body).toMatch(/auditId=/u);
        });

        it('does NOT publish a normal OPERATOR_RESUME alert when clearHaltForDate throws', async () => {
            const now = new Date('2026-05-28T12:00:00.000Z');
            const port = new OrderingRiskHaltStatePort();
            port.shouldThrow = true;
            const harness = buildHarness(port);
            await engageHalt(harness, now);
            harness.alerts.published.length = 0;

            await expect(harness.service.resume(buildResumeParams(now))).rejects.toThrow();

            const resumeAlerts = harness.alerts.published.filter((p) => p.type === AlertTypeEnum.OPERATOR_RESUME);

            expect(resumeAlerts).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------------------
    // 5. UTC date derivation — boundary cases
    // ---------------------------------------------------------------------------

    describe('UTC date derivation: params.now maps to the correct YYYY-MM-DD key', () => {
        it('last millisecond of 2026-05-28 UTC → clearHaltForDate("2026-05-28")', async () => {
            const now = new Date('2026-05-28T23:59:59.999Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates[0]).toBe('2026-05-28');
        });

        it('exact UTC midnight rollover 2026-05-29T00:00:00.000Z → clearHaltForDate("2026-05-29")', async () => {
            const now = new Date('2026-05-29T00:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates[0]).toBe('2026-05-29');
        });

        it('first millisecond of a month boundary (2026-06-01T00:00:00.000Z) → "2026-06-01"', async () => {
            const now = new Date('2026-06-01T00:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates[0]).toBe('2026-06-01');
        });

        it('year boundary: 2027-01-01T00:00:00.000Z → "2027-01-01"', async () => {
            const now = new Date('2027-01-01T00:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            expect(harness.riskHaltState.clearedDates[0]).toBe('2027-01-01');
        });

        it('date string is exactly 10 characters (YYYY-MM-DD format, no time component leaks)', async () => {
            const now = new Date('2026-05-28T18:45:22.123Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            const cleared = harness.riskHaltState.clearedDates[0]!;

            expect(cleared).toHaveLength(10);
            expect(cleared).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        });

        it('clearHaltForDate date matches the ISO prefix of the audit row occurredAt', async () => {
            const now = new Date('2026-05-28T16:00:00.000Z');
            const harness = buildHarness();
            await engageHalt(harness, now);
            harness.riskHaltState.clearedDates.length = 0;

            await harness.service.resume(buildResumeParams(now));

            const resumeRow = harness.auditRepo.rows.find((r) => r.action === HaltAuditActionEnum.RESUME);

            expect(resumeRow).toBeDefined();
            expect(harness.riskHaltState.clearedDates[0]).toBe(resumeRow!.occurredAt.slice(0, 10));
        });
    });
});
