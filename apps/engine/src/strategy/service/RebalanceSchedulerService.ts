import {
    ExchangeEnvironmentEnum,
    IMomentumParams,
    IUniverseRebalanceDueEvent,
    momentumParamsSchema,
    RebalanceTriggerSourceEnum,
    UNIVERSE_REBALANCE_DUE_EVENT,
} from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { AppConfigService } from '../../config/service';
import { MOMENTUM_REBALANCE_CRON_EXPRESSION, MOMENTUM_REBALANCE_CRON_NAME, MOMENTUM_REBALANCE_PERIOD_MS, REBALANCE_TRIGGER_COOLDOWN_MS } from '../const';
import { RebalanceTriggerForbiddenException, RebalanceTriggerRejectedException } from '../exception';
import { CLOCK_PORT, IClockPort } from '../interface/IClockPort';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';

// The M50 rebalance scheduler (ADR 0048 §2.2, amended ADR 0050 §4). Its SOLE job is to emit
// UNIVERSE_REBALANCE_DUE_EVENT on a fixed daily UTC cadence — it does NO ranking. The cron is
// registered dynamically (via SchedulerRegistry.addCronJob) so the paper gate still governs
// registration. The clock is injected (CLOCK_PORT) so the emitted nowMs is deterministically
// controllable in tests. Registers/emits ONLY when EXCHANGE_ENV=paper AND
// ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID is set (ADR 0047 §2.6).
@Injectable()
export class RebalanceSchedulerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RebalanceSchedulerService.name);

    private cronRegistered = false;

    // Timestamp (ms) of the last emission — scheduled OR manual — used by the manual-trigger
    // cooldown guard so a manual trigger cannot double-rebalance a window near the cron.
    private lastEmittedAtMs: number | null = null;

    constructor(
        private readonly config: AppConfigService,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly schedulerRegistry: SchedulerRegistry,
        private readonly events: EventEmitter2,
        @Inject(CLOCK_PORT) private readonly clock: IClockPort,
    ) {}

    async onModuleInit(): Promise<void> {
        const versionId = this.config.activePortfolioStrategyVersionId;

        if (this.config.exchangeEnv !== ExchangeEnvironmentEnum.PAPER || versionId === null) {
            this.logger.warn(
                `momentum rebalance scheduler dormant (exchangeEnv=${this.config.exchangeEnv} ` +
                    `activePortfolioStrategyVersionId=${versionId ?? 'unset'}) — portfolio path inactive`,
            );

            return;
        }

        let params: IMomentumParams;

        try {
            params = await this.resolveValidatedParams(versionId);
        } catch (cause) {
            this.logger.warn(`momentum rebalance scheduler not registered: ${cause instanceof Error ? cause.message : String(cause)}`);

            return;
        }

        this.registerCronJob(params);
    }

    onModuleDestroy(): void {
        if (!this.cronRegistered) {
            return;
        }

        this.schedulerRegistry.deleteCronJob(MOMENTUM_REBALANCE_CRON_NAME);
        this.cronRegistered = false;
    }

    // Public entrypoint for `POST /v1/control/trigger-rebalance` and the `pnpm rebalance:trigger`
    // CLI. Emits the same event the daily cron would — orchestrator + risk gate unchanged — but
    // tagged MANUAL and guarded by the same validation the cron path passed at registration plus a
    // cooldown window. Throws typed domain exceptions the controller maps to HTTP status codes.
    async triggerRebalanceDue(): Promise<ITriggerRebalanceDueResult> {
        if (this.config.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            throw new RebalanceTriggerForbiddenException('trigger-rebalance is paper-only');
        }

        const versionId = this.config.activePortfolioStrategyVersionId;

        if (versionId === null) {
            throw new RebalanceTriggerRejectedException('ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID unset — portfolio path dormant');
        }

        // Check the cheap in-memory cooldown BEFORE the async params DB read so a cooldown-rejected
        // rapid retrigger fails fast without a DB round-trip. nowMs is captured first because it is
        // the cooldown reference AND the authoritative rebalance instant carried on the emitted event.
        const nowMs = this.clock.nowMs();

        this.assertCooldownElapsed(nowMs);

        await this.resolveValidatedParams(versionId);

        this.emitRebalanceDueAt(nowMs, RebalanceTriggerSourceEnum.MANUAL);
        this.logger.log(`rebalance.manual_trigger nowMs=${nowMs}`);

        return { accepted: true, nowMs };
    }

    // Shared validation for the cron-registration path and the manual-trigger path: the configured
    // version must resolve to a row whose params pass the shared Zod schema. Throws a typed domain
    // exception on failure; onModuleInit downgrades it to a dormant WARN, the manual path surfaces it.
    private async resolveValidatedParams(versionId: number): Promise<IMomentumParams> {
        const row = await this.strategyVersions.findById(versionId);

        if (row === null) {
            throw new RebalanceTriggerRejectedException(`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID=${versionId} matches no strategy_versions row`);
        }

        try {
            return momentumParamsSchema.parse(row.params);
        } catch (cause) {
            throw new RebalanceTriggerRejectedException(
                `invalid momentum params for versionId=${versionId}: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
            );
        }
    }

    private assertCooldownElapsed(nowMs: number): void {
        if (this.lastEmittedAtMs === null) {
            return;
        }

        const elapsedMs = nowMs - this.lastEmittedAtMs;

        if (elapsedMs < REBALANCE_TRIGGER_COOLDOWN_MS) {
            throw new RebalanceTriggerRejectedException(
                `rebalance trigger within cooldown — last emission ${elapsedMs}ms ago (< ${REBALANCE_TRIGGER_COOLDOWN_MS}ms)`,
            );
        }
    }

    private registerCronJob(params: IMomentumParams): void {
        if (params.rebalance_interval_ms !== MOMENTUM_REBALANCE_PERIOD_MS) {
            this.logger.warn(
                `rebalance_interval_ms=${params.rebalance_interval_ms} != fixed 24h cadence — ` +
                    'the cron period is fixed; this param now only sizes the time-stop net',
            );
        }

        const job = new CronJob(MOMENTUM_REBALANCE_CRON_EXPRESSION, () => this.emitRebalanceDue(), null, true, 'UTC');

        this.schedulerRegistry.addCronJob(MOMENTUM_REBALANCE_CRON_NAME, job);
        this.cronRegistered = true;

        this.logger.log(`momentum rebalance cron registered (expression='${MOMENTUM_REBALANCE_CRON_EXPRESSION}' UTC)`);
    }

    private emitRebalanceDue(): void {
        this.emitRebalanceDueAt(this.clock.nowMs(), RebalanceTriggerSourceEnum.SCHEDULED);
    }

    private emitRebalanceDueAt(nowMs: number, triggerSource: RebalanceTriggerSourceEnum): void {
        const payload: IUniverseRebalanceDueEvent = { nowMs, triggerSource };

        this.events.emit(UNIVERSE_REBALANCE_DUE_EVENT, payload);
        this.lastEmittedAtMs = nowMs;
    }
}

// Result of a manual rebalance trigger. `accepted` means the event was validated and emitted for
// ASYNC processing by the orchestrator — NOT that the rebalance completed. The orchestrator may
// still skip (overlap in flight) or throw downstream; the scheduler's sole job is to emit.
export interface ITriggerRebalanceDueResult {
    readonly accepted: boolean;
    readonly nowMs: number;
}
