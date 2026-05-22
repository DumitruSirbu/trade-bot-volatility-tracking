import { StrategyStatusEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { StrategyVersionEntity } from '../entity';

// Reads the seeded v0–v3 strategy definitions. findActive returns the versions currently
// eligible to run (status = active); findByNameAndVersion backs idempotent seeding.
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
}
