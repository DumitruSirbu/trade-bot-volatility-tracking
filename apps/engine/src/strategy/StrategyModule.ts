import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { ComparisonReportEntity, DecisionEntity, StrategyVersionEntity } from './entity';
import { StrategyRegistry } from './registry';
import { ComparisonReportRepository } from './repository/ComparisonReportRepository';
import { DecisionRepository } from './repository/DecisionRepository';
import { StrategyVersionRepository } from './repository/StrategyVersionRepository';
import { StrategyService } from './service';
import { V0BaselineStrategy, V1MeanReversionStrategy, V2MomentumStrategy, V3HybridRouterStrategy } from './strategies';

// Owns strategy_versions + decisions (M2) plus the M3 strategy engine: the four
// IStrategy impls, the registry, and the StrategyService orchestrator that listens for
// volatility.detected, classifies/stamps flow_type + signal_score, runs the active
// strategy, and writes a dry-run decision. PositionModule is imported for its exported
// PositionRepository (open-position lookup); AppConfigService is global.
//
// M8 W2 adds ComparisonReportRepository here (rather than a new ComparisonModule)
// because comparison reports anchor strategy-version promotions — they live in the
// same audit/lineage concern as strategy_versions. If the comparison surface grows
// beyond the anchor row (per-event outcome table, regime breakdown reads, etc.) a
// dedicated ComparisonModule will be carved out then.
@Module({
    imports: [TypeOrmModule.forFeature([StrategyVersionEntity, DecisionEntity, ComparisonReportEntity]), forwardRef(() => PositionModule), MarketDataModule, forwardRef(() => RiskModule)],
    providers: [
        StrategyVersionRepository,
        DecisionRepository,
        ComparisonReportRepository,
        StrategyRegistry,
        StrategyService,
        V0BaselineStrategy,
        V1MeanReversionStrategy,
        V2MomentumStrategy,
        V3HybridRouterStrategy,
    ],
    exports: [StrategyVersionRepository, DecisionRepository, ComparisonReportRepository, StrategyRegistry],
})
export class StrategyModule {}
