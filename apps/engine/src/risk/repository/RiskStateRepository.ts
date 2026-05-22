import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { RiskStateEntity } from '../entity';

// Reads/writes per-day risk accounting + halt state. Keyed on `date` (UNIQUE). No live
// writer until M4; M2 ships the query surface.
@Injectable()
export class RiskStateRepository extends BaseRepository<RiskStateEntity> {
    constructor(@InjectRepository(RiskStateEntity) repository: Repository<RiskStateEntity>) {
        super(repository);
    }

    async findByDate(date: string): Promise<RiskStateEntity | null> {
        return this.repository.findOne({ where: { date } });
    }
}
