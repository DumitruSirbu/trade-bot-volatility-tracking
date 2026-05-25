import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import { CLOCK, IClock } from '../common/clock/Clock';
import { AppConfigService } from '../config/service';
import { IRevokedJtiRepositoryPort, REVOKED_JTI_REPOSITORY } from './AuthModule';

// M11a W1.6 (ADR 0031). Hourly cron-driven prune of the `revoked_jti` table.
//
// Why hourly: dominant cost is one indexed DELETE — negligible — so the
// trade-off favours bounding post-floor lag and aligning with the operator's
// daily-check cadence. Daily cadence rejected per ADR 0031 §2.3.
//
// Invariant (load-bearing): a row is eligible for deletion ONLY when
// `revoked_at < now() - prune_after`, with `prune_after >= AUTH_TOKEN_TTL_SEC
// + 3600s`. The floor is asserted at boot in `AppConfigService`; this
// scheduler trusts that gate and applies the configured TTL directly.
//
// Single-host only (ADR 0031 §2.3 — pg_cron rejected for M11a).
//
// Alert: when row count exceeds REVOKED_JTI_MAX_ROWS (default 10_000), emit
// one Telegram WARNING per scheduler tick (no further coalescing — hourly
// cadence is already coarse). Reason: REVOKED_JTI_UNBOUNDED.

const HOURLY_CRON_EXPR = '0 * * * *';
const REVOKED_JTI_UNBOUNDED_REASON = 'REVOKED_JTI_UNBOUNDED';

@Injectable()
export class RevokedJtiPruneScheduler {
    private readonly logger = new Logger(RevokedJtiPruneScheduler.name);

    constructor(
        @Inject(REVOKED_JTI_REPOSITORY) private readonly revoked: IRevokedJtiRepositoryPort,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Inject(CLOCK) private readonly clock: IClock,
        private readonly appConfig: AppConfigService,
    ) {}

    @Cron(HOURLY_CRON_EXPR, { timeZone: 'UTC' })
    async onHourlyTick(): Promise<void> {
        await this.runOnce(this.clock.now());
    }

    // Public entrypoint for tests + ops probes — pure on the injected clock.
    async runOnce(now: Date): Promise<void> {
        const pruneAfterMs = this.appConfig.revokedJtiPruneAfterSec * 1000;
        const cutoff = new Date(now.getTime() - pruneAfterMs);

        const deletedCount = await this.pruneSafely(cutoff);
        const totalAfter = await this.countSafely();

        this.logger.log(`revokedJti.prune deleted=${deletedCount} remaining=${totalAfter} cutoff=${cutoff.toISOString()}`);

        if (totalAfter > this.appConfig.revokedJtiMaxRows) {
            await this.fireUnboundedAlert(totalAfter, now);
        }
    }

    private async pruneSafely(cutoff: Date): Promise<number> {
        try {
            return await this.revoked.pruneOlderThan(cutoff);
        } catch (cause) {
            this.logger.error(`revokedJti.prune.failed cause=${(cause as Error).message}`);

            return 0;
        }
    }

    private async countSafely(): Promise<number> {
        try {
            return await this.revoked.countAll();
        } catch (cause) {
            this.logger.error(`revokedJti.count.failed cause=${(cause as Error).message}`);

            return 0;
        }
    }

    private async fireUnboundedAlert(rowCount: number, now: Date): Promise<void> {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.WARN,
            occurredAt: now.toISOString(),
            title: `revoked_jti row count exceeded threshold`,
            body: `revoked_jti has ${rowCount} rows (> ${this.appConfig.revokedJtiMaxRows}). Reason=${REVOKED_JTI_UNBOUNDED_REASON}.`,
            data: {
                reason: REVOKED_JTI_UNBOUNDED_REASON,
                rowCount: String(rowCount),
                threshold: String(this.appConfig.revokedJtiMaxRows),
            },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.warn(`revokedJti.alert.failed cause=${(cause as Error).message}`);
        }
    }
}
