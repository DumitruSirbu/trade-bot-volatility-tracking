import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { POSITION_CLOSED_EVENT, POSITION_OPENED_EVENT } from '../../common/const';
import { IPositionOpenedEvent } from '../../common/interface';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { RiskStateRepository } from '../repository/RiskStateRepository';

// Recompute-on-lifecycle accounting for risk_state (ADR 0014 §4a).
//
// Background: `risk_state.open_exposure` was never incremented on a happy-path open — it
// was only rebuilt at boot (phase4aRebuildOpenExposure). A close-only decrement would be
// incoherent (nothing ever booked the open). This listener recomputes the full day rollup
// on BOTH open and close so the two sides stay consistent.
//
// Accounting model: Option R (recompute — SELECT then upsert, idempotent by construction).
// Each event triggers one SELECT-then-upsert; a duplicate event re-derives the same totals
// from the authoritative position rows, so it cannot double-book.
//
// Derivations (UTC-day scoped, explicit half-open range — never CURRENT_DATE):
//   - open_exposure   = SUM(qty * entry_price) over qty > 0 AND state != CLOSED
//                       (residual notional — matches reconcileClose, NOT entry_notional).
//   - realized_pnl_day = SUM(realized_pnl) over CLOSED rows closed in the current UTC day.
//   - trades_count     = COUNT(*) over the same closed-today predicate.
//
// The halt SoT columns (is_halted / halt_reason) are owned exclusively by the halt-gate paths.
// This listener owns accounting only — it calls the column-scoped `upsertAccountingForDay`,
// which never reads nor writes halt state: a full-row upsert here could race a concurrent
// persistHalt and silently lift an active loss-halt.
@Injectable()
export class RiskStateLifecycleListener {
    private readonly logger = new Logger(RiskStateLifecycleListener.name);

    constructor(
        private readonly positions: PositionRepository,
        private readonly riskState: RiskStateRepository,
    ) {}

    // The widened IPositionOpenedEvent payload is accepted for type-coherence with the
    // emitter, but this listener recomputes the full UTC-day rollup from the authoritative
    // position rows (Option R) and so reads no event field.
    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpened(_event?: IPositionOpenedEvent): Promise<void> {
        await this.recomputeForToday('open');
    }

    @OnEvent(POSITION_CLOSED_EVENT)
    async onPositionClosed(): Promise<void> {
        await this.recomputeForToday('close');
    }

    private async recomputeForToday(trigger: 'open' | 'close'): Promise<void> {
        const utcDayStart = this.currentUtcDayStart();
        const utcDateString = utcDayStart.toISOString().slice(0, 10);

        // @OnEvent handlers are fire-and-forget — the emitter never awaits this. An unhandled
        // rejection here would leave risk_state stale silently, so we catch + log at error
        // level (matching RiskListeners' @OnEvent convention) and never rethrow.
        try {
            const { openExposure } = await this.positions.findLiveRiskAggregates();
            const { realizedPnlDay, tradesCount } = await this.positions.findClosedTodayAggregates(utcDayStart);

            await this.riskState.upsertAccountingForDay(utcDateString, { openExposure, realizedPnlDay, tradesCount });

            this.logger.log(
                `risk_state recompute (${trigger}): date=${utcDateString} open_exposure=${openExposure.toFixed()} ` +
                    `realized_pnl_day=${realizedPnlDay.toFixed()} trades_count=${tradesCount}`,
            );
        } catch (cause) {
            this.logger.error(`risk_state recompute failed (${trigger}): date=${utcDateString} cause=${formatError(cause)}`);
        }
    }

    // Midnight of the current UTC day. Explicit UTC arithmetic — never CURRENT_DATE
    // (session-timezone dependent near midnight) or Date#toDateString (local-zone).
    private currentUtcDayStart(): Date {
        const now = new Date();

        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
}

function formatError(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
