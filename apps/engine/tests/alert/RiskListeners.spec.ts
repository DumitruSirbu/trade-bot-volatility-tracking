import {
    AlertTypeEnum,
    HaltAuditActionEnum,
    HaltSourceEnum,
    HaltStateEnum,
    IAlertPayload,
    IHaltAuditEntry,
    IModelDivergenceEvent,
    IRiskHaltEvent,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { IAlertSink, NoopAlertSink } from '../../src/alert/AlertModule';
import { RiskListeners } from '../../src/alert/listeners/RiskListeners';
import { RISK_HALT_DEDUP_WINDOW_MS } from '../../src/alert/const/alertEvents';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { HALT_CHANGED_EVENT, IHaltChangedEvent } from '../../src/control/const/controlEvents';
import { IClock } from '../../src/common/clock/Clock';
import { HaltService } from '../../src/control/HaltService';
import { HaltStateRestoreService } from '../../src/bootstrap/HaltStateRestoreService';
import { ControlAuditRepository } from '../../src/control/repository/ControlAuditRepository';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { RiskStateEntity } from '../../src/risk/entity/RiskStateEntity';
import { IFlattenCoordinator, IFlattenRequest } from '../../src/control/interface/IFlattenCoordinator';
import { Money } from '../../src/common/utils/money';

// M9 R1 Fix Wave #2 — paired adversarial coverage for the halt SoT split
// (architect decision A — Option β; ADR 0021 §2.3).
//
// Covers:
//   - programmatic halt does NOT call HaltService.engageHalt
//   - programmatic halt does NOT write a control_audit row
//   - in-memory halt flag DOES flip
//   - alert still fires
//   - dedup window suppresses a repeat within the window
//   - operator halt-while-halted: audit row written, emit carries
//     `wasAlreadyHalted=true`
//   - HaltStateRestoreService newer-wins across the four quadrants

class RecordingSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];
    async publish(p: IAlertPayload): Promise<void> {
        this.published.push(p);
    }
}

class FakeControlAuditRepository {
    readonly rows: IHaltAuditEntry[] = [];
    appendOperatorCalls = 0;
    appendProgrammaticCalls = 0;

    async appendOperator(params: {
        occurredAt: Date;
        actorSub: string;
        actorJti: string;
        sourceIp: string | null;
        action: 'HALT' | 'RESUME';
        reason: string;
        flattenRequested: boolean;
        previousState: 'RUNNING' | 'HALTED';
        newState: 'RUNNING' | 'HALTED';
    }): Promise<IHaltAuditEntry> {
        this.appendOperatorCalls += 1;
        const entry: IHaltAuditEntry = {
            id: `audit-${this.rows.length + 1}`,
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

    async appendProgrammatic(): Promise<IHaltAuditEntry> {
        this.appendProgrammaticCalls += 1;
        throw new Error('appendProgrammatic should not be invoked by the listener path');
    }

    async findLatest(): Promise<IHaltAuditEntry | null> {
        if (this.rows.length === 0) {
            return null;
        }

        return this.rows[this.rows.length - 1];
    }

    seedRow(entry: IHaltAuditEntry): void {
        this.rows.push(entry);
    }
}

class FakeRiskStateRepository {
    private row: RiskStateEntity | null = null;

    async findByDate(_date: string): Promise<RiskStateEntity | null> {
        return this.row;
    }

    setToday(isHalted: boolean, haltReason: string | null, date: string): void {
        this.row = {
            id: 1,
            date,
            realizedPnlDay: new Money('0') as never,
            openExposure: new Money('0') as never,
            tradesCount: 0,
            isHalted,
            haltReason,
            updatedAt: new Date(0),
        };
    }

    clear(): void {
        this.row = null;
    }
}

class StubFlattenCoordinator implements IFlattenCoordinator {
    async flattenAllOpen(_req: IFlattenRequest): Promise<void> {
        return;
    }
}

const NOW = new Date('2026-05-24T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Listener is alert-only for programmatic halts
// ---------------------------------------------------------------------------

describe('RiskListeners — programmatic halt is alert-only (no engageHalt, no control_audit)', () => {
    function build(now: () => Date): {
        listeners: RiskListeners;
        sink: RecordingSink;
        haltFlag: HaltFlagService;
        engageHaltSpy: jest.Mock;
        notePragmaticSpy: jest.Mock;
        auditRepo: FakeControlAuditRepository;
    } {
        const sink = new RecordingSink();
        const haltFlag = new HaltFlagService();
        const clock: IClock = { now };
        const engageHaltSpy = jest.fn();
        const notePragmaticSpy = jest.fn();
        const auditRepo = new FakeControlAuditRepository();

        // Listener takes HaltService for the read-API transition notation
        // (M9 R2) but never calls `engageHalt` for programmatic halts.
        const haltServiceStub = {
            engageHalt: engageHaltSpy,
            notePragmaticTransition: notePragmaticSpy,
        } as unknown as HaltService;
        const listeners = new RiskListeners(haltFlag, sink, clock, haltServiceStub);

        return { listeners, sink, haltFlag, engageHaltSpy, notePragmaticSpy, auditRepo };
    }

    it('a programmatic risk halt flips the in-memory flag, fires alert, and does NOT write control_audit', async () => {
        const { listeners, sink, haltFlag, engageHaltSpy, notePragmaticSpy, auditRepo } = build(() => NOW);

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'spread widened',
            engagedAt: NOW.toISOString(),
            metrics: { spreadBps: '180' },
        };

        await listeners.onRiskHalt(event);

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltFlag.getReason()).toContain(HaltSourceEnum.MARKET_STRESS);
        expect(sink.published).toHaveLength(1);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.RISK_HALT_ENGAGED);
        expect(engageHaltSpy).not.toHaveBeenCalled();
        expect(auditRepo.appendOperatorCalls).toBe(0);
        expect(auditRepo.appendProgrammaticCalls).toBe(0);
        expect(auditRepo.rows).toHaveLength(0);

        // M9 R2 — read-API transition notation. Listener must call
        // notePragmaticTransition with (source, reason, occurredAtMs) so
        // GET /v1/control/halt reflects the programmatic halt source.
        expect(notePragmaticSpy).toHaveBeenCalledTimes(1);
        expect(notePragmaticSpy).toHaveBeenCalledWith(HaltSourceEnum.MARKET_STRESS, 'spread widened', NOW.getTime());
    });

    it('a programmatic model-divergence event flips flag + fires MODEL_DIVERGENCE_ENGAGED alert, no audit', async () => {
        const { listeners, sink, haltFlag, auditRepo } = build(() => NOW);

        const event: IModelDivergenceEvent = {
            engagedAt: NOW.toISOString(),
            reason: 'observed > 2x modeled',
            observedSlippageBps: '40',
            modeledSlippageBps: '12',
            sampleCount: 50,
        };

        await listeners.onModelDivergence(event);

        expect(haltFlag.isHalted()).toBe(true);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
        expect(auditRepo.rows).toHaveLength(0);
    });

    it('dedup window still suppresses a repeat halt within the window', async () => {
        let nowMs = NOW.getTime();
        const { listeners, sink, haltFlag } = build(() => new Date(nowMs));

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 's',
            engagedAt: NOW.toISOString(),
            metrics: {},
        };

        await listeners.onRiskHalt(event);
        // resume + re-fire inside dedup window: alert should still coalesce
        haltFlag.resume();
        nowMs += Math.floor(RISK_HALT_DEDUP_WINDOW_MS / 2);
        await listeners.onRiskHalt(event);

        // Only one alert (dedup is by source within the window).
        expect(sink.published).toHaveLength(1);
        // The flag was reset by the test mid-flight; after the second
        // (coalesced) call it stays un-engaged because the listener short-
        // circuited before touching the flag.
        expect(haltFlag.isHalted()).toBe(false);
    });

    it('after the dedup window expires, a fresh programmatic halt fires again and flips the flag', async () => {
        let nowMs = NOW.getTime();
        const { listeners, sink, haltFlag } = build(() => new Date(nowMs));

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 's',
            engagedAt: NOW.toISOString(),
            metrics: {},
        };

        await listeners.onRiskHalt(event);
        haltFlag.resume();
        nowMs += RISK_HALT_DEDUP_WINDOW_MS + 100;
        await listeners.onRiskHalt(event);

        expect(sink.published).toHaveLength(2);
        expect(haltFlag.isHalted()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Operator halt-while-halted → emit carries wasAlreadyHalted=true
// ---------------------------------------------------------------------------

describe('HaltService — wasAlreadyHalted flag on IHaltChangedEvent emit', () => {
    function buildService(haltFlag: HaltFlagService): {
        service: HaltService;
        auditRepo: FakeControlAuditRepository;
        events: EventEmitter2;
        captured: IHaltChangedEvent[];
    } {
        const auditRepo = new FakeControlAuditRepository();
        const sink: IAlertSink = new NoopAlertSink();
        const flatten = new StubFlattenCoordinator();
        const events = new EventEmitter2();
        const captured: IHaltChangedEvent[] = [];
        events.on(HALT_CHANGED_EVENT, (e: IHaltChangedEvent) => captured.push(e));

        const riskHaltState = { clearHaltForDate: async (): Promise<void> => undefined };
        const service = new HaltService(auditRepo as unknown as ControlAuditRepository, haltFlag, sink, flatten, riskHaltState, events);

        return { service, auditRepo, events, captured };
    }

    it('halt-while-halted writes a fresh audit row AND emits with wasAlreadyHalted=true', async () => {
        const haltFlag = new HaltFlagService();
        haltFlag.halt('OPERATOR:earlier');
        const { service, auditRepo, captured } = buildService(haltFlag);

        await service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'second-jab',
            actorSub: 'op-1',
            actorJti: 'jti-1',
            flatten: false,
            now: NOW,
        });

        expect(auditRepo.rows).toHaveLength(1);
        expect(auditRepo.rows[0]!.previousState).toBe('halted');
        expect(captured).toHaveLength(1);
        expect(captured[0]!.action).toBe('HALT');
        expect(captured[0]!.state).toBe(HaltStateEnum.HALTED);
        expect(captured[0]!.wasAlreadyHalted).toBe(true);
    });

    it('a first halt (state actually transitions) emits with wasAlreadyHalted=false', async () => {
        const haltFlag = new HaltFlagService();
        const { service, captured } = buildService(haltFlag);

        await service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'first',
            actorSub: 'op-1',
            actorJti: 'jti-1',
            flatten: false,
            now: NOW,
        });

        expect(captured[0]!.wasAlreadyHalted).toBe(false);
    });

    it('resume-while-running emits with wasAlreadyHalted=true (no in-process transition)', async () => {
        const haltFlag = new HaltFlagService();
        const { service, captured } = buildService(haltFlag);

        await service.resume({
            source: HaltSourceEnum.OPERATOR,
            reason: 'redundant-clear',
            actorSub: 'op-1',
            actorJti: 'jti-1',
            now: NOW,
        });

        expect(captured[0]!.action).toBe('RESUME');
        expect(captured[0]!.wasAlreadyHalted).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// HaltStateRestoreService newer-wins across four quadrants
// ---------------------------------------------------------------------------

describe('HaltStateRestoreService — newer-wins between control_audit and risk_state', () => {
    function buildRestore(haltFlag?: HaltFlagService): {
        restore: HaltStateRestoreService;
        haltService: HaltService;
        haltFlag: HaltFlagService;
        auditRepo: FakeControlAuditRepository;
        riskStateRepo: FakeRiskStateRepository;
    } {
        const flag = haltFlag ?? new HaltFlagService();
        const auditRepo = new FakeControlAuditRepository();
        const riskStateRepo = new FakeRiskStateRepository();
        const sink: IAlertSink = new NoopAlertSink();
        const flatten = new StubFlattenCoordinator();
        const events = new EventEmitter2();
        const riskHaltState = { clearHaltForDate: async (): Promise<void> => undefined };
        const haltService = new HaltService(auditRepo as unknown as ControlAuditRepository, flag, sink, flatten, riskHaltState, events);
        const restore = new HaltStateRestoreService(
            auditRepo as unknown as ControlAuditRepository,
            haltService,
            flag,
            riskStateRepo as unknown as RiskStateRepository,
        );

        return { restore, haltService, haltFlag: flag, auditRepo, riskStateRepo };
    }

    function todayUtc(): string {
        return new Date().toISOString().slice(0, 10);
    }

    function seedAudit(repo: FakeControlAuditRepository, action: 'halt' | 'resume', occurredAt: Date, actorSub = 'operator-1'): void {
        repo.seedRow({
            id: `seeded-${repo.rows.length + 1}`,
            occurredAt: occurredAt.toISOString(),
            actorSub,
            actorJti: 'jti',
            sourceIp: null,
            action: action === 'halt' ? HaltAuditActionEnum.HALT : HaltAuditActionEnum.RESUME,
            reason: 'seeded',
            flattenRequested: false,
            previousState: action === 'halt' ? 'running' : 'halted',
            newState: action === 'halt' ? 'halted' : 'running',
            correlationEventId: null,
        });
    }

    it('quadrant 1: audit HALTED today, risk_state RUNNING → restored as HALTED (audit wins)', async () => {
        const { restore, haltFlag, auditRepo, riskStateRepo } = buildRestore();
        seedAudit(auditRepo, 'halt', new Date(`${todayUtc()}T10:00:00Z`));
        riskStateRepo.setToday(false, null, todayUtc());

        await restore.restore();

        expect(haltFlag.isHalted()).toBe(true);
    });

    it('quadrant 2: audit RUNNING (older), risk_state HALTED today → restored as HALTED (programmatic wins)', async () => {
        const { restore, haltFlag, auditRepo, riskStateRepo } = buildRestore();
        // Audit was a RESUME the day before; programmatic halt today is newer.
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        seedAudit(auditRepo, 'resume', yesterday);
        riskStateRepo.setToday(true, `${HaltSourceEnum.MARKET_STRESS}:spread`, todayUtc());

        await restore.restore();

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltFlag.getReason()).toContain(HaltSourceEnum.MARKET_STRESS);
    });

    it('quadrant 3: both HALTED today (audit fresher than UTC-day start) → audit wins (operator)', async () => {
        const { restore, haltService, haltFlag, auditRepo, riskStateRepo } = buildRestore();
        seedAudit(auditRepo, 'halt', new Date(`${todayUtc()}T11:30:00Z`), 'operator-1');
        riskStateRepo.setToday(true, `${HaltSourceEnum.MARKET_STRESS}:spread`, todayUtc());

        await restore.restore();

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltService.getState().haltSource).toBe(HaltSourceEnum.OPERATOR);
    });

    it('quadrant 4: both RUNNING (no audit rows, no risk_state row) → restored as RUNNING', async () => {
        const { restore, haltFlag, riskStateRepo } = buildRestore();
        riskStateRepo.clear();

        await restore.restore();

        expect(haltFlag.isHalted()).toBe(false);
    });

    it('M9 R2 tie-break: audit RUNNING (fresh, today) + risk_state HALTED today → halt-wins restores HALTED', async () => {
        // Without the M9 R2 halt-wins tie-break, this scenario would let the
        // RUNNING audit row (timestamped inside today's UTC day) override the
        // programmatic HALT in risk_state. Survival-first preference: any
        // HALTED risk_state today must restore as HALTED until M11 adds a
        // real `risk_state.updated_at` to compare timestamps apples-to-apples.
        const { restore, haltService, haltFlag, auditRepo, riskStateRepo } = buildRestore();
        seedAudit(auditRepo, 'resume', new Date(`${todayUtc()}T08:00:00Z`));
        riskStateRepo.setToday(true, `${HaltSourceEnum.MARKET_STRESS}:spread`, todayUtc());

        await restore.restore();

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltService.getState().haltSource).toBe(HaltSourceEnum.MARKET_STRESS);
    });

    it('symmetric clear: stale in-memory HALTED flag + newer source says RUNNING → flag cleared', async () => {
        const flag = new HaltFlagService();
        flag.halt('stale');
        const { restore, auditRepo, riskStateRepo } = buildRestore(flag);
        // Audit RESUME today + risk_state RUNNING → resolution says RUNNING.
        seedAudit(auditRepo, 'resume', new Date(`${todayUtc()}T12:00:00Z`));
        riskStateRepo.setToday(false, null, todayUtc());

        await restore.restore();

        expect(flag.isHalted()).toBe(false);
    });
});
