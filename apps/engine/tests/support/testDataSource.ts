/**
 * Shared test DataSource bootstrap.
 *
 * Builds a DataSource from TEST_DATABASE_URL (the dedicated port-6900 test
 * container), runs migrations idempotently, and exposes helpers used by every
 * DB-backed integration suite so each suite does NOT manage its own connection
 * or migration lifecycle.
 *
 * Isolation contract:
 *   - Schema (tables) is created once in globalSetup via runMigrations.
 *   - Row-level cleanup is the responsibility of each suite via DELETE WHERE
 *     symbol = TEST_SYMBOL (or equivalent) in afterAll/afterEach.
 *   - The migration round-trip suite uses MIGRATION_TEST_DB_URL (a separate
 *     DB in the same container) so destructive reverts never touch the shared
 *     integration schema.
 */

import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';
import { assertTestDb, buildRoleDbUrl, getTestDbUrl } from './assertTestDb';

export { getTestDbUrl, buildRoleDbUrl, assertTestDb };

let sharedDataSource: DataSource | null = null;

/**
 * Returns the shared DataSource, initializing it and running migrations on the
 * first call. Subsequent calls return the same instance (idempotent).
 */
export async function getTestDataSource(): Promise<DataSource> {
    if (sharedDataSource !== null && sharedDataSource.isInitialized) {
        return sharedDataSource;
    }

    const options = buildDataSourceOptions(getTestDbUrl());
    const dataSource = new DataSource(options);

    await dataSource.initialize();
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
