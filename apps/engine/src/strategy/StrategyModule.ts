import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { DecisionEntity, StrategyVersionEntity } from './entity';
import { StrategyRegistry } from './registry';
import { DecisionRepository } from './repository/DecisionRepository';
import { StrategyVersionRepository } from './repository/StrategyVersionRepository';
import { StrategyService } from './service';
import { V0BaselineStrategy, V1MeanReversionStrategy, V2MomentumStrategy, V3HybridRouterStrategy } from './strategies';

// Owns strategy_versions + decisions (M2) plus the M3 strategy engine: the four
// IStrategy impls, the registry, and the StrategyService orchestrator that listens for
// volatility.detected, classifies/stamps flow_type + signal_score, runs the active
// strategy, and writes a dry-run decision. PositionModule is imported for its exported
// PositionRepository (open-position lookup); AppConfigService is global.
@Module({
    imports: [TypeOrmModule.forFeature([StrategyVersionEntity, DecisionEntity]), PositionModule, MarketDataModule, RiskModule],
    providers: [
        StrategyVersionRepository,
        DecisionRepository,
        StrategyRegistry,
        StrategyService,
        V0BaselineStrategy,
        V1MeanReversionStrategy,
        V2MomentumStrategy,
        V3HybridRouterStrategy,
    ],
    exports: [StrategyVersionRepository, DecisionRepository],
})
export class StrategyModule {}
