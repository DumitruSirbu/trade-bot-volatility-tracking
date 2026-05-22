import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { TransactionEntity } from '../entity';

// Reads/writes fills/cashflows. exchange_order_id is UNIQUE so a retried fill is caught
// by the constraint (idempotency). No live writer until M5–M6.
@Injectable()
export class TransactionRepository extends BaseRepository<TransactionEntity> {
    constructor(@InjectRepository(TransactionEntity) repository: Repository<TransactionEntity>) {
        super(repository);
    }

    async findByPosition(positionId: number): Promise<TransactionEntity[]> {
        return this.repository.find({ where: { positionId }, order: { createdAt: 'ASC' } });
    }

    async findByExchangeOrderId(exchangeOrderId: string): Promise<TransactionEntity | null> {
        return this.repository.findOne({ where: { exchangeOrderId } });
    }
}
