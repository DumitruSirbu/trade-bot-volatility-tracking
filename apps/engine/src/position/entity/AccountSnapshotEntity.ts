import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Periodic account-level balance/equity/unrealized-PnL snapshot for accounting and
// drawdown tracking. No live writer in M2 (schema + repository only).
@Entity({ name: 'account_snapshots', synchronize: false })
@Index('idx_account_snapshots_ts', ['ts'])
export class AccountSnapshotEntity {
    @PrimaryGeneratedColumn({ name: 'account_snapshots_id' })
    id!: number;

    @Column({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'balance', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    balance!: MoneyValue;

    @Column({ name: 'equity', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    equity!: MoneyValue;

    @Column({ name: 'unrealized_pnl', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    unrealizedPnl!: MoneyValue;
}
