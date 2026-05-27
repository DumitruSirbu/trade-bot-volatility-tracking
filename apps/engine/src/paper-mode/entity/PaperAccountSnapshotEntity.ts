import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Persistence projection of `paper_account_snapshots` (ADR 0032 §D5 / §D16).
// Sibling of the live `account_snapshots` table. Holds AUDITED equity
// snapshots that feed the drawdown-abort path. Written at coarser cadence
// than per-tick MTM (one per minute + on every position event).
//
// `peak_equity` is denormalised on every row — each snapshot carries the
// running max equity as of its own `taken_at`. Per D16 this is safe because
// the snapshot row itself flows through the three-table atomic-write + audit
// chain (the audit chain ships in R2b wave B alongside services). Drawdown
// abort reads from a derived `unrealised_pnl` (live mark) plus the audited
// `peak_equity` snapshot — tampering either input is detectable.
//
// `mode` is pinned to 'paper' by DB CHECK constraint.
@Entity({ name: 'paper_account_snapshots', synchronize: false })
@Index('idx_paper_account_snapshots_taken_at', ['takenAt'])
export class PaperAccountSnapshotEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_account_snapshot_id' })
    id!: string;

    @Column({ name: 'taken_at', type: 'timestamptz' })
    takenAt!: Date;

    // Base balance with no MTM applied.
    @Column({ name: 'balance', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    balance!: MoneyValue;

    // balance + sum(unrealised_pnl across open positions) + funding_accrued,
    // computed at write time.
    @Column({ name: 'equity', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    equity!: MoneyValue;

    // Cumulative realised PnL since soak start.
    @Column({ name: 'realised_pnl_cumulative', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    realisedPnlCumulative!: MoneyValue;

    // Signed cumulative since soak start.
    @Column({ name: 'funding_accrued_cumulative', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    fundingAccruedCumulative!: MoneyValue;

    // Signed, sum across open positions at write time. Safe to persist per
    // D16 because it is a point-in-time AUDITED reading, not a primary state
    // mutation (the in-memory unrealised PnL used for the abort path is
    // derived on demand, never written to `paper_account_state`).
    @Column({ name: 'unrealised_pnl_total', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    unrealisedPnlTotal!: MoneyValue;

    // Running max equity since soak start (the drawdown denominator per D5).
    @Column({ name: 'peak_equity', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    peakEquity!: MoneyValue;

    @Column({ name: 'open_positions_count', type: 'integer' })
    openPositionsCount!: number;

    @Column({ name: 'mode', type: 'text', default: 'paper' })
    mode!: string;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
