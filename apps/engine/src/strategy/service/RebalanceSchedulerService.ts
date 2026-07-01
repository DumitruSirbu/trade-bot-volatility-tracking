import { ExchangeEnvironmentEnum, IMomentumParams, IUniverseRebalanceDueEvent, momentumParamsSchema, UNIVERSE_REBALANCE_DUE_EVENT } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { AppConfigService } from '../../config/service';
import { MOMENTUM_REBALANCE_CRON_EXPRESSION, MOMENTUM_REBALANCE_CRON_NAME, MOMENTUM_REBALANCE_PERIOD_MS } from '../const';
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

        const row = await this.strategyVersions.findById(versionId);

        if (row === null) {
            this.logger.warn(`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID=${versionId} matches no strategy_versions row — scheduler not registered`);

            return;
        }

        let params: IMomentumParams;

        try {
            params = momentumParamsSchema.parse(row.params);
        } catch (cause) {
            this.logger.error(
                `momentum scheduler: invalid params for versionId=${versionId} — scheduler not registered: ` +
                    (cause instanceof Error ? cause.message : String(cause)),
            );

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
        const payload: IUniverseRebalanceDueEvent = { nowMs: this.clock.nowMs() };

        this.events.emit(UNIVERSE_REBALANCE_DUE_EVENT, payload);
    }
}
