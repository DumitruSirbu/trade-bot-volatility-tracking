/**
 * Migration round-trip integration test (requires live Postgres).
 *
 * DB: this suite MUST run against a DEDICATED test database, never the soak/prod DB.
 * Set MIGRATION_TEST_DB_URL to an isolated Postgres instance before running:
 *   MIGRATION_TEST_DB_URL=postgresql://trade_bot:change_me@localhost:6900/trade_bot_migration \
 *     pnpm jest migration.roundtrip
 *
 * WARNING: this suite reverts ALL migrations then re-runs them. Any pre-existing
 * data in the target DB will be permanently deleted. It must NEVER connect to the
 * soak DB (DATABASE_URL / port 5433). The suite aborts if MIGRATION_TEST_DB_URL
 * is not set.
 *
 * Isolation: this suite uses its OWN private DataSource rather than the shared
 * one from testDataSource.ts.  It intentionally reverts all migrations to prove
 * the revert path is clean, then RE-RUNS them in afterAll so the shared schema
 * is restored for any suite that runs after this one.  This makes the suite
 * Repeatable and Independent (F.I.R.S.T.) — a second consecutive run passes
 * without a manual migration step in between.
 */

import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';

const TEST_DB_URL = process.env['MIGRATION_TEST_DB_URL'];

if (!TEST_DB_URL) {
    throw new Error(
        'MIGRATION_TEST_DB_URL is not set. This suite reverts ALL migrations and must NOT run against the soak DB. ' +
            'Point it at a dedicated test database: ' +
            'MIGRATION_TEST_DB_URL=postgresql://trade_bot:change_me@localhost:6900/trade_bot_migration pnpm jest migration.roundtrip',
    );
}

// The 13 tables created by CreateSchema migration.
const EXPECTED_TABLES = [
    'instruments',
    'candles',
    'tick_aggregates',
    'open_interest',
    'funding_rates',
    'book_snapshots',
    'universe_membership',
    'strategy_versions',
    'positions',
    'transactions',
    'decisions',
    'risk_state',
    'account_snapshots',
];

async function listUserTables(dataSource: DataSource): Promise<string[]> {
    const rows = (await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)) as { tablename: string }[];

    return rows.map((row) => row.tablename);
}

// Revert every applied migration. Loops on the migrations table (executed-migration count)
// so the test is robust to any future migration count — no hardcoded triple-undo.
async function revertAllMigrations(dataSource: DataSource): Promise<void> {
    const maxIterations = 50;

    for (let i = 0; i < maxIterations; i += 1) {
        try {
            const executed = (await dataSource.query(`SELECT COUNT(*)::int AS count FROM migrations`)) as { count: number }[];

            if (executed[0]!.count === 0) {
                return;
            }
        } catch {
            // migrations table does not exist yet — nothing to revert.
            return;
        }

        await dataSource.undoLastMigration({ transaction: 'each' });
    }

    throw new Error(`revertAllMigrations exceeded ${maxIterations} iterations — possible infinite loop`);
}

async function listTickPartitions(dataSource: DataSource): Promise<string[]> {
    const rows = (await dataSource.query(
        `SELECT c.relname FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'tick_aggregates'
         ORDER BY c.relname`,
    )) as { relname: string }[];

    return rows.map((row) => row.relname);
}

describe('Migration round-trip (integration — requires Postgres)', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        const options = buildDataSourceOptions(TEST_DB_URL!);
        dataSource = new DataSource(options);
        await dataSource.initialize();

        // Start from a clean slate: revert any prior run so the up() path is exercised
        // from scratch. Errors here are tolerated (nothing to revert on a fresh DB).
        try {
            await revertAllMigrations(dataSource);
        } catch {
            // Acceptable: migrations table may not exist yet.
        }
    }, 30_000);

    afterAll(async () => {
        // RE-RUN migrations so the schema is restored for any suite that runs after
        // this one — this is what makes the full suite Repeatable.  Without this,
        // the migration:revert assertions leave the DB with zero tables and the next
        // run fails with "relation ... does not exist".
        if (dataSource?.isInitialized) {
            await dataSource.runMigrations({ transaction: 'each' });
            await dataSource.destroy();
        }
    }, 30_000);

    it('migration:run creates all 13 tables', async () => {
        await dataSource.runMigrations({ transaction: 'each' });

        const tables = await listUserTables(dataSource);

        for (const expected of EXPECTED_TABLES) {
            expect(tables).toContain(expected);
        }
    }, 30_000);

    it('tick_aggregates parent partition exists after migration:run', async () => {
        const tables = await listUserTables(dataSource);

        expect(tables).toContain('tick_aggregates');
    });

    it('initial tick_aggregate daily partitions are created (lookahead window)', async () => {
        const partitions = await listTickPartitions(dataSource);

        // The migration creates today + 7 days of partitions (8 total).
        expect(partitions.length).toBeGreaterThanOrEqual(8);

        // All partition names follow the tick_aggregates_pYYYYMMDD convention.
        for (const name of partitions) {
            expect(name).toMatch(/^tick_aggregates_p\d{8}$/);
        }
    });

    it('UNIQUE constraint uq_candles_symbol_interval_open_time exists', async () => {
        const rows = (await dataSource.query(`SELECT conname FROM pg_constraint WHERE conname = 'uq_candles_symbol_interval_open_time'`)) as {
            conname: string;
        }[];

        expect(rows.length).toBe(1);
    });

    it('UNIQUE constraint uq_instruments_symbol exists', async () => {
        const rows = (await dataSource.query(`SELECT conname FROM pg_constraint WHERE conname = 'uq_instruments_symbol'`)) as { conname: string }[];

        expect(rows.length).toBe(1);
    });

    it('strategy_versions seed rows (v0–v3) exist after SeedStrategyVersions migration', async () => {
        const rows = (await dataSource.query(`SELECT version, direction, status FROM strategy_versions WHERE name = 'volatility-vwap' ORDER BY version`)) as {
            version: number;
            direction: string;
            status: string;
        }[];

        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ version: 0, direction: 'mean_reversion', status: 'active' });
        expect(rows[1]).toMatchObject({ version: 1, direction: 'mean_reversion', status: 'draft' });
        expect(rows[2]).toMatchObject({ version: 2, direction: 'momentum', status: 'draft' });
        expect(rows[3]).toMatchObject({ version: 3, direction: 'hybrid', status: 'draft' });
    });

    it('v0 seed row has trade_enabled: false in params', async () => {
        const rows = (await dataSource.query(`SELECT params FROM strategy_versions WHERE name = 'volatility-vwap' AND version = 0`)) as {
            params: Record<string, unknown>;
        }[];

        expect(rows).toHaveLength(1);
        expect(rows[0]!.params['trade_enabled']).toBe(false);
    });

    it('migration:revert drops all 13 tables cleanly', async () => {
        // Revert every applied migration — loop-until-empty future-proofs against new migrations.
        await revertAllMigrations(dataSource);

        const tables = await listUserTables(dataSource);

        for (const table of EXPECTED_TABLES) {
            expect(tables).not.toContain(table);
        }
    }, 30_000);

    it('no tick_aggregate partitions remain after migration:revert', async () => {
        // tick_aggregates was dropped by revert so no child partitions should remain.
        const rows = (await dataSource.query(`SELECT c.relname FROM pg_class c WHERE c.relname LIKE 'tick_aggregates_p%'`)) as { relname: string }[];

        expect(rows).toHaveLength(0);
    });
});
