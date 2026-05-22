import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Open-Interest time-series (polled per universe symbol). Point-in-time for live use
// and backtest replay (M7). Idempotent on UNIQUE(symbol, ts) (ADR 0002 §4).
@Entity({ name: 'open_interest', synchronize: false })
@Unique('uq_open_interest_symbol_ts', ['symbol', 'ts'])
@Index('idx_open_interest_symbol_ts', ['symbol', 'ts'])
export class OpenInterestEntity {
    @PrimaryGeneratedColumn({ name: 'open_interest_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'value', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    value!: MoneyValue;
}
