import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { AccountSnapshotEntity } from '../entity';

// Reads/writes periodic account snapshots. No live writer until M6.
@Injectable()
export class AccountSnapshotRepository extends BaseRepository<AccountSnapshotEntity> {
    constructor(@InjectRepository(AccountSnapshotEntity) repository: Repository<AccountSnapshotEntity>) {
        super(repository);
    }

    async findLatest(): Promise<AccountSnapshotEntity | null> {
        // No predicate — the latest snapshot is simply the most recent ts. `find` with
        // take:1 avoids findOne's mandatory `where` (TypeORM 0.3 rejects an empty one).
        const [latest] = await this.repository.find({ order: { ts: 'DESC' }, take: 1 });

        return latest ?? null;
    }
}
