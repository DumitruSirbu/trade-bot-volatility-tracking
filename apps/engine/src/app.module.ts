import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { AuthCorsInterceptor } from './auth/AuthCorsInterceptor';
import { AuthModule } from './auth/AuthModule';
import { BackupModule } from './backup/BackupModule';
import { BacktestModule } from './backtest/BacktestModule';
import { BootstrapModule } from './bootstrap/BootstrapModule';
import { CommonModule } from './common/CommonModule';
import { AppConfigModule } from './config/AppConfigModule';
import { ControlModule } from './control/ControlModule';
import { DatabaseModule } from './database/DatabaseModule';
import { ExchangeModule } from './exchange/ExchangeModule';
import { ExecutionModule } from './execution/ExecutionModule';
import { HealthModule } from './health/HealthModule';
import { MarketDataModule } from './market-data/MarketDataModule';
import { PositionModule } from './position/PositionModule';
import { PromotionModule } from './promotion/PromotionModule';
import { ReadApiModule } from './read-api/ReadApiModule';
import { RiskModule } from './risk/RiskModule';
import { StrategyModule } from './strategy/StrategyModule';
import { WsModule } from './ws/WsModule';

// BootstrapModule sits last so its OnApplicationBootstrap hook fires after
// every other module's providers are fully initialised.
@Module({
    imports: [
        AppConfigModule,
        CommonModule,
        DatabaseModule,
        AuthModule,
        HealthModule,
        ExchangeModule,
        MarketDataModule,
        StrategyModule,
        PositionModule,
        RiskModule,
        ExecutionModule,
        ControlModule,
        BacktestModule,
        PromotionModule,
        ReadApiModule,
        WsModule,
        BackupModule,
        BootstrapModule,
    ],
})
export class AppModule implements NestModule {
    // M9 R1 #4 — register AuthCorsInterceptor as a global NestMiddleware so
    // CORS preflight + cross-origin requests are short-circuited BEFORE any
    // route handler / guard runs. Per ADR 0020 §2.3 the allow-list lives in
    // AppConfigService (single source of truth).
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(AuthCorsInterceptor).forRoutes('*');
    }
}
