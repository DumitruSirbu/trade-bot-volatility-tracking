import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Fixed 1-second OHLCV samples used by the backtest to reconstruct intra-candle /
// intra-second VWAP/indicator state and known spikes. The physical table is RANGE-
// partitioned by `ts` (daily), so Postgres requires the partition key in every unique
// constraint and the PK → composite PRIMARY KEY (tick_aggregates_id, ts) +
// UNIQUE(symbol, ts) (ADR §3). `ts` is the bucket-START. The serial `id` stays for
// BaseRepository compatibility.
@Entity({ name: 'tick_aggregates', synchronize: false })
@Unique('uq_tick_aggregates_symbol_ts', ['symbol', 'ts'])
export class TickAggregateEntity {
    @PrimaryGeneratedColumn({ name: 'tick_aggregates_id' })
    id!: number;

    @PrimaryColumn({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'open', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    open!: MoneyValue;

    @Column({ name: 'high', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    high!: MoneyValue;

    @Column({ name: 'low', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    low!: MoneyValue;

    @Column({ name: 'close', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    close!: MoneyValue;

    @Column({ name: 'volume', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    volume!: MoneyValue;
}
