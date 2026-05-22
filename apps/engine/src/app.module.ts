import { Module } from '@nestjs/common';

import { CommonModule } from './common/CommonModule';
import { AppConfigModule } from './config/AppConfigModule';
import { DatabaseModule } from './database/DatabaseModule';
import { ExchangeModule } from './exchange/ExchangeModule';
import { HealthModule } from './health/HealthModule';
import { MarketDataModule } from './market-data/MarketDataModule';

@Module({
    imports: [AppConfigModule, CommonModule, DatabaseModule, HealthModule, ExchangeModule, MarketDataModule],
})
export class AppModule {}
