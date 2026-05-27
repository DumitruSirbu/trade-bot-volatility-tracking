import { AlertSeverityEnum, AlertTypeEnum, ExchangeEnvironmentEnum, HaltSourceEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ALERT_SINK, IAlertSink } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { MutationKindEnum } from '../enum';
import { IPaperMarkToMarketEvent, PAPER_MARK_TO_MARKET_EVENT } from './PaperAccountStateService';
import { PaperAccountStateService } from './PaperAccountStateService';
import { PaperStateAuditHmacCodec } from './PaperStateAuditHmacCodec';

// PaperDrawdownAbortHandler — R2c.D Item 2 (ADR 0032 §D5 / §D11).
//
// Subscribes to PAPER_MARK_TO_MARKET_EVENT and, when the event's
// `drawdownAbortTripped` flag is set, halts new decision routing through the
// SHARED M0 halt-flag service (the same primitive RiskListeners uses for
// programmatic halts — ADR 0021 §2.3 Option β). The handler does NOT call
// HaltService.engageHalt() because that path is OPERATOR-only by contract
// (HaltService.writeAudit throws on non-OPERATOR sources). Programmatic halts
// flow `HaltFlagService.halt(...)` -> `HaltService.notePragmaticTransition(...)`
// so the read-API `GET /v1/control/halt` reflects the source.
//
// Per the R2b structural fix: this handler is a downstream subscriber and
// MUST NOT participate in the producer's transaction. It calls
// `PaperAccountStateService.appendStandaloneAuditRow(...)` which opens its
// OWN audited transaction so the audit row is a separate atomic write from
// the MTM evaluation that produced the event.
//
// Idempotency: HaltFlagService.halt is idempotent (sets a flag once), but we
// also gate alert + audit on a one-shot latch so subsequent drawdown events
// fired while already halted log INFO once and do NOT spam Telegram. The
// latch resets only on resume — a fresh drawdown after operator-resume
// re-arms the abort.
//
// ARCHITECT-ADJUDICATION ITEM (R2c.D Item 2): HaltSourceEnum does not carry
// a dedicated `PAPER_DRAWDOWN` value today; the closest semantic neighbour
// is `MODEL_DIVERGENCE` (engine-internal protective kill switch). We use
// `MODEL_DIVERGENCE` so the alert-type mapper in HaltService picks
// MODEL_DIVERGENCE_ENGAGED (the most accurate existing AlertType). Adding a
// `PAPER_DRAWDOWN` entry to HaltSourceEnum + a paired AlertType requires
// routing through bot-shared-maintainer per CLAUDE.md and is deferred.
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2 / §3 D14): this file MUST NOT
// import ccxt or RateLimitPolicyService. The R2a.5 sentinel guards the
// closure transitively.

@Injectable()
export class PaperDrawdownAbortHandler {
    private readonly logger = new Logger(PaperDrawdownAbortHandler.name);

    // Idempotency latch — set true on the first drawdown trip in a soak,
    // reset to false externally if operator resumes (not currently wired —
    // PAPER drawdown abort is one-shot per soak by design; rearm is a
    // deferred operator-runbook surface).
    private hasTripped = false;

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly haltFlag: HaltFlagService,
        private readonly haltService: HaltService,
        private readonly accountState: PaperAccountStateService,
        private readonly codec: PaperStateAuditHmacCodec,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
    ) {}

    @OnEvent(PAPER_MARK_TO_MARKET_EVENT)
    async onMarkToMarket(event: IPaperMarkToMarketEvent): Promise<void> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            // Defence-in-depth — the handler is bound conditionally in
            // PaperModeModule, but a misconfigured wiring under LIVE/TESTNET
            // must never halt the live engine via a paper-mode event.
            return;
        }

        if (!event.drawdownAbortTripped) {
            return;
        }

        if (this.hasTripped) {
            // Second-and-later events while already tripped: log INFO, do
            // NOT alert and do NOT write a second audit row. Avoids
            // Telegram-spam under sustained adverse mark.
            this.logger.log(
                `PaperDrawdownAbortHandler: drawdown event suppressed (already tripped) — ` +
                    `equity=${event.equity.toFixed()} peakEquity=${event.peakEquity.toFixed()} drawdownPct=${event.drawdownPct}`,
            );

            return;
        }

        this.hasTripped = true;

        await this.executeAbort(event);
    }

    // ----- testing seam -----

    // Tests can reset the one-shot latch between cases without touching
    // internal state directly. Not exposed to production callers.
    resetForTest(): void {
        this.hasTripped = false;
    }

    isTripped(): boolean {
        return this.hasTripped;
    }

    // Three-step abort: (a) flip the halt flag + record pragmatic transition
    // so HaltService's read surface agrees; (b) write the standalone audit
    // row (separate transaction per the R2b structural rule); (c) publish the
    // CRITICAL alert. Failures in (b) or (c) are logged but do not undo the
    // halt-flag flip — the safety stop is the load-bearing invariant.
    private async executeAbort(event: IPaperMarkToMarketEvent): Promise<void> {
        const reason = `paper drawdown abort: equity=${event.equity.toFixed()} <= peak*0.85 (peak=${event.peakEquity.toFixed()}, dd=${event.drawdownPct})`;

        // (a) Halt-flag flip. RiskListeners uses HaltFlagService.halt
        // directly for programmatic halts, then notes the pragmatic
        // transition on HaltService so `getState()` reports the source.
        try {
            if (!this.haltFlag.isHalted()) {
                this.haltFlag.halt(`${HaltSourceEnum.MODEL_DIVERGENCE}:paper_drawdown`);
                this.haltService.notePragmaticTransition(HaltSourceEnum.MODEL_DIVERGENCE, 'paper_drawdown', event.evaluatedAt.getTime());
            }
        } catch (cause) {
            this.logger.error(`PaperDrawdownAbortHandler: halt-flag flip failed — ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        // (b) Audit row. Opens its own audited transaction.
        try {
            const payloadHash = this.codec.hashOrderedPayload([
                ['op', 'drawdown_abort'],
                ['evaluated_at', event.evaluatedAt.toISOString()],
                ['equity', event.equity.toFixed()],
                ['peak_equity', event.peakEquity.toFixed()],
                ['drawdown_pct', event.drawdownPct],
            ]);

            await this.accountState.appendStandaloneAuditRow({
                mutationKind: MutationKindEnum.DRAWDOWN_ABORT,
                payloadHash,
            });
        } catch (cause) {
            this.logger.error(`PaperDrawdownAbortHandler: audit-row append failed — ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        // (c) CRITICAL Telegram alert.
        const payload: IAlertPayload = {
            type: AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: event.evaluatedAt.toISOString(),
            title: 'PAPER drawdown abort engaged',
            body: reason,
            data: {
                equity: event.equity.toFixed(),
                peakEquity: event.peakEquity.toFixed(),
                drawdownPct: String(event.drawdownPct),
            },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`PaperDrawdownAbortHandler: alert publish failed — ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        this.logger.error(`PAPER drawdown abort — ${reason}`);
    }
}
