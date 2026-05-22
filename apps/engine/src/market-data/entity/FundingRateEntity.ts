import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, DecimalValue } from '../../common/utils';

// 8-hourly historical funding per symbol so the backtest replays ACTUAL funding, not
// a constant (ADR 0002 §4, no look-ahead). The rate is a ratio, but it is stored as
// NUMERIC(18,10) via the decimal transformer to preserve precision end-to-end (§2).
@Entity({ name: 'funding_rates', synchronize: false })
@Unique('uq_funding_rates_symbol_funding_time', ['symbol', 'fundingTime'])
@Index('idx_funding_rates_symbol_funding_time', ['symbol', 'fundingTime'])
export class FundingRateEntity {
    @PrimaryGeneratedColumn({ name: 'funding_rates_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'funding_time', type: 'timestamptz' })
    fundingTime!: Date;

    @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 10, transformer: decimalColumnTransformer })
    rate!: DecimalValue;
}
