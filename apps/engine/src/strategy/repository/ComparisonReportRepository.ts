import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { ComparisonReportEntity } from '../entity';

// Anchor-row repository for M8 walk-forward / same-event comparison runs (ADR 0017 §2.6).
// Promotion writes link strategy_versions.promotion_report_id → ComparisonReportEntity.id
// so the audit trail on a promoted row can resolve back to the run that justified it.
//
// Typed access to the jsonb fields (split_policy, folds, summary) is deferred to the
// service layer in W4+ — at the repository boundary they are unknown-shaped to avoid a
// premature packages/shared/ contract change.
@Injectable()
export class ComparisonReportRepository extends BaseRepository<ComparisonReportEntity> {
    constructor(@InjectRepository(ComparisonReportEntity) repository: Repository<ComparisonReportEntity>) {
        super(repository);
    }

    async createReport(payload: DeepPartial<ComparisonReportEntity>): Promise<ComparisonReportEntity> {
        const entity = this.create(payload);

        return this.repository.save(entity);
    }

    async findMostRecent(limit: number): Promise<ComparisonReportEntity[]> {
        return this.repository.find({ order: { createdAt: 'DESC' }, take: limit });
    }
}
