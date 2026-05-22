import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { OpenInterestEntity } from '../entity';

// Persists OI samples. recordSample is idempotent on UNIQUE(symbol, ts).
@Injectable()
export class OpenInterestRepository extends BaseRepository<OpenInterestEntity> {
    constructor(@InjectRepository(OpenInterestEntity) repository: Repository<OpenInterestEntity>) {
        super(repository);
    }

    async recordSample(sample: Partial<OpenInterestEntity>): Promise<void> {
        await this.repository.upsert(this.create(sample), {
            conflictPaths: ['symbol', 'ts'],
            skipUpdateIfNoValuesChanged: true,
        });
    }

    async findRange(symbol: string, fromTs: Date, toTs: Date): Promise<OpenInterestEntity[]> {
        return this.repository.find({
            where: { symbol, ts: Between(fromTs, toTs) },
            order: { ts: 'ASC' },
        });
    }
}
