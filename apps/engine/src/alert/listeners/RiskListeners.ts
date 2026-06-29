import { AlertSeverityEnum, AlertTypeEnum, HaltSourceEnum, IAlertPayload, IMarketStressResumedEvent, IModelDivergenceEvent, IRiskHaltEvent } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { IPositionClosedEvent } from '../../common/interface/IPositionClosedEvent';
import { IPositionOpenedEvent } from '../../common/interface/IPositionOpenedEvent';
import { ORDER_INTENT_FAILED_EVENT, POSITION_CLOSED_EVENT, POSITION_OPENED_EVENT } from '../../common/const';
import { formatPositionClosedBody, formatPositionOpenedBody } from '../format/positionAlertText';
import { CLOCK, IClock } from '../../common/clock/Clock';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { HaltService } from '../../control/HaltService';
import { ALERT_SINK, IAlertSink } from '../sink/AlertSinkModule';
import { MARKET_STRESS_RESUMED_EVENT, MODEL_DIVERGENCE_TRIGGERED_EVENT, RISK_HALT_DEDUP_WINDOW_MS, RISK_HALT_TRIGGERED_EVENT } from '../const/alertEvents';
import { MARKET_STRESS_RESUME_ELIGIBLE_LEGS } from '../../risk/const/riskConsts';

// M9 W6 (ADR 0024 §2.2 + M9 R1 adjudication A — Option β).
//
// Programmatic halts: risk_state.is_halted is SoT (M4), control_audit is
// operator-only audit (W3). Per ADR 0021 §2.3.
//
// This listener is ALERT-ONLY for programmatic halts. It MUST NOT call
// `HaltService.engageHalt(...)` (that path writes a `control_audit` row +
// emits an `OPERATOR_HALT`-flavoured bus event, which was double-writing the
// programmatic halt already persisted by `RiskGateService.persistHalt` into
// `risk_state.is_halted`). Instead it:
//
//   1. Flips the in-memory M0 halt flag via `HaltFlagService.halt(...)` so
//      the M5 executor's exposure-increasing refusal lands in the same tick.
//      (`risk_state.is_halted` is durable but DB-side; the executor reads
//      the in-memory flag.)
//   2. Publishes the `IAlertPayload` for the operator's phone.
//
// Per-source dedup window stays (alert volume guard, not state guard).
//
// Pre-existing M4 gap noted previously: at the time of writing, M4 does NOT
// yet emit `RISK_HALT_TRIGGERED_EVENT` or `MODEL_DIVERGENCE_TRIGGERED_EVENT`
// on the bus. Until M4 wires the emissions, the listener stays dormant but
// tested.

@Injectable()
export class RiskListeners {
    private readonly logger = new Logger(RiskListeners.name);
    private readonly lastFiredBySource = new Map<HaltSourceEnum, number>();

    constructor(
        private readonly haltFlag: HaltFlagService,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Inject(CLOCK) private readonly clock: IClock,
        private readonly haltService: HaltService,
    ) {}

    @OnEvent(RISK_HALT_TRIGGERED_EVENT)
    async onRiskHalt(event: IRiskHaltEvent): Promise<void> {
        if (this.isWithinDedupWindow(event.source)) {
            this.logger.debug(`riskHalt.coalesced source=${event.source}`);

            return;
        }

        await this.engageProgrammatic({
            source: event.source,
            reason: event.reason,
            alertType: AlertTypeEnum.RISK_HALT_ENGAGED,
            title: 'Risk halt engaged',
            extraData: event.metrics,
        });
    }

    @OnEvent(MODEL_DIVERGENCE_TRIGGERED_EVENT)
    async onModelDivergence(event: IModelDivergenceEvent): Promise<void> {
        const source = HaltSourceEnum.MODEL_DIVERGENCE;

        if (this.isWithinDedupWindow(source)) {
            this.logger.debug(`modelDivergence.coalesced source=${source}`);

            return;
        }

        await this.engageProgrammatic({
            source,
            reason: event.reason,
            alertType: AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED,
            title: 'Model divergence kill switch engaged',
            extraData: {
                observedSlippageBps: event.observedSlippageBps ?? 'unknown',
                modeledSlippageBps: event.modeledSlippageBps ?? 'unknown',
                sampleCount: String(event.sampleCount),
            },
        });
    }

    // M23 (ADR 0004 §6d) — symmetric resume path. Clears the in-memory halt flag and
    // notates HaltService so GET /v1/control/halt reports 'running'. Mirrors the engage
    // path in engageProgrammatic: no control_audit row (programmatic SoT is risk_state),
    // no HaltService.resume() (that writes a control_audit row and is operator-only).
    @OnEvent(MARKET_STRESS_RESUMED_EVENT)
    async onMarketStressResumed(event: IMarketStressResumedEvent): Promise<void> {
        if (!MARKET_STRESS_RESUME_ELIGIBLE_LEGS.has(event.triggerLeg)) {
            this.logger.warn(`marketStress.autoResume.unexpectedLeg triggerLeg=${event.triggerLeg} — skipping flag clear`);

            return;
        }

        const now = this.clock.now();

        // Only clear flag + note when a real HALTED → RUNNING transition occurs. A restart
        // may deliver this event with the flag already unset (DB cleared, flag never restored);
        // writing notePragmaticAutoClear in that case would clobber lastSource/lastTransition
        // on HaltService while the system was already RUNNING — corrupting GET /v1/control/halt.
        if (this.haltFlag.isHalted()) {
            try {
                this.haltFlag.resume();
            } catch (cause) {
                this.logger.error(`marketStress.autoResume.flag.failed cause=${describe(cause)}`);
            }

            try {
                this.haltService.notePragmaticAutoClear(HaltSourceEnum.MARKET_STRESS, `auto_resume:${event.triggerLeg}`, now.getTime());
            } catch (cause) {
                this.logger.error(`marketStress.autoResume.note.failed cause=${describe(cause)}`);
            }
        }

        const payload: IAlertPayload = {
            type: AlertTypeEnum.MARKET_STRESS_RESUMED,
            severity: AlertSeverityEnum.INFO,
            occurredAt: now.toISOString(),
            title: 'Market stress auto-resumed',
            body: `leg=${event.triggerLeg} breadth=${event.breadthAtResume} clearCount=${event.clearCount} reHalts=${event.dailyReHaltCount}`,
            data: {
                triggerLeg: event.triggerLeg,
                breadthAtResume: String(event.breadthAtResume),
                dailyReHaltCount: String(event.dailyReHaltCount),
                nearReHaltCap: String(event.nearReHaltCap),
            },
        };

        await this.publishSafe(payload);
    }

    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpened(event: IPositionOpenedEvent): Promise<void> {
        this.logger.debug(`alert.positionOpened positionId=${event.positionId} symbol=${event.symbol}`);

        const payload: IAlertPayload = {
            type: AlertTypeEnum.POSITION_OPENED,
            severity: AlertSeverityEnum.INFO,
            occurredAt: this.clock.now().toISOString(),
            title: `Position opened — ${event.symbol}`,
            body: formatPositionOpenedBody(event),
            data: {
                positionId: String(event.positionId),
                symbol: event.symbol,
                side: event.side,
                leverage: event.leverage.toFixed(),
                entryPrice: event.entryPrice.toFixed(),
                entryNotional: event.entryNotional.toFixed(),
                strategyVersionId: String(event.strategyVersionId),
            },
        };

        await this.publishSafe(payload);
    }

    @OnEvent(POSITION_CLOSED_EVENT)
    async onPositionClosed(event: IPositionClosedEvent): Promise<void> {
        this.logger.debug(`alert.positionClosed positionId=${event.positionId} symbol=${event.symbol} exitReason=${event.exitReason ?? 'unknown'}`);

        const payload: IAlertPayload = {
            type: AlertTypeEnum.POSITION_CLOSED,
            severity: AlertSeverityEnum.INFO,
            occurredAt: this.clock.now().toISOString(),
            title: `Position closed — ${event.symbol}`,
            body: formatPositionClosedBody(event),
            data: {
                positionId: String(event.positionId),
                symbol: event.symbol,
                side: event.side,
                exitReason: String(event.exitReason ?? 'unknown'),
                entryPrice: event.entryPrice.toFixed(),
                exitPrice: event.exitPrice?.toFixed() ?? 'n/a',
                realizedPnl: event.realizedPnl?.toFixed() ?? 'n/a',
                leverage: event.leverage.toFixed(),
                strategyVersionId: String(event.strategyVersionId),
                holdMs: event.closedAt == null ? 'n/a' : String(event.closedAt.getTime() - event.openedAt.getTime()),
            },
        };

        await this.publishSafe(payload);
    }

    @OnEvent(ORDER_INTENT_FAILED_EVENT)
    async onOrderIntentFailed(event: { eventId: string; reservationId: string; state: string }): Promise<void> {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.ORDER_REJECTED_TERMINAL,
            severity: AlertSeverityEnum.WARN,
            occurredAt: this.clock.now().toISOString(),
            title: 'Order rejected (terminal)',
            body: `eventId=${event.eventId} state=${event.state}`,
            data: {
                eventId: event.eventId,
                reservationId: event.reservationId,
                state: event.state,
            },
        };

        await this.publishSafe(payload);
    }

    // Programmatic-halt path: flip the in-memory halt flag (so M5 refuses
    // exposure-increasing intents in the same tick) and publish a CRITICAL
    // alert. NO `control_audit` row, NO `HaltService.engageHalt` — the
    // durable record is `risk_state.is_halted` (M4 owns that write).
    private async engageProgrammatic(params: {
        source: HaltSourceEnum;
        reason: string;
        alertType: AlertTypeEnum;
        title: string;
        extraData: Record<string, string>;
    }): Promise<void> {
        const now = this.clock.now();

        try {
            if (!this.haltFlag.isHalted()) {
                this.haltFlag.halt(`${params.source}:${params.reason}`);
            }
        } catch (cause) {
            // Flag-flip failure is logged; the alert below still fires so the
            // operator sees the programmatic trigger, and `risk_state.is_halted`
            // remains the durable SoT consulted by the gate on the next evaluate.
            this.logger.error(`haltFlag.halt.failed source=${params.source} cause=${describe(cause)}`);
        }

        // M9 R2 — record the in-memory transition on HaltService so
        // `GET /v1/control/halt` reports the correct `haltSource` /
        // `haltedAt` after a programmatic halt. Does NOT write control_audit
        // (Option β — programmatic SoT is `risk_state.is_halted`) and does
        // NOT fire alerts/bus (this method owns the alert; RiskGateService
        // already emitted the bus event). Wrapped defensively so a failure
        // never blocks the alert publish below.
        try {
            this.haltService.notePragmaticTransition(params.source, params.reason, now.getTime());
        } catch (cause) {
            this.logger.error(`haltService.notePragmaticTransition.failed source=${params.source} cause=${describe(cause)}`);
        }

        this.lastFiredBySource.set(params.source, now.getTime());

        const alert: IAlertPayload = {
            type: params.alertType,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: now.toISOString(),
            title: params.title,
            body: `source=${params.source} reason=${params.reason}`,
            data: { source: params.source, ...params.extraData },
        };

        await this.publishSafe(alert);
    }

    private isWithinDedupWindow(source: HaltSourceEnum): boolean {
        const previous = this.lastFiredBySource.get(source);

        if (previous === undefined) {
            return false;
        }

        return this.clock.now().getTime() - previous < RISK_HALT_DEDUP_WINDOW_MS;
    }

    private async publishSafe(payload: IAlertPayload): Promise<void> {
        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`alert.publish.failed type=${payload.type} cause=${describe(cause)}`);
        }
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
