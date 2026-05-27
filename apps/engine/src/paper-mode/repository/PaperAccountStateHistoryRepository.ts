import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { PaperAccountStateHistoryEntity } from '../entity/PaperAccountStateHistoryEntity';

// Closed-trade ledger repository. Append-only — the only mutation surface is
// `appendClose` (services treat this row as the source-of-truth for closed
// paper trades; the open-state row is deleted in the same transaction per
// D16). The soak evaluator (R4) reads via `findClosedBetween` to compute
// the ≥80-trade floor.

@Injectable()
export class PaperAccountStateHistoryRepository {
    constructor(@InjectRepository(PaperAccountStateHistoryEntity) private readonly repository: Repository<PaperAccountStateHistoryEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperAccountStateHistoryEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperAccountStateHistoryEntity);
    }

    async appendClose(draft: DeepPartial<PaperAccountStateHistoryEntity>, manager?: EntityManager): Promise<PaperAccountStateHistoryEntity> {
        const scope = this.scope(manager);
        const entity = scope.create(draft);

        return scope.save(entity);
    }

    async findClosedBetween(fromTs: Date, toTs: Date, manager?: EntityManager): Promise<readonly PaperAccountStateHistoryEntity[]> {
        return this.scope(manager)
            .createQueryBuilder('h')
            .where('h.closedAt >= :fromTs', { fromTs })
            .andWhere('h.closedAt < :toTs', { toTs })
            .orderBy('h.closedAt', 'ASC')
            .getMany();
    }

    async findByClientOrderId(clientOrderId: string, manager?: EntityManager): Promise<readonly PaperAccountStateHistoryEntity[]> {
        return this.scope(manager).createQueryBuilder('h').where('h.clientOrderId = :clientOrderId', { clientOrderId }).orderBy('h.closedAt', 'ASC').getMany();
    }
}
