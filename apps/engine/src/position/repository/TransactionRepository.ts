import { TransactionTypeEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryFailedError, Repository } from 'typeorm';

import { POSTGRES_UNIQUE_VIOLATION_SQLSTATE } from '../../common/const';
import { BaseRepository } from '../../common/repository/BaseRepository';
import { TransactionEntity } from '../entity';

// Reads/writes fills/cashflows. exchange_order_id + client_order_id are both UNIQUE so a
// retried fill or a duplicate replay is caught by the constraint (ADR 0006 §5 idempotency).
@Injectable()
export class TransactionRepository extends BaseRepository<TransactionEntity> {
    private readonly logger = new Logger(TransactionRepository.name);

    constructor(@InjectRepository(TransactionEntity) repository: Repository<TransactionEntity>) {
        super(repository);
    }

    async findByPosition(positionId: number): Promise<TransactionEntity[]> {
        return this.repository.find({ where: { positionId }, order: { createdAt: 'ASC' } });
    }

    async findByExchangeOrderId(exchangeOrderId: string): Promise<TransactionEntity | null> {
        return this.repository.findOne({ where: { exchangeOrderId } });
    }

    async findByClientOrderId(clientOrderId: string): Promise<TransactionEntity | null> {
        return this.repository.findOne({ where: { clientOrderId } });
    }

    // M6 R1.2.4 (ADR 0010 §1f). The most recent transactions row for a position,
    // ordered by `createdAt DESC` — case-(f) UNKNOWN_INTENT_OUTCOME re-queries the
    // exchange by this row's `clientOrderId`. Returns null when no transactions
    // exist for the position (defensive — a non-closed row with zero transactions
    // is pathological but possible at the pending_open boundary; case-(f) skips
    // with a warn log).
    async findLatestByPositionId(positionId: number): Promise<TransactionEntity | null> {
        return this.repository.findOne({
            where: { positionId },
            order: { createdAt: 'DESC' },
        });
    }

    // M6 W5 (ADR 0012 §2). Returns the most recent funding row for a position so
    // ReconciliationService can floor its `fetchFundingHistory(sinceMs)` call at
    // the last-known settlement time + 1ms — every poll therefore only pulls rows
    // the bot has not seen yet. Returns null when the position has no funding rows
    // yet (first poll after open: caller uses the position's `openedAt` as the floor).
    async findLatestFundingByPosition(positionId: number): Promise<TransactionEntity | null> {
        return this.repository.findOne({
            where: { positionId, type: TransactionTypeEnum.FUNDING },
            order: { createdAt: 'DESC' },
        });
    }

    // M5 idempotent insert: a duplicate (clientOrderId or exchangeOrderId) raises the unique-
    // constraint violation, which we catch and treat as a no-op (the row already exists from a
    // prior retry / replay). Returns the existing row in that case so the caller still has
    // something to attach SL/TP / positions updates to.
    async recordTerminal(entityLike: DeepPartial<TransactionEntity>): Promise<TransactionEntity> {
        const entity = this.create(entityLike);

        try {
            return await this.repository.save(entity);
        } catch (cause) {
            if (this.isUniqueViolation(cause)) {
                this.logger.warn(`duplicate transaction for clientOrderId=${entityLike.clientOrderId ?? '?'} — idempotent no-op`);
                const existing = await this.findByClientOrderId(String(entityLike.clientOrderId));

                if (existing !== null) {
                    return existing;
                }
            }

            throw cause;
        }
    }

    // Postgres SQLSTATE 23505 (`unique_violation`) is the structured signal driverError carries
    // for the unique-constraint catch path. Substring-matching the message text drifts across
    // Postgres locale / TypeORM wrapper versions, so we test the SQLSTATE code instead — the
    // same anti-pattern the reject taxonomy already eliminated.
    private isUniqueViolation(cause: unknown): boolean {
        if (!(cause instanceof QueryFailedError)) {
            return false;
        }

        const driverError = (cause as QueryFailedError & { driverError?: { code?: string } }).driverError;

        return driverError?.code === POSTGRES_UNIQUE_VIOLATION_SQLSTATE;
    }
}
