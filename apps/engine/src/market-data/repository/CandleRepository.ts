import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { CandleEntity } from '../entity';

// Persists closed OHLCV bars. upsertClosed is idempotent on the
// UNIQUE(symbol, interval, open_time) constraint — a re-emitted closed bar updates in
// place rather than duplicating, so the persistence listener can swallow retries.
@Injectable()
export class CandleRepository extends BaseRepository<CandleEntity> {
    constructor(@InjectRepository(CandleEntity) repository: Repository<CandleEntity>) {
        super(repository);
    }

    async upsertClosed(candle: Partial<CandleEntity>): Promise<void> {
        await this.repository.upsert(this.create(candle), {
            conflictPaths: ['symbol', 'interval', 'openTime'],
            skipUpdateIfNoValuesChanged: true,
        });
    }

    async findRange(symbol: string, interval: string, fromOpenTime: Date, toOpenTime: Date): Promise<CandleEntity[]> {
        return this.repository.find({
            where: { symbol, interval, openTime: Between(fromOpenTime, toOpenTime) },
            order: { openTime: 'ASC' },
        });
    }
}
