import { IMarketSnapshot, ISimulatedFill, IVirtualLedgerSnapshot } from '@bot/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { StrategyVersionEntity } from './StrategyVersionEntity';

// M11a W0.5 (ADR 0029 §2.3.2). One row per (shadow_version, trigger event_id).
// Recorded when a non-executed version (v0/v2/v3) emits a decision over the
// soak's event tape. The UNIQUE(shadow_version, event_id) constraint is the
// idempotency anchor for restart-replay (ADR 0029 §2.1.2): rebuilding the
// virtual ledger walks these rows in event order, and a re-emit of the same
// (version, event) MUST not insert twice.
@Entity({ name: 'shadow_decisions', synchronize: false })
@Index('uq_shadow_decisions_version_event_id', ['shadowVersion', 'eventId'], { unique: true })
@Index('idx_shadow_decisions_version_created_at', ['strategyVersionId', 'createdAt'])
@Index('idx_shadow_decisions_created_at', ['createdAt'])
export class ShadowDecisionEntity {
    @PrimaryGeneratedColumn({ name: 'shadow_decisions_id' })
    id!: number;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ name: 'event_id', type: 'text' })
    eventId!: string;

    // Discriminator: 'v0' | 'v2' | 'v3'. Kept as a free-text column rather
    // than a CHECK-bounded enum so adding a future shadow version is a code
    // change only — the strategy registry remains authoritative.
    @Column({ name: 'shadow_version', type: 'text' })
    shadowVersion!: string;

    @Column({ name: 'strategy_version_id', type: 'integer' })
    strategyVersionId!: number;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'strategy_version_id', referencedColumnName: 'id' })
    strategyVersion!: StrategyVersionEntity;

    @Column({ name: 'symbol', type: 'text' })
    symbol!: string;

    // SignalActionEnum value (stringly-typed at the column level for the same
    // forward-compat reason the live decisions table uses varchar for `action`).
    @Column({ name: 'action', type: 'text' })
    action!: string;

    // M11a W2.1 (ADR 0029 §2.1.3). Persisted side ('long' | 'short') for the
    // shadow decision when `action === 'open'`. Nullable because skip /
    // rejected rows have no side. Read by the cold-restart rebuild path so
    // the replayed virtual ledger is side-faithful (W3 intra-bar stop sim).
    @Column({ name: 'trade_side', type: 'text', nullable: true })
    tradeSide?: string | null;

    // M11a W5a (ADR 0029 §2.1.2). Persisted qty / stop-loss / take-profit
    // sized at open time so the cold-restart ledger rebuild can replay the
    // exact original position rather than re-deriving qty from the entry
    // price (a re-derive without the original stop produces qty=0 and silently
    // drops the open). Nullable for skip / rejected rows and for legacy rows
    // persisted before this column existed.
    @Column({ name: 'qty', type: 'text', nullable: true })
    qty?: string | null;

    @Column({ name: 'stop_loss', type: 'text', nullable: true })
    stopLoss?: string | null;

    @Column({ name: 'take_profit', type: 'text', nullable: true })
    takeProfit?: string | null;

    @Column({ name: 'reject_reason', type: 'text', nullable: true })
    rejectReason?: string | null;

    @Column({ name: 'gate_allowed', type: 'boolean' })
    gateAllowed!: boolean;

    @Column({ name: 'virtual_slot_state_snapshot', type: 'jsonb' })
    virtualSlotStateSnapshot!: IVirtualLedgerSnapshot;

    // Null when the gate rejected or the strategy skipped — no fill was
    // simulated in either case (ADR 0029 §2.3.1).
    @Column({ name: 'simulated_fill', type: 'jsonb', nullable: true })
    simulatedFill?: ISimulatedFill | null;

    @Column({ name: 'market_snapshot', type: 'jsonb' })
    marketSnapshot!: IMarketSnapshot;

    // M36 Dispatch C — bias marker. true when the row was written while the
    // consecutive-loss halt was relaxed (paper soak forced-continuation). Fences
    // these left-tail forced-continuation outcomes from cross-version A/B
    // analysis. Stamped at write time from the resolved boot flag.
    @Column({ name: 'halt_relax_active', type: 'boolean', nullable: false, default: false })
    haltRelaxActive!: boolean;
}
