import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookSnapshotEntity, CandleEntity, FundingRateEntity, OpenInterestEntity, TickAggregateEntity, UniverseMembershipEntity } from '../market-data/entity';
import { CandleLoader } from './service/CandleLoader';
import { IndicatorStateBuilder } from './service/IndicatorStateBuilder';
import { PointInTimeUniverse } from './service/PointInTimeUniverse';

// Backtest foundation (M7 W1). Owns the historical-data loaders and the deterministic
// indicator-window builder used by the replay loop. The module registers the existing
// market-data entities via TypeOrmModule.forFeature so the loaders can @InjectRepository
// them directly — MarketDataModule remains the owner; we only need read access here.
// CausalityGuard is a pure module of functions/exceptions and therefore not a provider.
@Module({
    imports: [TypeOrmModule.forFeature([CandleEntity, UniverseMembershipEntity, FundingRateEntity, BookSnapshotEntity, OpenInterestEntity, TickAggregateEntity])],
    providers: [CandleLoader, PointInTimeUniverse, IndicatorStateBuilder],
})
export class BacktestModule {}
