import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { PaperAccountStateMetaEntity } from '../entity/PaperAccountStateMetaEntity';

// Soak-scope metadata repository. The natural key is `soak_start_id` (UNIQUE);
// there is at most one meta row per soak. Inserts at soak start, reads at
// every soak-aware boot to verify the simulator config hash and the
// bootstrap-secret fingerprint still match (ADR 0032 §D3 + §D17).

@Injectable()
export class PaperAccountStateMetaRepository {
    constructor(@InjectRepository(PaperAccountStateMetaEntity) private readonly repository: Repository<PaperAccountStateMetaEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperAccountStateMetaEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperAccountStateMetaEntity);
    }

    async findBySoakStartId(soakStartId: string, manager?: EntityManager): Promise<PaperAccountStateMetaEntity | null> {
        return this.scope(manager).createQueryBuilder('m').where('m.soakStartId = :soakStartId', { soakStartId }).getOne();
    }

    async findLatest(manager?: EntityManager): Promise<PaperAccountStateMetaEntity | null> {
        return this.scope(manager).createQueryBuilder('m').orderBy('m.soakStartTs', 'DESC').limit(1).getOne();
    }

    async insertNew(draft: DeepPartial<PaperAccountStateMetaEntity>, manager?: EntityManager): Promise<PaperAccountStateMetaEntity> {
        const scope = this.scope(manager);
        const entity = scope.create(draft);

        return scope.save(entity);
    }
}
