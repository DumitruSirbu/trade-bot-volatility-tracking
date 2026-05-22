import { CoinTierEnum } from '@bot/shared';
import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, DecimalValue, MoneyValue } from '../../common/utils';

// Tradable-universe metadata refreshed from the exchange (tick/step/min-notional,
// 24h volume, coin tier). UPSERT-keyed on `symbol` (ADR 0002 §4). coin_tier stores
// the CoinTierEnum string value (varchar), not a smallint (ADR §5).
@Entity({ name: 'instruments', synchronize: false })
@Unique('uq_instruments_symbol', ['symbol'])
export class InstrumentEntity {
    @PrimaryGeneratedColumn({ name: 'instruments_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'base', type: 'varchar' })
    base!: string;

    @Column({ name: 'quote', type: 'varchar' })
    quote!: string;

    @Column({ name: 'status', type: 'varchar' })
    status!: string;

    @Column({ name: 'tick_size', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    tickSize!: DecimalValue;

    @Column({ name: 'step_size', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    stepSize!: DecimalValue;

    // Quote-asset (USDT) notional floor — an actual cash threshold, so it stays MoneyValue.
    @Column({ name: 'min_notional', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    minNotional!: MoneyValue;

    @Column({ name: 'is_tradable', type: 'boolean' })
    isTradable!: boolean;

    @Column({ name: 'volume_24h', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    volume24h!: MoneyValue;

    @Column({ name: 'coin_tier', type: 'varchar' })
    coinTier!: CoinTierEnum;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
