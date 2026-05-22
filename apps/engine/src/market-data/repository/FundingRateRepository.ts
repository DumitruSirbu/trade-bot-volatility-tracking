import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { FundingRateEntity } from '../entity';

// Persists historical funding events. recordObservation is idempotent on
// UNIQUE(symbol, funding_time) so the same 8-hourly event is never double-recorded.
@Injectable()
export class FundingRateRepository extends BaseRepository<FundingRateEntity> {
    constructor(@InjectRepository(FundingRateEntity) repository: Repository<FundingRateEntity>) {
        super(repository);
    }

    async recordObservation(observation: Partial<FundingRateEntity>): Promise<void> {
        await this.repository.upsert(this.create(observation), {
            conflictPaths: ['symbol', 'fundingTime'],
            skipUpdateIfNoValuesChanged: true,
        });
    }

    async findRange(symbol: string, fromFundingTime: Date, toFundingTime: Date): Promise<FundingRateEntity[]> {
        return this.repository.find({
            where: { symbol, fundingTime: Between(fromFundingTime, toFundingTime) },
            order: { fundingTime: 'ASC' },
        });
    }
}
