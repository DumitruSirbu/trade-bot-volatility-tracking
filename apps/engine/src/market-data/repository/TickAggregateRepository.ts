import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
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
}
