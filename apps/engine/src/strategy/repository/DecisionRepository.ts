import { marketSnapshotSchema } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { NodeEnvEnum } from '../../config/enum';
import { AppConfigService } from '../../config/service';
import { DecisionEntity } from '../entity';

// Persists strategy decisions with their full market_snapshot. The write path is a
// Zod-validated guard (ADR 0002 §4): the snapshot is .safeParse'd at write time. In
// test (NODE_ENV=test) a failed parse THROWS so schema drift surfaces immediately in CI;
// in every other env (development/paper/testnet/live/staging) it logs a WARN and never
// throws, so a malformed snapshot degrades the dataset visibly without dropping a
// gate-approved decision.
@Injectable()
export class DecisionRepository extends BaseRepository<DecisionEntity> {
    private readonly logger = new Logger(DecisionRepository.name);

    constructor(
        @InjectRepository(DecisionEntity) repository: Repository<DecisionEntity>,
        private readonly appConfig: AppConfigService,
    ) {
        super(repository);
    }

    async record(decision: Partial<DecisionEntity>): Promise<DecisionEntity> {
        this.validateMarketSnapshot(decision);

        return this.repository.save(this.create(decision));
    }

    // M9 W4 — cursor-paginated read of recent decisions for `GET /v1/decisions`.
    // Cursor is the (ts, id) tuple of the previous page's tail row, monotonic descending.
    // Optional symbol / flow_type (signal_type) filters are AND'ed in so the dashboard
    // can drill into a single symbol's decision log.
    async findPage(
        cursor: { ts: Date; id: number } | null,
        pageSize: number,
        filters: { symbol?: string; flowType?: string; action?: string },
    ): Promise<DecisionEntity[]> {
        const qb = this.repository.createQueryBuilder('d');

        if (cursor !== null) {
            qb.andWhere('(d.ts, d.decisions_id) < (:cursorTs, :cursorId)', { cursorTs: cursor.ts, cursorId: cursor.id });
        }

        if (filters.symbol !== undefined) {
            qb.andWhere('d.symbol = :symbol', { symbol: filters.symbol });
        }

        if (filters.flowType !== undefined) {
            qb.andWhere('d.signal_type = :signalType', { signalType: filters.flowType });
        }

        if (filters.action !== undefined) {
            qb.andWhere('d.action = :action', { action: filters.action });
        }

        return qb.orderBy('d.ts', 'DESC').addOrderBy('d.decisions_id', 'DESC').take(pageSize).getMany();
    }

    // Write-time guard. In test, a failed parse throws so schema drift fails CI; in every
    // other env it logs a warn naming the offending paths so dataset degradation is
    // observable but the gate-approved decision still writes.
    private validateMarketSnapshot(decision: Partial<DecisionEntity>): void {
        if (decision.marketSnapshot === undefined || decision.marketSnapshot === null) {
            this.logger.warn(`Decision for ${decision.symbol ?? 'unknown'} written without a market_snapshot`);

            return;
        }

        const parsed = marketSnapshotSchema.safeParse(decision.marketSnapshot);

        if (parsed.success) {
            return;
        }

        if (this.appConfig.nodeEnv === NodeEnvEnum.TEST) {
            throw parsed.error;
        }

        const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');

        this.logger.warn(`market_snapshot for ${decision.symbol ?? 'unknown'} failed validation (degraded): ${paths}`);
    }
}
