import { Module } from '@nestjs/common';

import { BacktestModule } from './backtest/BacktestModule';
import { BootstrapModule } from './bootstrap/BootstrapModule';
import { CommonModule } from './common/CommonModule';
import { AppConfigModule } from './config/AppConfigModule';
import { DatabaseModule } from './database/DatabaseModule';
import { ExchangeModule } from './exchange/ExchangeModule';
import { ExecutionModule } from './execution/ExecutionModule';
import { HealthModule } from './health/HealthModule';
import { MarketDataModule } from './market-data/MarketDataModule';
import { PositionModule } from './position/PositionModule';
import { PromotionModule } from './promotion/PromotionModule';
import { RiskModule } from './risk/RiskModule';
import { StrategyModule } from './strategy/StrategyModule';

// BootstrapModule sits last so its OnApplicationBootstrap hook fires after
// every other module's providers are fully initialised.
@Module({
    imports: [
        AppConfigModule,
        CommonModule,
        DatabaseModule,
        HealthModule,
        ExchangeModule,
        MarketDataModule,
        StrategyModule,
        PositionModule,
        RiskModule,
        ExecutionModule,
        BacktestModule,
        PromotionModule,
        BootstrapModule,
    ],
})
export class AppModule {}
