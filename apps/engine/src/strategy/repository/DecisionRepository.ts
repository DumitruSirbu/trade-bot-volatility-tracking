import { marketSnapshotSchema } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { DecisionEntity } from '../entity';

// Persists strategy decisions with their full market_snapshot. The write path is a
// Zod-validated guard (ADR 0002 §4): the snapshot is .safeParse'd at write time and a
// missing/invalid field logs a WARN — it NEVER throws, so a schema drift degrades the
// dataset visibly without dropping the decision. M3 wires the real writer; M2 ships the
// schema + repository + this hook only.
@Injectable()
export class DecisionRepository extends BaseRepository<DecisionEntity> {
    private readonly logger = new Logger(DecisionRepository.name);

    constructor(@InjectRepository(DecisionEntity) repository: Repository<DecisionEntity>) {
        super(repository);
    }

    async record(decision: Partial<DecisionEntity>): Promise<DecisionEntity> {
        this.validateMarketSnapshot(decision);

        return this.repository.save(this.create(decision));
    }

    async findByEventId(eventId: string): Promise<DecisionEntity[]> {
        return this.repository.find({ where: { eventId }, order: { strategyVersionId: 'ASC' } });
    }

    // Write-time guard. safeParse never throws; a failed parse logs a warn naming the
    // offending paths so dataset degradation is observable but the decision still writes.
    private validateMarketSnapshot(decision: Partial<DecisionEntity>): void {
        if (decision.marketSnapshot === undefined || decision.marketSnapshot === null) {
            this.logger.warn(`Decision for ${decision.symbol ?? 'unknown'} written without a market_snapshot`);

            return;
        }

        const parsed = marketSnapshotSchema.safeParse(decision.marketSnapshot);

        if (!parsed.success) {
            const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');

            this.logger.warn(`market_snapshot for ${decision.symbol ?? 'unknown'} failed validation (degraded): ${paths}`);
        }
    }
}
