import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Top-of-book spread + depth, persisted ONLY around decisions/open positions (M1
// compromise, ADR 0002 §4). Keyed (symbol, ts) and lined up with the triggering
// decision in M3.
@Entity({ name: 'book_snapshots', synchronize: false })
@Index('idx_book_snapshots_symbol_ts', ['symbol', 'ts'])
export class BookSnapshotEntity {
    @PrimaryGeneratedColumn({ name: 'book_snapshots_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'spread', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    spread?: MoneyValue | null;

    @Column({ name: 'depth_10bps', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    depth10bps?: MoneyValue | null;

    @Column({ name: 'depth_50bps', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    depth50bps?: MoneyValue | null;
}
