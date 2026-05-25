import {
    AlertSeverityEnum,
    AlertTypeEnum,
    HaltAuditActionEnum,
    HaltSourceEnum,
    HaltStateEnum,
    IAlertPayload,
    IHaltAuditEntry,
    IKillSwitchState,
} from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../common/service/HaltFlagService';
import { ControlAuditRepository } from './repository/ControlAuditRepository';
import { HALT_CHANGED_EVENT, IHaltChangedEvent } from './const/controlEvents';
import { FLATTEN_COORDINATOR, IFlattenCoordinator } from './interface/IFlattenCoordinator';

// M9 W3 (ADR 0021). HaltService orchestrates every halt-state transition:
//
//   1. Write the audit row FIRST (so a DB failure aborts before the flag
//      flips — the halt never half-engages).
//   2. Flip the M0 halt flag via the existing `HaltFlagService` (wrapped, not
//      recreated — see CLAUDE.md "wrap the existing halt-flag service").
//   3. Fire an `IAlertSink` payload (W1 NoopAlertSink today; TelegramAlertSink
//      in W6).
//   4. IF `flatten=true`, delegate to the `IFlattenCoordinator` port which
//      emits CLOSE intents per open position through the EXISTING risk-gate /
//      executor path. The coordinator NEVER calls ccxt directly — that
//      invariant is enforced by `no ccxt import in control/**`.
//
// Two entry points:
//   - `engageHalt(...)` — OPERATOR-driven only (M9 R1 adjudication A — Option β).
//     Programmatic halts (market-stress, model-divergence, loss windows) are
//     SoT-owned by `risk_state.is_halted` (written by `RiskGateService.persistHalt`)
//     and the in-process halt flag is flipped directly by `RiskListeners`
//     via `HaltFlagService.halt(...)` — they do NOT call this method and do
//     NOT write a `control_audit` row. Per ADR 0021 §2.3. The previously-
//     defensive programmatic branch of `writeAudit(...)` was removed in M9 R2
//     once the SoT split proved it provably dead — `writeAudit` now hard-
//     requires OPERATOR + actorSub/actorJti and throws otherwise.
//   - `resume(...)` — operator-only at W3; programmatic resume (e.g. after a
//     loss-window expires) lands in M4-side wiring.
//
// Idempotency: a halt issued while already HALTED still writes an audit row
// (operator action is always audited) and fires a fresh alert, but does NOT
// re-trigger the flatten path (ADR 0021 §2.1 — flatten is bound to the first
// transition).
//
// On flag-flip failure AFTER the audit write, we fire a CRITICAL alert and
// re-raise so the caller sees the failure; the audit row stays as evidence.

export interface IEngageHaltParams {
    source: HaltSourceEnum;
    reason: string;
    // Operator path supplies actorSub + actorJti from IAuthSubject; programmatic
    // path leaves them undefined and the repository fills in `SYSTEM:<source>`.
    actorSub?: string;
    actorJti?: string;
    sourceIp?: string | null;
    flatten: boolean;
    correlationEventId?: string | null;
    now: Date;
}

export interface IResumeParams {
    source: HaltSourceEnum;
    reason: string;
    actorSub?: string;
    actorJti?: string;
    sourceIp?: string | null;
    correlationEventId?: string | null;
    now: Date;
}

export interface IHaltTransitionResult {
    audit: IHaltAuditEntry;
    state: IKillSwitchState;
    flattenDispatched: boolean;
}

@Injectable()
export class HaltService {
    private readonly logger = new Logger(HaltService.name);

    // Last-known transition kept in-memory so `getState()` (`GET /v1/control/halt`)
    // can render `IKillSwitchState` without re-querying. Populated on every
    // toggle and by `HaltStateRestoreService` at PHASE 3.
    private lastTransition: IHaltAuditEntry | null = null;

    private lastSource: HaltSourceEnum = HaltSourceEnum.OPERATOR;

    private flattenInProgress = false;

    constructor(
        private readonly auditRepo: ControlAuditRepository,
        private readonly haltFlag: HaltFlagService,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Inject(FLATTEN_COORDINATOR) private readonly flattenCoordinator: IFlattenCoordinator,
        private readonly events: EventEmitter2,
    ) {}

    async engageHalt(params: IEngageHaltParams): Promise<IHaltTransitionResult> {
        const previousState: 'RUNNING' | 'HALTED' = this.haltFlag.isHalted() ? 'HALTED' : 'RUNNING';
        const wasAlreadyHalted = previousState === 'HALTED';

        const audit = await this.writeAudit({
            ...params,
            action: 'HALT',
            previousState,
            newState: 'HALTED',
        });

        // Flag flip — wrapped, not recreated. On already-halted this is a
        // no-op; on first transition the M5 executor's exposure-increasing
        // path starts refusing.
        try {
            if (!wasAlreadyHalted) {
                this.haltFlag.halt(`${params.source}:${params.reason}`);
            }
        } catch (cause) {
            await this.publishCritical(
                AlertTypeEnum.UNHANDLED_EXCEPTION,
                'halt flag-flip failed AFTER audit row written',
                `auditId=${audit.id} cause=${describe(cause)}`,
                params.now,
            );

            throw cause;
        }

        await this.publishHaltAlert(params, audit);

        this.lastTransition = audit;
        this.lastSource = params.source;

        // W6: bus-event seam for the WS gateway (and any other observer).
        // Fired AFTER the audit row + flag flip + alert so consumers react
        // to a transition that is already durable. Idempotent halts still
        // emit — operators want to see the action acknowledged; consumers
        // distinguish a real transition from a re-affirmation via the
        // `wasAlreadyHalted` flag (M9 R1 adjudication B).
        this.emitHaltChanged('HALT', params.source, params.reason, audit, wasAlreadyHalted);

        const shouldFlatten = params.flatten && !wasAlreadyHalted;

        if (shouldFlatten) {
            // Flatten is fire-and-forget against the risk-gate path — the
            // coordinator enqueues CLOSE intents and returns. Per ADR 0021 §2.4
            // these flow through the EXISTING gate + executor; no direct
            // exchange call. We flip `flattenInProgress=true` for the duration.
            this.flattenInProgress = true;

            try {
                await this.flattenCoordinator.flattenAllOpen({
                    reason: params.reason,
                    correlationEventId: params.correlationEventId ?? null,
                    now: params.now,
                });
            } finally {
                this.flattenInProgress = false;
            }
        }

        return {
            audit,
            state: this.buildState(),
            flattenDispatched: shouldFlatten,
        };
    }

    async resume(params: IResumeParams): Promise<IHaltTransitionResult> {
        const previousState: 'RUNNING' | 'HALTED' = this.haltFlag.isHalted() ? 'HALTED' : 'RUNNING';
        const wasAlreadyRunning = previousState === 'RUNNING';

        const audit = await this.writeAudit({
            ...params,
            action: 'RESUME',
            flatten: false,
            previousState,
            newState: 'RUNNING',
        });

        try {
            if (previousState === 'HALTED') {
                this.haltFlag.resume();
            }
        } catch (cause) {
            await this.publishCritical(
                AlertTypeEnum.UNHANDLED_EXCEPTION,
                'resume flag-flip failed AFTER audit row written',
                `auditId=${audit.id} cause=${describe(cause)}`,
                params.now,
            );

            throw cause;
        }

        await this.publishResumeAlert(params, audit);

        this.lastTransition = audit;
        this.lastSource = params.source;

        this.emitHaltChanged('RESUME', params.source, params.reason, audit, wasAlreadyRunning);

        return {
            audit,
            state: this.buildState(),
            flattenDispatched: false,
        };
    }

    // `wasAlreadyHalted` carries dual meaning per action: on HALT it is
    // `previousState === 'HALTED'` (operator re-affirmed an existing halt);
    // on RESUME it is `previousState === 'RUNNING'` (operator re-affirmed an
    // existing running state). Both indicate the in-process state did not
    // transition — only the audit row is new. WS + Telegram consumers still
    // fire (the operator wants confirmation the action landed) but the
    // dashboard uses the flag to suppress a `HALTED → HALTED` flash.
    private emitHaltChanged(action: 'HALT' | 'RESUME', source: HaltSourceEnum, reason: string, audit: IHaltAuditEntry, wasAlreadyHalted: boolean): void {
        const event: IHaltChangedEvent = {
            action,
            state: action === 'HALT' ? HaltStateEnum.HALTED : HaltStateEnum.RUNNING,
            source,
            reason,
            auditId: audit.id,
            occurredAt: audit.occurredAt,
            wasAlreadyHalted,
        };

        this.events.emit(HALT_CHANGED_EVENT, event);
    }

    // PHASE 3 boot pipeline calls this to re-engage the halt flag WITHOUT
    // writing a new audit row or firing an alert (ADR 0021 §2.5 — the row
    // already exists from the original transition). `restoreFromAudit` is a
    // pure state restoration: it does not toggle the flag if the last
    // recorded state is RUNNING.
    // M9 R2 fix — programmatic-transition notification path. RiskListeners
    // calls this AFTER flipping the M0 halt flag for a programmatic halt
    // (market-stress, model-divergence) so `getState()` / `GET /v1/control/halt`
    // reports the correct `haltSource` + `haltedAt` without a stale
    // `lastTransitionAuditId`. We intentionally do NOT write a `control_audit`
    // row (Option β — programmatic halts are SoT'd by `risk_state.is_halted`,
    // see ADR 0021 §2.3) and do NOT fire alerts or the bus event (RiskListeners
    // owns the alert; the bus emit for programmatic halts is fired by
    // RiskGateService itself). This is a pure in-memory state notation so the
    // read-API renders the right source — `lastTransitionAuditId` stays empty
    // because no audit row exists for this transition.
    // M11a W1.4 (ADR 0030 §2.6.2). The rate-limit auto-clear path notifies
    // HaltService that the in-process flag has transitioned from HALTED back
    // to RUNNING without an operator-issued resume. Mirrors
    // `notePragmaticTransition` — pure in-memory state notation; the durable
    // audit row is written by `RateLimitHaltAdapter.autoClear` directly.
    notePragmaticAutoClear(source: HaltSourceEnum, reason: string, occurredAtMs: number): void {
        const synthetic: IHaltAuditEntry = {
            id: '',
            occurredAt: new Date(occurredAtMs).toISOString(),
            actorSub: `SYSTEM:${source}`,
            actorJti: '',
            sourceIp: null,
            action: HaltAuditActionEnum.RESUME,
            reason,
            flattenRequested: false,
            previousState: 'halted',
            newState: 'running',
            correlationEventId: null,
        };

        this.lastTransition = synthetic;
        this.lastSource = source;
    }

    notePragmaticTransition(source: HaltSourceEnum, reason: string, occurredAtMs: number): void {
        const synthetic: IHaltAuditEntry = {
            id: '',
            occurredAt: new Date(occurredAtMs).toISOString(),
            actorSub: `SYSTEM:${source}`,
            actorJti: '',
            sourceIp: null,
            action: HaltAuditActionEnum.HALT,
            reason,
            flattenRequested: false,
            previousState: 'running',
            newState: 'halted',
            correlationEventId: null,
        };

        this.lastTransition = synthetic;
        this.lastSource = source;
    }

    restoreFromAudit(latest: IHaltAuditEntry | null, source: HaltSourceEnum): void {
        this.lastTransition = latest;
        this.lastSource = source;

        if (latest === null) {
            return;
        }

        if (latest.newState === 'halted' && !this.haltFlag.isHalted()) {
            this.haltFlag.halt(`${source}:${latest.reason}`);
        }
    }

    getState(): IKillSwitchState {
        return this.buildState();
    }

    private buildState(): IKillSwitchState {
        const halted = this.haltFlag.isHalted();
        const haltedAt = halted && this.lastTransition !== null ? this.lastTransition.occurredAt : null;
        const haltReason = halted ? this.haltFlag.getReason() : null;

        return {
            haltState: halted ? HaltStateEnum.HALTED : HaltStateEnum.RUNNING,
            haltedAt,
            haltReason,
            haltSource: this.lastSource,
            flattenInProgress: this.flattenInProgress,
            lastTransitionAuditId: this.lastTransition?.id ?? '',
        };
    }

    private async writeAudit(params: {
        source: HaltSourceEnum;
        actorSub?: string;
        actorJti?: string;
        sourceIp?: string | null;
        reason: string;
        flatten: boolean;
        action: 'HALT' | 'RESUME';
        previousState: 'RUNNING' | 'HALTED';
        newState: 'RUNNING' | 'HALTED';
        correlationEventId?: string | null;
        now: Date;
    }): Promise<IHaltAuditEntry> {
        // M9 R2 — `engageHalt` / `resume` are OPERATOR-only entry points; the
        // programmatic SoT path lives in `RiskGateService.persistHalt` and
        // does not touch `control_audit`. Fail fast if a non-OPERATOR source
        // ever lands here (would indicate a regression in the SoT split).
        if (params.source !== HaltSourceEnum.OPERATOR) {
            throw new Error(`writeAudit invoked with non-OPERATOR source=${params.source}; programmatic halts do not write control_audit`);
        }

        if (params.actorSub === undefined || params.actorJti === undefined) {
            throw new Error('OPERATOR halt requires actorSub + actorJti from IAuthSubject');
        }

        return this.auditRepo.appendOperator({
            occurredAt: params.now,
            actorSub: params.actorSub,
            actorJti: params.actorJti,
            sourceIp: params.sourceIp ?? null,
            action: params.action,
            reason: params.reason,
            flattenRequested: params.flatten,
            previousState: params.previousState,
            newState: params.newState,
        });
    }

    private async publishHaltAlert(params: IEngageHaltParams, audit: IHaltAuditEntry): Promise<void> {
        const type = mapHaltAlertType(params.source);
        const severity = AlertSeverityEnum.CRITICAL;

        const payload: IAlertPayload = {
            type,
            severity,
            occurredAt: params.now.toISOString(),
            title: type === AlertTypeEnum.OPERATOR_HALT ? 'Operator halt engaged' : 'Risk halt engaged',
            body: `source=${params.source} reason=${params.reason} flatten=${params.flatten}`,
            data: {
                auditId: audit.id,
                source: params.source,
                flatten: String(params.flatten),
            },
        };

        await this.publishSafe(payload);
    }

    private async publishResumeAlert(params: IResumeParams, audit: IHaltAuditEntry): Promise<void> {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.OPERATOR_RESUME,
            severity: AlertSeverityEnum.INFO,
            occurredAt: params.now.toISOString(),
            title: 'Operator resume',
            body: `source=${params.source} reason=${params.reason}`,
            data: {
                auditId: audit.id,
                source: params.source,
            },
        };

        await this.publishSafe(payload);
    }

    private async publishCritical(type: AlertTypeEnum, title: string, body: string, now: Date): Promise<void> {
        const payload: IAlertPayload = {
            type,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: now.toISOString(),
            title,
            body,
        };

        await this.publishSafe(payload);
    }

    // Alerts never block the trade loop; a sink failure is logged, not
    // rethrown (the halt itself already landed in the DB + flag).
    private async publishSafe(payload: IAlertPayload): Promise<void> {
        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`alert sink publish failed: ${describe(cause)}`);
        }
    }
}

function mapHaltAlertType(source: HaltSourceEnum): AlertTypeEnum {
    if (source === HaltSourceEnum.OPERATOR) {
        return AlertTypeEnum.OPERATOR_HALT;
    }

    if (source === HaltSourceEnum.MODEL_DIVERGENCE) {
        return AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED;
    }

    return AlertTypeEnum.RISK_HALT_ENGAGED;
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
