import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { BookSnapshotEntity } from '../entity';

// Persists book depth/spread snapshots taken around decisions/open positions. M3 lines
// these up with the triggering decision by (symbol, ts).
@Injectable()
export class BookSnapshotRepository extends BaseRepository<BookSnapshotEntity> {
    constructor(@InjectRepository(BookSnapshotEntity) repository: Repository<BookSnapshotEntity>) {
        super(repository);
    }

    async record(snapshot: Partial<BookSnapshotEntity>): Promise<BookSnapshotEntity> {
        return this.repository.save(this.create(snapshot));
    }

    async findRange(symbol: string, fromTs: Date, toTs: Date): Promise<BookSnapshotEntity[]> {
        return this.repository.find({
            where: { symbol, ts: Between(fromTs, toTs) },
            order: { ts: 'ASC' },
        });
    }
}
