import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';

import { CLOCK, IClock } from '../common/clock/Clock';
import { MS_PER_DAY } from '../common/const/timeConsts';
import { PositionRepository } from '../position/repository/PositionRepository';
import { ALERT_SINK, IAlertSink } from './sink/AlertSinkModule';

// M9 W6 (ADR 0024 §2.5). Fires once per UTC day at 00:00:00 with a one-line
// PnL summary for the just-completed risk-day.
//
// The cron decorator is wired with `timeZone: 'UTC'` so the trigger does not
// drift with the host timezone — UTC is the project-wide risk-day per
// `docs/plans/00-overview.md`.
//
// The summary reads:
//   - count of positions closed on YESTERDAY (UTC),
//   - aggregated realized PnL,
//   - W/L counts,
//   - max intraday CLOSED-PnL drawdown across the day's close sequence
//     (peak-to-trough on the cumulative realized-PnL series — NOT equity-curve
//     drawdown including unrealised; the name reflects that to avoid confusion
//     with portfolio MDD metrics).
//
// Idempotency: a re-trigger within the same UTC day (e.g. process restart
// crossing midnight twice during testing) is suppressed by tracking the last
// emitted date string. The check is per-process; a true restart will re-emit
// at the next tick, which is acceptable — the daily summary is advisory.

const DAILY_CRON_EXPR = '0 0 * * *';

@Injectable()
export class DailyPnlSummaryScheduler {
    private readonly logger = new Logger(DailyPnlSummaryScheduler.name);
    private lastEmittedForDateUtc: string | null = null;

    constructor(
        private readonly positions: PositionRepository,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Inject(CLOCK) private readonly clock: IClock,
    ) {}

    @Cron(DAILY_CRON_EXPR, { timeZone: 'UTC' })
    async onMidnightUtc(): Promise<void> {
        await this.runOnce(this.clock.now());
    }

    // Public entrypoint used by tests + the optional `/v1/control/daily-summary` admin
    // probe (M11). Pure on the injected clock.
    async runOnce(now: Date): Promise<void> {
        const yesterdayDateString = priorUtcDayString(now);

        if (this.lastEmittedForDateUtc === yesterdayDateString) {
            this.logger.debug(`dailyPnl.skip date=${yesterdayDateString} reason=alreadyEmitted`);
            return;
        }

        const closed = await this.positions.findClosedOnUtcDay(yesterdayDateString);
        const summary = summariseDay(closed);

        const payload: IAlertPayload = {
            type: AlertTypeEnum.DAILY_PNL_SUMMARY,
            severity: AlertSeverityEnum.INFO,
            occurredAt: now.toISOString(),
            title: `Daily PnL summary ${yesterdayDateString} UTC`,
            body:
                `[${yesterdayDateString} UTC] realized ${formatUsd(summary.realizedPnl)}, ` +
                `trades ${summary.trades} (${summary.wins}W/${summary.losses}L), ` +
                `max intraday closed-PnL drawdown ${formatUsd(summary.maxIntradayClosedPnlDrawdown)}`,
            data: {
                date: yesterdayDateString,
                trades: String(summary.trades),
                wins: String(summary.wins),
                losses: String(summary.losses),
            },
        };

        try {
            await this.alerts.publish(payload);
            this.lastEmittedForDateUtc = yesterdayDateString;
        } catch (cause) {
            this.logger.error(`dailyPnl.publishFailed date=${yesterdayDateString} cause=${describe(cause)}`);
        }
    }
}

interface IDaySummary {
    realizedPnl: Decimal;
    trades: number;
    wins: number;
    losses: number;
    maxIntradayClosedPnlDrawdown: Decimal;
}

function summariseDay(closed: ReadonlyArray<{ realizedPnl?: Decimal | null }>): IDaySummary {
    let realized = new Decimal(0);
    let wins = 0;
    let losses = 0;
    // R1 fix wave #6: seed runningPeak with the first realised value (capped at
    // 0 as the implicit pre-trade peak). A day that OPENS negative would
    // otherwise look like "zero drawdown" until the cumulative series climbs
    // back to 0, hiding the real peak-to-trough on a losing day.
    let runningPeak = new Decimal(0);
    let maxIntradayClosedPnlDrawdown = new Decimal(0);

    for (const row of closed) {
        const pnl = row.realizedPnl ?? new Decimal(0);

        realized = realized.plus(pnl);

        if (pnl.gt(0)) {
            wins += 1;
        } else if (pnl.lt(0)) {
            losses += 1;
        }

        if (realized.gt(runningPeak)) {
            runningPeak = realized;
        }

        const drawdown = runningPeak.minus(realized);

        if (drawdown.gt(maxIntradayClosedPnlDrawdown)) {
            maxIntradayClosedPnlDrawdown = drawdown;
        }
    }

    return {
        realizedPnl: realized,
        trades: closed.length,
        wins,
        losses,
        maxIntradayClosedPnlDrawdown,
    };
}

// 'YYYY-MM-DD' for the UTC date one day BEFORE `now`. The scheduler fires at
// 00:00 UTC, so the just-completed risk-day is `now - 1 day`.
function priorUtcDayString(now: Date): string {
    const prior = new Date(now.getTime() - MS_PER_DAY);
    const yyyy = prior.getUTCFullYear();
    const mm = String(prior.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(prior.getUTCDate()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
}

function formatUsd(value: Decimal): string {
    const sign = value.isNegative() ? '-' : '';
    const abs = value.abs().toFixed(2);

    return `${sign}$${abs}`;
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
