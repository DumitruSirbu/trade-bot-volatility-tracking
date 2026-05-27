import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { PaperAccountStateEntity } from '../entity/PaperAccountStateEntity';

// Thin repository over the open paper-position state. Domain-revealing
// methods only — services NEVER call `find({ where: ... })` against this
// repo directly. The state-mutation methods accept an optional
// `EntityManager` so R2b wave-B services can compose the three-table atomic
// write (`paper_account_state` + `paper_account_state_history` +
// `paper_state_audit`) inside one transaction (ADR 0032 §D16).
//
// Does NOT extend `BaseRepository<T>` — the entity PK is uuid (string), not
// the numeric `id` that BaseRepository's generic constraint requires. The
// pattern mirrors `BootModeHistoryRepository` (also uuid-keyed).

@Injectable()
export class PaperAccountStateRepository {
    constructor(@InjectRepository(PaperAccountStateEntity) private readonly repository: Repository<PaperAccountStateEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperAccountStateEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperAccountStateEntity);
    }

    async findByClientOrderId(clientOrderId: string, manager?: EntityManager): Promise<PaperAccountStateEntity | null> {
        return this.scope(manager).createQueryBuilder('p').where('p.clientOrderId = :clientOrderId', { clientOrderId }).getOne();
    }

    async findOpenBySymbol(symbol: string, manager?: EntityManager): Promise<readonly PaperAccountStateEntity[]> {
        return this.scope(manager).createQueryBuilder('p').where('p.symbol = :symbol', { symbol }).orderBy('p.openedAt', 'ASC').getMany();
    }

    async findAllOpen(manager?: EntityManager): Promise<readonly PaperAccountStateEntity[]> {
        return this.scope(manager).createQueryBuilder('p').orderBy('p.openedAt', 'ASC').getMany();
    }

    async insertNew(draft: DeepPartial<PaperAccountStateEntity>, manager?: EntityManager): Promise<PaperAccountStateEntity> {
        const scope = this.scope(manager);
        const entity = scope.create(draft);

        return scope.save(entity);
    }

    async deleteByClientOrderId(clientOrderId: string, manager?: EntityManager): Promise<void> {
        await this.scope(manager).createQueryBuilder().delete().where('client_order_id = :clientOrderId', { clientOrderId }).execute();
    }
}
