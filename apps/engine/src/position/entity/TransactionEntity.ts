import { PositionSideEnum, TransactionTypeEnum } from '@bot/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';
import { PositionEntity } from './PositionEntity';

// A fill/cashflow against a position (open/add/reduce/close/funding). client_order_id
// is the reconciliation/idempotency match key; exchange_order_id is UNIQUE so a retry
// or restart can never double-record a fill (ADR/idempotency). No live writer in M2.
@Entity({ name: 'transactions', synchronize: false })
@Unique('uq_transactions_exchange_order_id', ['exchangeOrderId'])
@Unique('uq_transactions_client_order_id', ['clientOrderId'])
export class TransactionEntity {
    @PrimaryGeneratedColumn({ name: 'transactions_id' })
    id!: number;

    // Nullable per ADR 0007 §3 + M5 migration 20260524020000: a zero-fill OPEN/ADD audit
    // row has no position to reference yet. The CHECK constraint enforces null is allowed
    // ONLY when qty=0 AND type IN ('open','add'); partial/reduce/close/funding rows still
    // require a position.
    @Column({ name: 'position_id', type: 'integer', nullable: true })
    positionId?: number | null;

    @ManyToOne(() => PositionEntity, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'position_id', referencedColumnName: 'id' })
    position?: PositionEntity | null;

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

    // Funding/realized cashflow aggregate (ADR 0012 §1). Signed quantity; positive on
    // receive (funding income / realized gain), negative on pay (funding charge / loss).
    // Pre-M6 rows backfilled to 0 by migration 20260525010000; live writers ship in W5.
    @Column({ name: 'cashflow', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    cashflow!: MoneyValue;

    @Column({ name: 'client_order_id', type: 'varchar' })
    clientOrderId!: string;

    @Column({ name: 'exchange_order_id', type: 'varchar', nullable: true })
    exchangeOrderId?: string | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
