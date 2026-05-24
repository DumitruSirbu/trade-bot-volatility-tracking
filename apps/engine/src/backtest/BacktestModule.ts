import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from '../market-data/MarketDataModule';
import { BookSnapshotEntity, CandleEntity, FundingRateEntity, OpenInterestEntity, TickAggregateEntity, UniverseMembershipEntity } from '../market-data/entity';
import { RiskModule } from '../risk/RiskModule';
import { StrategyModule } from '../strategy/StrategyModule';
import { RunBacktestCommand } from './cli/RunBacktestCommand';
import { BacktestOrchestrator } from './service/BacktestOrchestrator';
import { BacktestRunnerService } from './service/BacktestRunnerService';
import { CandleLoader } from './service/CandleLoader';
import { FundingReplayLoader } from './service/FundingReplayLoader';
import { IndicatorStateBuilder } from './service/IndicatorStateBuilder';
import { MetricsComputer } from './service/MetricsComputer';
import { PointInTimeUniverse } from './service/PointInTimeUniverse';

// Backtest module (ADR 0015 §2). Owns the per-run runner, the event-driven orchestrator,
// the historical-data loaders, the deterministic indicator-window builder, and the metrics
// computer. Imports:
//   - TypeOrmModule.forFeature: the historical entities the loaders read via @InjectRepository.
//   - MarketDataModule: re-uses the InstrumentRepository / OpenInterestRepository /
//     BookSnapshotRepository the runner needs without owning a second copy.
//   - StrategyModule: provides StrategyRegistry + StrategyVersionRepository so the runner
//     resolves the IStrategy implementation under test.
//   - RiskModule: provides RiskGateService + PositionSizer + ReservationLedger which the
//     BacktestOrchestrator injects to run gate-checks bypass-proof (same gate as live).
//
// No event listeners — the backtest is driven by `BacktestRunnerService.run(config)` (or
// `RunBacktestCommand.run`), never by live `volatility.detected` events.
@Module({
    imports: [
        TypeOrmModule.forFeature([CandleEntity, UniverseMembershipEntity, FundingRateEntity, BookSnapshotEntity, OpenInterestEntity, TickAggregateEntity]),
        MarketDataModule,
        StrategyModule,
        RiskModule,
    ],
    providers: [
        CandleLoader,
        PointInTimeUniverse,
        IndicatorStateBuilder,
        FundingReplayLoader,
        MetricsComputer,
        BacktestOrchestrator,
        BacktestRunnerService,
        RunBacktestCommand,
    ],
    exports: [BacktestRunnerService, RunBacktestCommand],
})
export class BacktestModule {}
