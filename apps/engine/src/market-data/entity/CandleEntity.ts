import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// OHLCV bars at 1m and 5m. 5m is the primary strategy candle; 1m backs longer-range
// views/metrics. Idempotent on UNIQUE(symbol, interval, open_time) (ADR 0002 §4).
@Entity({ name: 'candles', synchronize: false })
@Unique('uq_candles_symbol_interval_open_time', ['symbol', 'interval', 'openTime'])
@Index('idx_candles_symbol_interval_open_time', ['symbol', 'interval', 'openTime'])
export class CandleEntity {
    @PrimaryGeneratedColumn({ name: 'candles_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'interval', type: 'varchar' })
    interval!: string;

    @Column({ name: 'open_time', type: 'timestamptz' })
    openTime!: Date;

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
