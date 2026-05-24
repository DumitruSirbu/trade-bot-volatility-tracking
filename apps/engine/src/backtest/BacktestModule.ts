import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderPolicyRouter } from '../execution/service/OrderPolicyRouter';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { BookSnapshotEntity, CandleEntity, FundingRateEntity, OpenInterestEntity, TickAggregateEntity, UniverseMembershipEntity } from '../market-data/entity';
import { RiskModule } from '../risk/RiskModule';
import { StrategyModule } from '../strategy/StrategyModule';
import { RunBacktestCommand } from './cli/RunBacktestCommand';
import { BACKTEST_ORDER_POLICY_ROUTER } from './const/backtestTokens';
import { BacktestOrchestrator } from './service/BacktestOrchestrator';
import { BacktestRunnerService } from './service/BacktestRunnerService';
import { BootstrapStatsService } from './service/BootstrapStatsService';
import { CandleLoader } from './service/CandleLoader';
import { ComparisonRunnerService } from './service/ComparisonRunnerService';
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
        BootstrapStatsService,
        ComparisonRunnerService,
        RunBacktestCommand,
        // M8 W1: bind the live `OrderPolicyRouter` to the backtest token by default. The
        // router is pure (no I/O — see OrderPolicyRouter doc comment) so registering it
        // here in addition to ExecutionModule is safe; both modules import the same
        // `orderPolicyMatrix` (single source of truth per ADR 0005 §5). We deliberately do
        // NOT import ExecutionModule (which would drag in ccxt / ExchangeModule) — ADR 0015
        // §4.9 requires the backtest CLI's Nest context to be free of live exchange wiring.
        OrderPolicyRouter,
        { provide: BACKTEST_ORDER_POLICY_ROUTER, useExisting: OrderPolicyRouter },
    ],
    exports: [BacktestRunnerService, ComparisonRunnerService, RunBacktestCommand],
})
export class BacktestModule {}
