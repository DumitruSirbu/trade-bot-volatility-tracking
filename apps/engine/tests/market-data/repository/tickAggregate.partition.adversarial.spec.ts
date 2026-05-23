/**
 * M2 Adversarial — Surface 2: tick_aggregates partition boundary.
 *
 * ADR 0002 §tick-aggregate retention + partitioning:
 *   "every insert lands in the partition for its `ts`."
 *
 * This suite requires a live Postgres with migrations already run.
 * Tests target three adversarial cases:
 *   a. Insert at the EXACT partition cutover instant (last nanosecond of one
 *      day / first nanosecond of the next) — Postgres RANGE is [from, to),
 *      so ts = midnight goes to the NEW day's partition.
 *   b. Insert into a partition that does not yet exist (partition-create race
 *      where the service cron has not yet run) — must produce a clear DB error,
 *      not silently succeed in the wrong partition.
 *   c. Insert a row older than the 90-day retention edge — must land in its
 *      partition if one exists, or fail with a clear error if it does not.
 *
 * ADR 0002 §tick-aggregate retention: "partitions older than the retention
 * window are DROPped." This tests that the insert semantics match the intent.
 */

import { DataSource, Repository } from 'typeorm';
import { getTestDataSource } from '../../support/testDataSource';
import { TickAggregateEntity } from '../../../src/market-data/entity/TickAggregateEntity';
import { TickAggregateRepository } from '../../../src/market-data/repository/TickAggregateRepository';
import { parseMoney } from '../../../src/common/utils/money';
import { TICK_AGGREGATE_PARTITION_PREFIX, TICK_AGGREGATE_TABLE } from '../../../src/market-data/const';
import { MS_PER_DAY } from '../../../src/common/const';

const ADV_SYMBOL = 'ADVTICKUSDT';

// Compute UTC midnight boundaries for partition boundary tests.
function utcDayStartMs(nowMs: number): number {
    return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

function toIsoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function partitionName(dayStartMs: number): string {
    return `${TICK_AGGREGATE_PARTITION_PREFIX}${toIsoDay(dayStartMs).replace(/-/g, '')}`;
}

function buildSample(ts: Date): Partial<TickAggregateEntity> {
    return {
        symbol: ADV_SYMBOL,
        ts,
        open: parseMoney('100.00'),
        high: parseMoney('101.00'),
        low: parseMoney('99.00'),
        close: parseMoney('100.50'),
        volume: parseMoney('500.00'),
    };
}

describe('tick_aggregates partition boundary — adversarial (requires Postgres)', () => {
    let dataSource: DataSource;
    let tickAggRepo: TickAggregateRepository;

    beforeAll(async () => {
        dataSource = await getTestDataSource();
        const rawRepo: Repository<TickAggregateEntity> = dataSource.getRepository(TickAggregateEntity);
        tickAggRepo = new TickAggregateRepository(rawRepo);
    }, 30_000);

    afterAll(async () => {
        // Clean up test rows. Partitioned tables require the partition key in DELETE
        // so we use a ranged delete covering all days in the test window.
        await dataSource.query(`DELETE FROM tick_aggregates WHERE symbol = $1`, [ADV_SYMBOL]);
    }, 30_000);

    // -----------------------------------------------------------------------
    // Surface 2a — Exact partition cutover: last ms of day N / first ms of day N+1
    // ADR 0002 §tick-aggregate retention: RANGE is [from, to) so ts = midnight
    // belongs to the NEXT day's partition.
    // -----------------------------------------------------------------------
    describe('partition cutover at UTC midnight seam (ADR 0002 §tick-aggregate partitioning)', () => {
        it('insert at exactly UTC midnight routes to the new-day partition, not the old one', async () => {
            const todayStartMs = utcDayStartMs(Date.now());
            // ts at exactly 00:00:00.000 of today — should land in today's partition.
            const midnightTs = new Date(todayStartMs);
            const todayPartition = partitionName(todayStartMs);

            await tickAggRepo.recordSample(buildSample(midnightTs));

            // Verify the row landed in the correct partition via pg_class membership.
            const rows = (await dataSource.query(
                `SELECT tableoid::regclass::text AS partition FROM tick_aggregates WHERE symbol = $1 AND ts = $2`,
                [ADV_SYMBOL, midnightTs],
            )) as { partition: string }[];

            expect(rows).toHaveLength(1);
            // The partition name must match today's date, not yesterday's.
            expect(rows[0]!.partition).toBe(todayPartition);
        });

        it('insert at 23:59:59.999 of yesterday routes to yesterday\'s partition', async () => {
            const todayStartMs = utcDayStartMs(Date.now());
            const yesterdayStartMs = todayStartMs - MS_PER_DAY;
            const yesterdayLastMs = todayStartMs - 1; // 23:59:59.999
            const yesterdayPartition = partitionName(yesterdayStartMs);

            // Ensure yesterday's partition exists (migration may only create today+ahead).
            await dataSource.query(
                `CREATE TABLE IF NOT EXISTS "${yesterdayPartition}" PARTITION OF "${TICK_AGGREGATE_TABLE}" FOR VALUES FROM ('${toIsoDay(yesterdayStartMs)}') TO ('${toIsoDay(todayStartMs)}')`,
            );

            const ts = new Date(yesterdayLastMs);
            await tickAggRepo.recordSample(buildSample(ts));

            const rows = (await dataSource.query(
                `SELECT tableoid::regclass::text AS partition FROM tick_aggregates WHERE symbol = $1 AND ts = $2`,
                [ADV_SYMBOL, ts],
            )) as { partition: string }[];

            expect(rows).toHaveLength(1);
            // Must be yesterday's partition, not today's.
            expect(rows[0]!.partition).toBe(yesterdayPartition);
        });
    });

    // -----------------------------------------------------------------------
    // Surface 2b — Insert into a day for which no partition exists yet.
    // ADR 0002 §tick-aggregate partitioning: the service cron creates partitions
    // ahead of time; but a backdated insert outside the window must fail loudly,
    // not land silently in a wrong partition.
    // -----------------------------------------------------------------------
    describe('insert into missing partition (ADR 0002 §tick-aggregate partitioning)', () => {
        it('throws a Postgres error when no partition exists for the insert ts', async () => {
            const todayStartMs = utcDayStartMs(Date.now());
            // Pick a day well beyond the lookahead window (20 days ahead) so no
            // partition was pre-created by the migration.
            const futureDayMs = todayStartMs + 20 * MS_PER_DAY;
            const futurePartition = partitionName(futureDayMs);

            // Defensive: drop the partition if it somehow exists from a prior test run.
            await dataSource.query(`DROP TABLE IF EXISTS "${futurePartition}"`);

            const ts = new Date(futureDayMs + 1000); // 00:00:01 on the future day

            // ADR 0002 §tick-aggregate partitioning: an insert with no matching
            // partition MUST fail. If it succeeds, the invariant is violated.
            await expect(tickAggRepo.recordSample(buildSample(ts))).rejects.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // Surface 2c — Insert a backdated row older than the retention edge.
    // ADR 0002 §tick-aggregate retention: "partitions older than the retention
    // window are DROPped." A row whose ts falls into an already-dropped partition
    // must not land anywhere — it must fail at the DB level.
    // -----------------------------------------------------------------------
    describe('insert beyond the 90-day retention edge (ADR 0002 §tick-aggregate retention)', () => {
        it('throws when inserting a ts in a dropped/absent partition beyond retention', async () => {
            // Use a ts 100 days in the past — safely outside the 90-day window.
            const oldDayMs = utcDayStartMs(Date.now()) - 100 * MS_PER_DAY;
            const oldPartition = partitionName(oldDayMs);

            // Ensure the old partition does NOT exist (simulate a retention drop).
            await dataSource.query(`DROP TABLE IF EXISTS "${oldPartition}"`);

            const ts = new Date(oldDayMs + 3600_000); // 01:00:00 on the old day

            // ADR 0002 §tick-aggregate retention: a ts in an absent partition must
            // fail. If it succeeds, the insert silently escaped the retention policy.
            await expect(tickAggRepo.recordSample(buildSample(ts))).rejects.toThrow();
        });
    });
});
