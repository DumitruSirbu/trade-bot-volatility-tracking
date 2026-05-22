/**
 * Shared test DataSource bootstrap.
 *
 * Builds a DataSource from the test DB URL (port 5433), runs migrations
 * idempotently (TypeORM skips already-applied ones), and exposes helpers
 * used by every DB-backed integration suite so each suite does NOT manage
 * its own connection or migration lifecycle.
 *
 * Isolation contract:
 *   - Schema (tables) is created once by running migrations in beforeAll.
 *   - Row-level cleanup is the responsibility of each suite via DELETE WHERE
 *     symbol = TEST_SYMBOL (or equivalent) in afterAll/afterEach.
 *   - The migration round-trip suite uses its OWN isolated DataSource pointed
 *     at a separate DB schema so it never pollutes the shared schema.
 */

import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';

export const TEST_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';

let sharedDataSource: DataSource | null = null;

/**
 * Returns the shared DataSource, initializing it and running migrations on the
 * first call. Subsequent calls return the same instance (idempotent).
 */
export async function getTestDataSource(): Promise<DataSource> {
    if (sharedDataSource !== null && sharedDataSource.isInitialized) {
        return sharedDataSource;
    }

    const options = buildDataSourceOptions(TEST_DB_URL);
    const dataSource = new DataSource(options);

    await dataSource.initialize();
    // runMigrations is idempotent: TypeORM tracks applied migrations in the
    // migrations table and skips any that have already run.
    await dataSource.runMigrations({ transaction: 'each' });

    sharedDataSource = dataSource;

    return dataSource;
}

/**
 * Tears down the shared DataSource. Call from a global afterAll if needed,
 * or let the process exit naturally (Jest tears down the process anyway).
 */
export async function destroyTestDataSource(): Promise<void> {
    if (sharedDataSource?.isInitialized) {
        await sharedDataSource.destroy();
        sharedDataSource = null;
    }
}
