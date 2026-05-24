import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

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

    // R1.3c — named builder so AccountSnapshotWriter constructs entities through the
    // BaseRepository pattern (no `as AccountSnapshotEntity` cast in the service).
    // BaseRepository.create is `protected` by design; this exposes it under an
    // intention-revealing name.
    buildSnapshot(entityLike: DeepPartial<AccountSnapshotEntity>): AccountSnapshotEntity {
        return this.create(entityLike);
    }
}
