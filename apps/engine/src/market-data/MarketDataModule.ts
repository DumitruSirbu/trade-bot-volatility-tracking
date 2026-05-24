import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
    BookSnapshotEntity,
    CandleEntity,
    FundingRateEntity,
    InstrumentEntity,
    OpenInterestEntity,
    TickAggregateEntity,
    UniverseMembershipEntity,
} from './entity';
import { BookSnapshotRepository } from './repository/BookSnapshotRepository';
import { CandleRepository } from './repository/CandleRepository';
import { FundingRateRepository } from './repository/FundingRateRepository';
import { InstrumentRepository } from './repository/InstrumentRepository';
import { OpenInterestRepository } from './repository/OpenInterestRepository';
import { TickAggregateRepository } from './repository/TickAggregateRepository';
import { UniverseMembershipRepository } from './repository/UniverseMembershipRepository';
import { ExchangeModule } from '../exchange/ExchangeModule';
import {
    DepthAggressorService,
    DeviationCalibrationService,
    FlowPollService,
    MarketContextService,
    MarketDataPersistenceListener,
    MarketDataService,
    SubscriptionRetainer,
    SymbolStateRegistry,
    TickAggregatePartitionService,
    UniverseService,
} from './service';

// The only consumer of IExchangeClient. Owns the universe, candle aggregation,
// closed-bar indicators, the tiered depth/OI/aggressor subscriptions, the shared
// trigger evaluation, and the price.update / volatility.detected emissions (ADR 0001 §1).
// In M2 it also owns the market-data tables (instruments, candles, tick_aggregates,
// open_interest, funding_rates, book_snapshots, universe_membership) + their repositories,
// the passive @OnEvent persistence listener, and the tick_aggregates partition crons
// (ADR 0002 §1/§3/§4).
@Module({
    imports: [
        ExchangeModule,
        TypeOrmModule.forFeature([
            InstrumentEntity,
            CandleEntity,
            TickAggregateEntity,
            OpenInterestEntity,
            FundingRateEntity,
            BookSnapshotEntity,
            UniverseMembershipEntity,
        ]),
    ],
    providers: [
        SymbolStateRegistry,
        UniverseService,
        MarketContextService,
        DepthAggressorService,
        FlowPollService,
        DeviationCalibrationService,
        MarketDataService,
        MarketDataPersistenceListener,
        TickAggregatePartitionService,
        SubscriptionRetainer,
        InstrumentRepository,
        CandleRepository,
        TickAggregateRepository,
        OpenInterestRepository,
        FundingRateRepository,
        BookSnapshotRepository,
        UniverseMembershipRepository,
    ],
    exports: [
        UniverseService,
        SymbolStateRegistry,
        MarketContextService,
        SubscriptionRetainer,
        InstrumentRepository,
        CandleRepository,
        TickAggregateRepository,
        OpenInterestRepository,
        FundingRateRepository,
        BookSnapshotRepository,
        UniverseMembershipRepository,
    ],
})
export class MarketDataModule {}
