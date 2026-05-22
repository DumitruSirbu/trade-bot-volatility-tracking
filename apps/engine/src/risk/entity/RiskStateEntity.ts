import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Per-day risk accounting + halt state. Keyed UNIQUE on `date` (one row per UTC day)
// so the daily loss limit, exposure, trade count, and global halt are read/updated
// idempotently. No live writer until M4 (schema + repository only in M2).
@Entity({ name: 'risk_state', synchronize: false })
@Unique('uq_risk_state_date', ['date'])
export class RiskStateEntity {
    @PrimaryGeneratedColumn({ name: 'risk_state_id' })
    id!: number;

    @Column({ name: 'date', type: 'date' })
    date!: string;

    @Column({ name: 'realized_pnl_day', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    realizedPnlDay!: MoneyValue;

    @Column({ name: 'open_exposure', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    openExposure!: MoneyValue;

    @Column({ name: 'trades_count', type: 'integer' })
    tradesCount!: number;

    @Column({ name: 'is_halted', type: 'boolean' })
    isHalted!: boolean;

    @Column({ name: 'halt_reason', type: 'varchar', nullable: true })
    haltReason?: string | null;
}
