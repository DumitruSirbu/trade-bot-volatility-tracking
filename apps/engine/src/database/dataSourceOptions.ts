import { join } from 'node:path';

import { DataSourceOptions } from 'typeorm';

// Single source of TypeORM connection options, shared by the NestJS runtime
// (DatabaseModule) and the CLI datasource (migrations). synchronize is HARD-OFF
// in every environment — schema changes are migration-driven, never inferred.
export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
    return {
        type: 'postgres',
        url: databaseUrl,
        synchronize: false,
        migrationsTransactionMode: 'each',
        entities: [join(__dirname, '..', '**', 'entity', '*.{ts,js}')],
        migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    };
}
