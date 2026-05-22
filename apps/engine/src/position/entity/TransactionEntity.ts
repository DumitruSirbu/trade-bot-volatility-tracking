import { PositionSideEnum, TransactionTypeEnum } from '@bot/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';
import { PositionEntity } from './PositionEntity';

// A fill/cashflow against a position (open/add/reduce/close/funding). client_order_id
// is the reconciliation/idempotency match key; exchange_order_id is UNIQUE so a retry
// or restart can never double-record a fill (ADR/idempotency). No live writer in M2.
@Entity({ name: 'transactions', synchronize: false })
@Unique('uq_transactions_exchange_order_id', ['exchangeOrderId'])
export class TransactionEntity {
    @PrimaryGeneratedColumn({ name: 'transactions_id' })
    id!: number;

    @Column({ name: 'position_id', type: 'integer' })
    positionId!: number;

    @ManyToOne(() => PositionEntity, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'position_id', referencedColumnName: 'id' })
    position!: PositionEntity;

    @Column({ name: 'type', type: 'varchar' })
    type!: TransactionTypeEnum;

    @Column({ name: 'side', type: 'varchar' })
    side!: PositionSideEnum;

    @Column({ name: 'price', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    price!: MoneyValue;

    @Column({ name: 'qty', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    qty!: MoneyValue;

    @Column({ name: 'fee', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    fee!: MoneyValue;

    @Column({ name: 'client_order_id', type: 'varchar' })
    clientOrderId!: string;

    @Column({ name: 'exchange_order_id', type: 'varchar', nullable: true })
    exchangeOrderId?: string | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
