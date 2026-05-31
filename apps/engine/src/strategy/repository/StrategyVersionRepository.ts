import { StrategyStatusEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { StrategyVersionEntity } from '../entity';

// Reads the seeded v0–v3 strategy definitions. findActive returns the versions currently
// eligible to run (status = active); findByNameAndVersion backs idempotent seeding;
// findActiveShadows returns the SHADOW-status versions the M11a W2 shadow
// orchestrator routes over the live event tape (ADR 0029 §2.2).
@Injectable()
export class StrategyVersionRepository extends BaseRepository<StrategyVersionEntity> {
    constructor(@InjectRepository(StrategyVersionEntity) repository: Repository<StrategyVersionEntity>) {
        super(repository);
    }

    async findActive(): Promise<StrategyVersionEntity[]> {
        return this.repository.find({ where: { status: StrategyStatusEnum.ACTIVE } });
    }

    async findByNameAndVersion(name: string, version: number): Promise<StrategyVersionEntity | null> {
        return this.repository.findOne({ where: { name, version } });
    }

    async findById(id: number): Promise<StrategyVersionEntity | null> {
        return this.repository.findOne({ where: { id } });
    }

    // M11a W2 (ADR 0029 §2.2): return every strategy_versions row explicitly
    // registered as a SHADOW — the set of non-active versions the orchestrator
    // evaluates over the same event tape v1 sees. Filtering on `status =
    // SHADOW` (rather than "not archived") prevents DRAFT rows and any second
    // ACTIVE row from inadvertently receiving shadow calls. Ordered by version
    // ASC so the orchestrator's seeded `ledgers` map is deterministic.
    //
    // The `_excludeVersionId` parameter is retained for API stability but no
    // longer used as a filter — the status discriminator is sufficient to
    // exclude the active version.
    async findActiveShadows(_excludeVersionId: number): Promise<StrategyVersionEntity[]> {
        return this.repository.find({
            where: { status: StrategyStatusEnum.SHADOW },
            order: { version: 'ASC' },
        });
    }
}
