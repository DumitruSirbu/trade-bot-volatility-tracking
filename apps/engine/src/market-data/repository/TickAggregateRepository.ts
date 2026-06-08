import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { CANDLE_5M_INTERVAL_MS } from '../const';
import { TickAggregateEntity } from '../entity';

// Persists sub-minute samples into the RANGE-partitioned tick_aggregates table; inserts
// route automatically to the correct daily partition. recordSample is idempotent on
// UNIQUE(symbol, ts). DO NOT add a retention DELETE here — retention is by DROP TABLE of
// whole daily partitions (TickAggregatePartitionService), never row-level delete (§3).
@Injectable()
export class TickAggregateRepository extends BaseRepository<TickAggregateEntity> {
    constructor(@InjectRepository(TickAggregateEntity) repository: Repository<TickAggregateEntity>) {
        super(repository);
    }

    async recordSample(sample: Partial<TickAggregateEntity>): Promise<void> {
        await this.repository.upsert(this.create(sample), {
            conflictPaths: ['symbol', 'ts'],
            skipUpdateIfNoValuesChanged: true,
        });
    }

    async findRange(symbol: string, fromTs: Date, toTs: Date): Promise<TickAggregateEntity[]> {
        return this.repository.find({
            where: { symbol, ts: Between(fromTs, toTs) },
            order: { ts: 'ASC' },
        });
    }

    // Loads the signal-bar tick aggregates over the HALF-OPEN window [barOpen, barOpen + 5m)
    // — `ts >= barOpen AND ts < barOpen + 5m` so the next bar's first tick (at barOpen + 5m)
    // is excluded. Mirrors CandleLoader.loadTicksForBar; deliberately NOT `findRange`/`Between`
    // (inclusive both ends would leak the next bar's open tick). Used by the M26 shadow path to
    // replay the same ticks the M7 backtest sees for a given signal bar.
    async loadTicksForBar(symbol: string, barOpenMs: number): Promise<TickAggregateEntity[]> {
        const fromDate = new Date(barOpenMs);
        const toDate = new Date(barOpenMs + CANDLE_5M_INTERVAL_MS);

        return this.repository
            .createQueryBuilder('tick')
            .where('tick.symbol = :symbol', { symbol })
            .andWhere('tick.ts >= :fromDate', { fromDate })
            .andWhere('tick.ts < :toDate', { toDate })
            .orderBy('tick.ts', 'ASC')
            .getMany();
    }
}
