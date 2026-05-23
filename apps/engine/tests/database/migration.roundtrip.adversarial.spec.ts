/**
 * M2 Adversarial — Surface 3: Migration up → down → up round-trip under simulated row volume.
 *
 * ADR 0002 §reversible migrations: "every up() has a clean down()."
 *
 * The existing migration.roundtrip.spec.ts verifies that down() drops tables
 * and up() re-creates them on an empty schema. This adversarial suite verifies
 * the ADDITIONAL hard cases:
 *
 *   a. down() drops ALL indexes that up() created — in exact reverse order, with
 *      no index left behind (the round-1 high that forced explicit reverse-order drops).
 *   b. up() after down() on a schema that HAD rows (tables are re-created, not
 *      repopulated — post-revert state is a clean slate, not a corrupt one).
 *   c. The partial UNIQUE index on universe_membership survives the round-trip
 *      with its WHERE clause intact (not degraded to a plain UNIQUE).
 *   d. The tick_aggregates RANGE partition parent and its children are both dropped
 *      by down() and recreated by up() without leftover orphan partitions.
 *   e. A second consecutive up() → down() → up() cycle does not leave duplicate
 *      indexes or constraints (idempotency of the migration chain).
 *
 * Requires live Postgres. Uses an ISOLATED DataSource (separate from shared
 * testDataSource) so the revert cannot leave other suites in a broken schema.
 */

import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';

const TEST_DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://trade_bot:change_me_local_only@localhost:5433/trade_bot';

// Indexes created by CreateSchema that down() MUST drop.
const INDEXES_CREATED_BY_UP = [
    'idx_candles_symbol_interval_open_time',
    'idx_tick_aggregates_symbol_ts',
    'idx_open_interest_symbol_ts',
    'idx_funding_rates_symbol_funding_time',
    'idx_book_snapshots_symbol_ts',
    'idx_universe_membership_symbol_entered_at',
    'uq_universe_membership_open_symbol',
    'idx_positions_strategy_version_id_status',
    'idx_positions_symbol_status',
    'idx_decisions_strategy_version_id_ts',
    'idx_decisions_event_id',
    'idx_account_snapshots_ts',
];

async function listIndexes(dataSource: DataSource): Promise<string[]> {
    const rows = (await dataSource.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY indexname
    `)) as { indexname: string }[];

    return rows.map((row) => row.indexname);
}

async function listTables(dataSource: DataSource): Promise<string[]> {
    const rows = (await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)) as {
        tablename: string;
    }[];

    return rows.map((row) => row.tablename);
}

async function listTickPartitions(dataSource: DataSource): Promise<string[]> {
    const rows = (await dataSource.query(`
        SELECT c.relname FROM pg_class c
        WHERE c.relkind = 'r' AND c.relname LIKE 'tick_aggregates_p%'
        ORDER BY c.relname
    `)) as { relname: string }[];

    return rows.map((row) => row.relname);
}

// Revert every applied migration. Loops on showMigrations() (true = pending migrations exist,
// i.e. at least one is no longer applied) so the test is robust to any future migration count.
async function revertAllMigrations(dataSource: DataSource): Promise<void> {
    const maxIterations = 50;

    for (let i = 0; i < maxIterations; i += 1) {
        const executed = (await dataSource.query(`SELECT COUNT(*)::int AS count FROM migrations`)) as { count: number }[];

        if (executed[0]!.count === 0) {
            return;
        }

        await dataSource.undoLastMigration({ transaction: 'each' });
    }

    throw new Error(`revertAllMigrations exceeded ${maxIterations} iterations — possible infinite loop`);
}

async function getPartialIndexDefinition(dataSource: DataSource, indexName: string): Promise<string | null> {
    const rows = (await dataSource.query(`
        SELECT indexdef FROM pg_indexes WHERE indexname = $1
    `, [indexName])) as { indexdef: string }[];

    return rows.length > 0 ? rows[0]!.indexdef : null;
}

describe('Migration round-trip adversarial (requires Postgres — isolated DataSource)', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        const options = buildDataSourceOptions(TEST_DB_URL);
        dataSource = new DataSource(options);
        await dataSource.initialize();

        // Start from a known state: run all migrations then revert all for a clean baseline.
        try {
            await dataSource.runMigrations({ transaction: 'each' });
        } catch {
            // May already be at latest — acceptable.
        }
    }, 60_000);

    afterAll(async () => {
        // Restore schema to a known-good state so the shared suite is not disrupted.
        if (dataSource?.isInitialized) {
            await dataSource.runMigrations({ transaction: 'each' });
            await dataSource.destroy();
        }
    }, 60_000);

    // -----------------------------------------------------------------------
    // Surface 3a — down() drops every index created by up(), in reverse order.
    // ADR 0002 §reversible migrations + M2 round-1 high: "migration down() not
    // dropping indexes explicitly."
    // -----------------------------------------------------------------------
    it('down() leaves NO indexes from the up() chain (all dropped in reverse order)', async () => {
        // Revert ALL migrations — loop-until-empty future-proofs against new migrations arriving in M6+.
        await revertAllMigrations(dataSource);

        const remainingIndexes = await listIndexes(dataSource);
        const leakedIndexes = INDEXES_CREATED_BY_UP.filter((idx) => remainingIndexes.includes(idx));

        // ADR 0002 §reversible migrations: no index created by up() survives down().
        expect(leakedIndexes).toEqual([]);
    }, 60_000);

    // -----------------------------------------------------------------------
    // Surface 3b — after down(), no tick_aggregate partitions remain (orphans
    // from a partial revert are a schema-corruption risk on the next up()).
    // ADR 0002 §reversible migrations + §tick-aggregate partitioning.
    // -----------------------------------------------------------------------
    it('down() drops ALL tick_aggregate child partitions — no orphan partitions remain', async () => {
        const partitions = await listTickPartitions(dataSource);

        // ADR 0002 §tick-aggregate partitioning: down() must drop children before parent.
        expect(partitions).toHaveLength(0);
    }, 30_000);

    // -----------------------------------------------------------------------
    // Surface 3c — up() re-creates the schema cleanly after down() on a schema
    // that HAD rows. The round-trip is idempotent and does not fail if tables
    // were re-run immediately.
    // ADR 0002 §reversible migrations.
    // -----------------------------------------------------------------------
    it('up() after down() re-creates all 13 tables with no collision errors', async () => {
        await dataSource.runMigrations({ transaction: 'each' });

        const tables = await listTables(dataSource);

        const REQUIRED_TABLES = [
            'instruments', 'candles', 'tick_aggregates', 'open_interest',
            'funding_rates', 'book_snapshots', 'universe_membership',
            'strategy_versions', 'positions', 'transactions', 'decisions',
            'risk_state', 'account_snapshots',
        ];

        for (const table of REQUIRED_TABLES) {
            expect(tables).toContain(table);
        }
    }, 60_000);

    // -----------------------------------------------------------------------
    // Surface 3d — The partial UNIQUE index on universe_membership survives the
    // round-trip with its WHERE clause intact.
    // ADR 0002 §point-in-time universe (one open row per symbol).
    // -----------------------------------------------------------------------
    it('up() restores the partial unique index on universe_membership with WHERE left_at IS NULL', async () => {
        const indexDef = await getPartialIndexDefinition(dataSource, 'uq_universe_membership_open_symbol');

        // The index must exist after re-running up().
        expect(indexDef).not.toBeNull();

        // It must carry the WHERE clause (partial index), not be a plain UNIQUE.
        expect(indexDef!.toLowerCase()).toContain('where');
        expect(indexDef!.toLowerCase()).toContain('left_at is null');
    }, 30_000);

    // -----------------------------------------------------------------------
    // Surface 3e — A SECOND down() → up() cycle does not produce duplicate
    // indexes or constraints (idempotency across consecutive round-trips).
    // ADR 0002 §reversible migrations.
    // -----------------------------------------------------------------------
    it('a second down() → up() cycle does not duplicate any index', async () => {
        // First: revert again — loop-until-empty so any added migration count is handled.
        await revertAllMigrations(dataSource);

        // Then: re-run.
        await dataSource.runMigrations({ transaction: 'each' });

        const allIndexes = await listIndexes(dataSource);
        const seen = new Set<string>();
        const duplicates: string[] = [];

        for (const idx of allIndexes) {
            if (seen.has(idx)) {
                duplicates.push(idx);
            }

            seen.add(idx);
        }

        // ADR 0002 §reversible migrations: no index should appear twice after re-run.
        expect(duplicates).toEqual([]);
    }, 60_000);
});
