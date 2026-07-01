import { ExchangeEnvironmentEnum, IMomentumParams, IUniverseRebalanceDueEvent, momentumParamsSchema, UNIVERSE_REBALANCE_DUE_EVENT } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AppConfigService } from '../../config/service';
import { MOMENTUM_REBALANCE_INTERVAL_NAME } from '../const';
import { CLOCK_PORT, IClockPort } from '../interface/IClockPort';
import { StrategyVersionRepository } from '../repository/StrategyVersionRepository';

// The M50 rebalance scheduler (ADR 0048 §2.2). Its SOLE job is to emit UNIVERSE_REBALANCE_DUE_EVENT
// on the active momentum version's `rebalance_interval_ms` cadence — it does NO ranking. The
// interval is registered dynamically (via SchedulerRegistry.addInterval) because the cadence is a
// runtime param value, not a compile-time @Interval constant. The clock is injected (CLOCK_PORT)
// so the emitted nowMs is deterministically controllable in tests. Registers/emits ONLY when
// EXCHANGE_ENV=paper AND ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID is set (ADR 0047 §2.6); any other
// env logs a WARN and stays fully dormant — no live/testnet capital can reach the momentum path.
@Injectable()
export class RebalanceSchedulerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RebalanceSchedulerService.name);

    private intervalRegistered = false;

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

        this.registerInterval(params);
    }

    onModuleDestroy(): void {
        if (!this.intervalRegistered) {
            return;
        }

        this.schedulerRegistry.deleteInterval(MOMENTUM_REBALANCE_INTERVAL_NAME);
        this.intervalRegistered = false;
    }

    private registerInterval(params: IMomentumParams): void {
        const handle = setInterval(() => this.emitRebalanceDue(), params.rebalance_interval_ms);

        this.schedulerRegistry.addInterval(MOMENTUM_REBALANCE_INTERVAL_NAME, handle);
        this.intervalRegistered = true;

        this.logger.log(`momentum rebalance scheduler registered (intervalMs=${params.rebalance_interval_ms})`);
    }

    private emitRebalanceDue(): void {
        const payload: IUniverseRebalanceDueEvent = { nowMs: this.clock.nowMs() };

        this.events.emit(UNIVERSE_REBALANCE_DUE_EVENT, payload);
    }
}
