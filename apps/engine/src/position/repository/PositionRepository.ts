import { PositionStatusEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { PositionEntity } from '../entity';

// Reads/writes authoritative position state. No live writer until M3–M6; M2 ships the
// query surface later milestones need.
@Injectable()
export class PositionRepository extends BaseRepository<PositionEntity> {
    constructor(@InjectRepository(PositionEntity) repository: Repository<PositionEntity>) {
        super(repository);
    }

    async findOpen(): Promise<PositionEntity[]> {
        return this.repository.find({ where: { status: PositionStatusEnum.OPEN } });
    }

    async findOpenBySymbol(symbol: string): Promise<PositionEntity[]> {
        return this.repository.find({ where: { symbol, status: PositionStatusEnum.OPEN } });
    }
}
