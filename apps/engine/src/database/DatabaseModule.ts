import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfigModule } from '../config/AppConfigModule';
import { AppConfigService } from '../config/service';
import { buildDataSourceOptions } from './dataSourceOptions';

// Wires the TypeORM runtime connection from validated config. Migrations are
// applied via the CLI (dataSource.ts), so migrationsRun stays off here.
@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [AppConfigModule],
            inject: [AppConfigService],
            useFactory: (appConfig: AppConfigService) => buildDataSourceOptions(appConfig.databaseUrl),
        }),
    ],
})
export class DatabaseModule {}
