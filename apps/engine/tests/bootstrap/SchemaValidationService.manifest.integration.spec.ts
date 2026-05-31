/**
 * Schema-manifest drift detector (integration — requires Postgres).
 *
 * The purpose of this suite is single and narrow: if the
 * REQUIRED_SCHEMA_MANIFEST in SchemaValidationService ever references a
 * table or column that is NOT in the actually-migrated schema, this test
 * fails loudly — BEFORE the engine boots in production and refuses to
 * start via PHASE 0.
 *
 * This was added as part of the M9 boot-blocker #2 fix where the manifest
 * had drifted to reference `funding_rates.funding_rate` (actual: `rate`),
 * `transactions.symbol` (no such column), and `risk_state.updated_at`
 * (no such column). Each of those would have been caught here.
 *
 * DB: the dedicated test Postgres — start with:
 *   docker compose --profile test up -d --wait postgres-test
 *
 * Isolation: introspects information_schema only; never writes. Uses its
 * own DataSource and assumes migrations have already been applied (the
 * migration-roundtrip suite's afterAll guarantees that for a full
 * `pnpm test` run).
 */

import { DataSource } from 'typeorm';

import { REQUIRED_SCHEMA_MANIFEST } from '../../src/bootstrap/SchemaValidationService';
import { buildDataSourceOptions } from '../../src/database/dataSourceOptions';
import { getTestDbUrl } from '../support/testDataSource';

const TEST_DB_URL = getTestDbUrl();

interface IColumnRow {
    table_name: string;
    column_name: string;
}

async function fetchLiveSchema(dataSource: DataSource): Promise<Map<string, Set<string>>> {
    const rows = (await dataSource.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema()`,
    )) as IColumnRow[];

    const byTable = new Map<string, Set<string>>();

    for (const row of rows) {
        const existing = byTable.get(row.table_name);

        if (existing === undefined) {
            byTable.set(row.table_name, new Set([row.column_name]));
        } else {
            existing.add(row.column_name);
        }
    }

    return byTable;
}

describe('REQUIRED_SCHEMA_MANIFEST drift detector (integration — requires Postgres)', () => {
    let dataSource: DataSource;
    let liveSchema: Map<string, Set<string>>;

    beforeAll(async () => {
        const options = buildDataSourceOptions(TEST_DB_URL);
        dataSource = new DataSource(options);
        await dataSource.initialize();
        // Make sure migrations are applied — the suite is resilient to running
        // in isolation as well as in the full test run.
        await dataSource.runMigrations({ transaction: 'each' });
        liveSchema = await fetchLiveSchema(dataSource);
    }, 60_000);

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.destroy();
        }
    });

    it.each(REQUIRED_SCHEMA_MANIFEST.map((entry) => [entry.table, entry]))(
        'manifest table "%s" exists in live schema with all required columns',
        (_tableName, entry) => {
            const liveColumns = liveSchema.get(entry.table);

            expect(liveColumns).toBeDefined();

            const missing = entry.requiredColumns.filter((column) => !liveColumns!.has(column));

            // Empty array on success gives Jest a readable diff if/when
            // future drift reappears (lists exactly which columns vanished).
            expect(missing).toEqual([]);
        },
    );
});
