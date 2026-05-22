import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MS_PER_DAY } from '../../common/const';
import { describeError } from '../../common/utils';
import {
    TICK_AGGREGATE_CREATE_PARTITIONS_CRON,
    TICK_AGGREGATE_DROP_PARTITIONS_CRON,
    TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS,
    TICK_AGGREGATE_PARTITION_PREFIX,
    TICK_AGGREGATE_RETENTION_DAYS,
    TICK_AGGREGATE_TABLE,
} from '../const';

// Manages the native daily RANGE partitions of tick_aggregates (ADR 0002 §3). Two
// idempotent daily crons:
//   - create-ahead: CREATE TABLE IF NOT EXISTS today..today+lookahead so an insert never
//     hits a missing partition, even after downtime (self-heals on next run).
//   - retention: DROP TABLE IF EXISTS partitions older than the 90-day window — a whole
//     partition DROP is instant and reclaims space, unlike a row-level DELETE.
// Raw DDL is not expressible through a repository, so this service injects DataSource at
// the genuine infra boundary; it never reads/writes entity rows.
@Injectable()
export class TickAggregatePartitionService implements OnApplicationBootstrap {
    private readonly logger = new Logger(TickAggregatePartitionService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    // Ensure the look-ahead window exists at boot too — the migration seeds an initial
    // window, but a restart days later must not depend on the create cron having run.
    async onApplicationBootstrap(): Promise<void> {
        await this.createAheadPartitions();
    }

    @Cron(TICK_AGGREGATE_CREATE_PARTITIONS_CRON)
    async createAheadPartitions(): Promise<void> {
        const todayStartMs = this.utcDayStartMs(Date.now());

        for (let dayOffset = 0; dayOffset <= TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS; dayOffset += 1) {
            await this.createPartitionForDay(todayStartMs + dayOffset * MS_PER_DAY);
        }
    }

    @Cron(TICK_AGGREGATE_DROP_PARTITIONS_CRON)
    async dropExpiredPartitions(): Promise<void> {
        const cutoffMs = this.utcDayStartMs(Date.now()) - TICK_AGGREGATE_RETENTION_DAYS * MS_PER_DAY;
        const cutoffName = this.partitionName(cutoffMs);
        const expired = await this.findPartitionsOlderThan(cutoffName);

        for (const partition of expired) {
            await this.dropPartition(partition);
        }
    }

    private async createPartitionForDay(dayStartMs: number): Promise<void> {
        const name = this.partitionName(dayStartMs);
        const from = this.toIsoDay(dayStartMs);
        const to = this.toIsoDay(dayStartMs + MS_PER_DAY);

        try {
            await this.dataSource.query(`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${TICK_AGGREGATE_TABLE}" FOR VALUES FROM ('${from}') TO ('${to}')`);
        } catch (cause) {
            // Never crash the scheduler: a concurrent create or transient error is logged
            // and the next run self-heals (the look-ahead window keeps inserts safe).
            this.logger.warn(`Failed to create partition ${name}: ${describeError(cause)}`);
        }
    }

    // The fixed-width tick_aggregates_pYYYYMMDD naming is LOAD-BEARING: it makes the
    // lexical (string) ordering of partition names identical to chronological order, so a
    // plain `relname < cutoffName` comparison correctly selects the older partitions.
    private async findPartitionsOlderThan(cutoffName: string): Promise<string[]> {
        const prefixPattern = `${TICK_AGGREGATE_PARTITION_PREFIX}%`;
        const rows = await this.dataSource.query<{ relname: string }[]>(
            `SELECT c.relname FROM pg_class c WHERE c.relkind = 'r' AND c.relname LIKE $1 AND c.relname < $2 ORDER BY c.relname ASC`,
            [prefixPattern, cutoffName],
        );

        return rows.map((row) => row.relname);
    }

    private async dropPartition(name: string): Promise<void> {
        try {
            await this.dataSource.query(`DROP TABLE IF EXISTS "${name}"`);
            this.logger.log(`Dropped expired tick_aggregates partition ${name}`);
        } catch (cause) {
            this.logger.warn(`Failed to drop partition ${name}: ${describeError(cause)}`);
        }
    }

    private partitionName(dayStartMs: number): string {
        return `${TICK_AGGREGATE_PARTITION_PREFIX}${this.toCompactDay(dayStartMs)}`;
    }

    private utcDayStartMs(nowMs: number): number {
        return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
    }

    private toIsoDay(ms: number): string {
        return new Date(ms).toISOString().slice(0, 10);
    }

    private toCompactDay(ms: number): string {
        return this.toIsoDay(ms).replace(/-/g, '');
    }
}
