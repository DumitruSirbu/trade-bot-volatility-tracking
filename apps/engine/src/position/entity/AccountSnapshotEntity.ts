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

    // ADR 0012 §6: unrealized PnL split into the funding-accrual and price-driven
    // components so the dashboard / backtest harness can attribute equity drift to
    // each source independently. Pre-M6 rows backfilled to 0 by migration 20260525010000;
    // the live writer ships in W5/W7.
    @Column({ name: 'unrealized_pnl_funding', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    unrealizedPnlFunding!: MoneyValue;

    @Column({ name: 'unrealized_pnl_price', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    unrealizedPnlPrice!: MoneyValue;
}
