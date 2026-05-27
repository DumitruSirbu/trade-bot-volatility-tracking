import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { PaperAccountSnapshotEntity } from '../entity/PaperAccountSnapshotEntity';

// Audited equity-snapshot repository (sibling of `AccountSnapshotRepository`).
// `findLatest` is the primary read path for the drawdown-abort evaluator —
// the most recent `peak_equity` is the denominator. Append-only at the
// service layer.

@Injectable()
export class PaperAccountSnapshotRepository {
    constructor(@InjectRepository(PaperAccountSnapshotEntity) private readonly repository: Repository<PaperAccountSnapshotEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperAccountSnapshotEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperAccountSnapshotEntity);
    }

    async insertNew(draft: DeepPartial<PaperAccountSnapshotEntity>, manager?: EntityManager): Promise<PaperAccountSnapshotEntity> {
        const scope = this.scope(manager);
        const entity = scope.create(draft);

        return scope.save(entity);
    }

    async findLatest(manager?: EntityManager): Promise<PaperAccountSnapshotEntity | null> {
        return this.scope(manager).createQueryBuilder('s').orderBy('s.takenAt', 'DESC').limit(1).getOne();
    }

    async findTakenBetween(fromTs: Date, toTs: Date, manager?: EntityManager): Promise<readonly PaperAccountSnapshotEntity[]> {
        return this.scope(manager)
            .createQueryBuilder('s')
            .where('s.takenAt >= :fromTs', { fromTs })
            .andWhere('s.takenAt < :toTs', { toTs })
            .orderBy('s.takenAt', 'ASC')
            .getMany();
    }
}
