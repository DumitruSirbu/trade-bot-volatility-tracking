import { Module } from '@nestjs/common';

import { CommonModule } from './common/CommonModule';
import { AppConfigModule } from './config/AppConfigModule';
import { DatabaseModule } from './database/DatabaseModule';
import { ExchangeModule } from './exchange/ExchangeModule';
import { HealthModule } from './health/HealthModule';
import { MarketDataModule } from './market-data/MarketDataModule';
import { PositionModule } from './position/PositionModule';
import { RiskModule } from './risk/RiskModule';
import { StrategyModule } from './strategy/StrategyModule';

@Module({
    imports: [AppConfigModule, CommonModule, DatabaseModule, HealthModule, ExchangeModule, MarketDataModule, StrategyModule, PositionModule, RiskModule],
})
export class AppModule {}
