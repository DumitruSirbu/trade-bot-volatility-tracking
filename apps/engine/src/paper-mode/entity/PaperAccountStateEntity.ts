import { PositionSideEnum } from '@bot/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, MoneyValue } from '../../common/utils';

// Persistence projection of `paper_account_state` (ADR 0032 §D1 / §D16). The
// current open paper-position state. Keyed by the canonical `client_order_id`
// (matches M5's `tbvt-...` idempotency discipline) so a retry or restart
// cannot double-open a row for the same intent.
//
// `mode` is a sanity column constrained to 'paper' by a DB CHECK; PAPER state
// never leaks into the live `positions` table and vice-versa.
//
// IMPORTANT (D16 — unrealised PnL is derived, not state):
// There is NO `unrealised_pnl` column on this entity. Mark-to-market for the
// drawdown-abort threshold and read-API projection is computed on demand
// from `(mark_price - entry_price) * size * side_sign` so a tamper of MTM
// state cannot bypass the three-table atomic-write + audit path (audit table
// lands in R2b wave B alongside services).
//
// Schema source of truth is the corresponding migration; `synchronize: false`
// is non-negotiable.
@Entity({ name: 'paper_account_state', synchronize: false })
@Index('idx_paper_account_state_symbol', ['symbol'])
@Index('idx_paper_account_state_opened_at', ['openedAt'])
export class PaperAccountStateEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_account_state_id' })
    id!: string;

    // Canonical idempotent identifier. UNIQUE in the migration — duplicate
    // insert raises a constraint violation that services interpret as "this
    // intent already opened" (no double-fire on retry).
    @Column({ name: 'client_order_id', type: 'text' })
    clientOrderId!: string;

    @Column({ name: 'symbol', type: 'text' })
    symbol!: string;

    @Column({ name: 'side', type: 'text' })
    side!: PositionSideEnum;

    @Column({ name: 'entry_price', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    entryPrice!: MoneyValue;

    @Column({ name: 'size', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    size!: MoneyValue;

    // Integer per the M11a restricted profile contract (no fractional leverage
    // on the soak). The numeric tier (`DecimalValue`) here is over-engineering
    // for an integer; left as `number` because the column is `integer` and
    // never participates in money math directly.
    @Column({ name: 'leverage', type: 'integer' })
    leverage!: number;

    @Column({ name: 'opened_at', type: 'timestamptz' })
    openedAt!: Date;

    // Pinned to 'paper' by DB CHECK constraint. Services NEVER derive this
    // from runtime input — it is always written as the literal 'paper'.
    @Column({ name: 'mode', type: 'text', default: 'paper' })
    mode!: string;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
