import { join } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from './dataSourceOptions';

// CLI datasource for the TypeORM migration commands. It runs OUTSIDE the Nest
// runtime, so it loads the repo-root .env itself rather than going through
// AppConfigService. Used only by migration:generate/run/revert.
loadDotenv({ path: join(__dirname, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run TypeORM migrations.');
}

export default new DataSource(buildDataSourceOptions(databaseUrl));
