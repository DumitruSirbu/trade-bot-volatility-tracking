import { PositionSideEnum } from '@bot/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Persistence projection of `paper_account_state_history` (ADR 0032 §D16) —
// the closed-trade ledger. Every PAPER position close appends a row; the
// live `paper_account_state` row is deleted on close so this table carries
// the denormalised `client_order_id` for cross-reference.
//
// `close_reason` value set is pinned by a DB CHECK constraint (see migration):
//   'sl' | 'tp' | 'intra_bar_stop' | 'force_close' | 'operator_drain' | 'reconciliation_forced'
// The shared `ExitReasonEnum` does not currently carry `intra_bar_stop`,
// `operator_drain`, or `reconciliation_forced` value labels — services
// (R2b wave B) will own either extending the shared enum (via the
// shared-maintainer route) or introducing a dedicated `PaperCloseReasonEnum`.
// The column type stays `string` at the entity layer; the DB CHECK is the
// safety teeth in this wave.
//
// Per ADR 0032 §D10 the soak's ≥80-trade floor is computed by the soak
// evaluator (a separate read path), excluding `force_close`,
// `operator_drain`, and `reconciliation_forced`. R2b wave A only persists.
@Entity({ name: 'paper_account_state_history', synchronize: false })
@Index('idx_paper_account_state_history_closed_at', ['closedAt'])
@Index('idx_paper_account_state_history_symbol_closed_at', ['symbol', 'closedAt'])
@Index('idx_paper_account_state_history_client_order_id', ['clientOrderId'])
export class PaperAccountStateHistoryEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_account_state_history_id' })
    id!: string;

    // Denormalised reference back to the (now-deleted) `paper_account_state`
    // row. NOT a FK because the parent row is deleted on close; not UNIQUE
    // because a future operator-drain runbook may legitimately re-use a
    // client_order_id after a reconciliation_forced row.
    @Column({ name: 'client_order_id', type: 'text' })
    clientOrderId!: string;

    @Column({ name: 'symbol', type: 'text' })
    symbol!: string;

    @Column({ name: 'side', type: 'text' })
    side!: PositionSideEnum;

    @Column({ name: 'entry_price', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    entryPrice!: MoneyValue;

    @Column({ name: 'exit_price', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    exitPrice!: MoneyValue;

    @Column({ name: 'size', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    size!: MoneyValue;

    @Column({ name: 'realised_pnl', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    realisedPnl!: MoneyValue;

    @Column({ name: 'fees', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    fees!: MoneyValue;

    // Signed: + = received, - = paid. Applied per ADR 0032 §D4 sign
    // convention (longs pay shorts when funding rate is positive).
    @Column({ name: 'funding_accrued', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    fundingAccrued!: MoneyValue;

    // Signed. Captures realised slippage between intent price and fill price.
    @Column({ name: 'slippage', type: 'numeric', precision: 38, scale: 8, default: '0', transformer: decimalColumnTransformer })
    slippage!: MoneyValue;

    // Value set pinned by DB CHECK. See header for the enum-adjudication
    // follow-up item.
    @Column({ name: 'close_reason', type: 'text' })
    closeReason!: string;

    @Column({ name: 'opened_at', type: 'timestamptz' })
    openedAt!: Date;

    @Column({ name: 'closed_at', type: 'timestamptz' })
    closedAt!: Date;

    @Column({ name: 'mode', type: 'text', default: 'paper' })
    mode!: string;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
