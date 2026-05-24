import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { InstrumentEntity } from '../entity';

// Persists/refreshes tradable-universe metadata. upsertBySymbol is idempotent on the
// UNIQUE(symbol) constraint so a refresh either inserts or updates the single row.
@Injectable()
export class InstrumentRepository extends BaseRepository<InstrumentEntity> {
    constructor(@InjectRepository(InstrumentEntity) repository: Repository<InstrumentEntity>) {
        super(repository);
    }

    async upsertBySymbol(instrument: Partial<InstrumentEntity>): Promise<void> {
        await this.repository.upsert(this.create(instrument), {
            conflictPaths: ['symbol'],
            skipUpdateIfNoValuesChanged: true,
        });
    }

    async findBySymbol(symbol: string): Promise<InstrumentEntity | null> {
        return this.repository.findOne({ where: { symbol } });
    }

    // Returns every currently-tradable instrument. The backtest runner pre-seeds the
    // in-memory BacktestBook with these so the gate's instrument port has a complete
    // snapshot for the whole replay window without per-symbol DB lookups.
    async findAllTradable(): Promise<InstrumentEntity[]> {
        return this.repository.find({ where: { isTradable: true } });
    }
}
