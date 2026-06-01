/**
 * TickAggregatePartitionService — paired integration test for the
 * partition-rollover service (Pre-M8 deferred item, M8 W0).
 *
 * Original failure mode: a fresh Postgres volume rebuild leaves only the
 * baseline migration's seeded partition window, and an insert outside that
 * window errors with "no partition of relation tick_aggregates found for
 * row". The service must:
 *   1. Boot-time create-ahead so a fresh volume + late restart self-heals.
 *   2. Idempotent — re-running creates no duplicates and does not throw.
 *   3. Creates missing partitions when they do not yet exist.
 *
 * Requires a live Postgres (the dedicated port-6900 test container) with
 * migrations applied — same harness as the adversarial partition spec.
 */

import { DataSource } from 'typeorm';

import { TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS, TICK_AGGREGATE_PARTITION_PREFIX, TICK_AGGREGATE_TABLE } from '../../../src/market-data/const';
import { TickAggregatePartitionService } from '../../../src/market-data/service/TickAggregatePartitionService';
import { MS_PER_DAY } from '../../../src/common/const';
import { getTestDataSource } from '../../support/testDataSource';

function utcDayStartMs(nowMs: number): number {
    return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

function toCompactDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function partitionName(dayStartMs: number): string {
    return `${TICK_AGGREGATE_PARTITION_PREFIX}${toCompactDay(dayStartMs)}`;
}

async function partitionExists(dataSource: DataSource, name: string): Promise<boolean> {
    const rows = (await dataSource.query(`SELECT 1 AS found FROM pg_class WHERE relkind = 'r' AND relname = $1 LIMIT 1`, [name])) as { found: number }[];

    return rows.length > 0;
}

describe('TickAggregatePartitionService.createAheadPartitions (requires Postgres)', () => {
    let dataSource: DataSource;
    let service: TickAggregatePartitionService;

    beforeAll(async () => {
        dataSource = await getTestDataSource();
        service = new TickAggregatePartitionService(dataSource);
    }, 30_000);

    // Probe partitions that fall inside the look-ahead window. Cleaning them up
    // between runs would race the boot-time pre-creation in the rest of the suite,
    // and DROP IF EXISTS keeps re-runs idempotent regardless.
    it('creates the today partition + the full look-ahead window', async () => {
        const todayStartMs = utcDayStartMs(Date.now());

        await service.createAheadPartitions();

        for (let dayOffset = 0; dayOffset <= TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS; dayOffset += 1) {
            const name = partitionName(todayStartMs + dayOffset * MS_PER_DAY);
            expect(await partitionExists(dataSource, name)).toBe(true);
        }
    }, 30_000);

    it('is a no-op when every partition in the window already exists', async () => {
        // First call creates; second call must succeed and leave the set unchanged.
        await service.createAheadPartitions();
        const before = await listPartitionsInWindow(dataSource);

        await service.createAheadPartitions();
        const after = await listPartitionsInWindow(dataSource);

        expect(after).toEqual(before);
    }, 30_000);

    it('creates the missing partition when one in the window has been dropped', async () => {
        const todayStartMs = utcDayStartMs(Date.now());
        // Target the LAST day of the look-ahead window so a transient drop does
        // not race a foreground insert during the test.
        const targetMs = todayStartMs + TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS * MS_PER_DAY;
        const target = partitionName(targetMs);

        // DETACH + DROP so we can recreate without a CONCURRENTLY constraint.
        await dataSource.query(`ALTER TABLE "${TICK_AGGREGATE_TABLE}" DETACH PARTITION "${target}"`).catch(() => {
            // Already detached or not yet a partition — DROP IF EXISTS still works below.
        });
        await dataSource.query(`DROP TABLE IF EXISTS "${target}"`);
        expect(await partitionExists(dataSource, target)).toBe(false);

        await service.createAheadPartitions();

        expect(await partitionExists(dataSource, target)).toBe(true);
    }, 30_000);
});

async function listPartitionsInWindow(dataSource: DataSource): Promise<string[]> {
    const todayStartMs = utcDayStartMs(Date.now());
    const startName = partitionName(todayStartMs);
    const endName = partitionName(todayStartMs + TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS * MS_PER_DAY);
    const rows = (await dataSource.query(
        `SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE $1 AND relname >= $2 AND relname <= $3 ORDER BY relname ASC`,
        [`${TICK_AGGREGATE_PARTITION_PREFIX}%`, startName, endName],
    )) as { relname: string }[];

    return rows.map((row) => row.relname);
}
