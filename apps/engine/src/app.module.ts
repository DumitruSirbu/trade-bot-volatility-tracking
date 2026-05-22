import { Module } from '@nestjs/common';

import { CommonModule } from './common/CommonModule';
import { AppConfigModule } from './config/AppConfigModule';
import { DatabaseModule } from './database/DatabaseModule';
import { HealthModule } from './health/HealthModule';

@Module({
    imports: [AppConfigModule, CommonModule, DatabaseModule, HealthModule],
})
export class AppModule {}
