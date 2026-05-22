import { CoinTierEnum, ExitReasonEnum, PositionSideEnum, PositionSlotEnum, VwapAnchorTypeEnum } from '@bot/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { decimalColumnTransformer, DecimalValue, MoneyValue } from '../../common/utils';
import { StrategyVersionEntity } from '../../strategy/entity';

// Authoritative position record. Carries the trade lifecycle plus immutable entry-time
// analysis/algo columns (captured at open) and mutable lifetime-instrumentation columns
// (populated by M6) used to diagnose whether the strategy is actually low-risk. coin_tier
// stores the CoinTierEnum string (ADR §5, overrides the brief's SMALLINT). No live writer
// until M3–M6 (schema + repository only in M2).
@Entity({ name: 'positions', synchronize: false })
@Index('idx_positions_strategy_version_id_status', ['strategyVersionId', 'status'])
@Index('idx_positions_symbol_status', ['symbol', 'status'])
export class PositionEntity {
    @PrimaryGeneratedColumn({ name: 'positions_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'strategy_version_id', type: 'integer' })
    strategyVersionId!: number;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'strategy_version_id', referencedColumnName: 'id' })
    strategyVersion!: StrategyVersionEntity;

    @Column({ name: 'side', type: 'varchar' })
    side!: PositionSideEnum;

    @Column({ name: 'status', type: 'varchar' })
    status!: string;

    @Column({ name: 'leverage', type: 'numeric', precision: 10, scale: 4, transformer: decimalColumnTransformer })
    leverage!: DecimalValue;

    @Column({ name: 'entry_price', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    entryPrice!: MoneyValue;

    @Column({ name: 'qty', type: 'numeric', precision: 38, scale: 18, transformer: decimalColumnTransformer })
    qty!: MoneyValue;

    @Column({ name: 'entry_notional', type: 'numeric', precision: 38, scale: 8, transformer: decimalColumnTransformer })
    entryNotional!: MoneyValue;

    @Column({ name: 'exit_price', type: 'numeric', precision: 38, scale: 18, nullable: true, transformer: decimalColumnTransformer })
    exitPrice?: MoneyValue | null;

    @Column({ name: 'realized_pnl', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    realizedPnl?: MoneyValue | null;

    @Column({ name: 'exit_reason', type: 'varchar', nullable: true })
    exitReason?: ExitReasonEnum | null;

    @Column({ name: 'opened_at', type: 'timestamptz' })
    openedAt!: Date;

    @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
    closedAt?: Date | null;

    // --- entry-time analysis / algo columns (immutable after open) ---

    @Column({ name: 'vwap_at_entry', type: 'numeric', precision: 38, scale: 18, nullable: true, transformer: decimalColumnTransformer })
    vwapAtEntry?: MoneyValue | null;

    @Column({ name: 'atr_at_entry', type: 'numeric', precision: 38, scale: 18, nullable: true, transformer: decimalColumnTransformer })
    atrAtEntry?: MoneyValue | null;

    @Column({ name: 'vwap_deviation_at_entry', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    vwapDeviationAtEntry?: DecimalValue | null;

    @Column({ name: 'idiosyncrasy_at_entry', type: 'numeric', precision: 10, scale: 6, nullable: true, transformer: decimalColumnTransformer })
    idiosyncrasyAtEntry?: DecimalValue | null;

    @Column({ name: 'coin_tier', type: 'varchar', nullable: true })
    coinTier?: CoinTierEnum | null;

    @Column({ name: 'signal_score_at_entry', type: 'numeric', precision: 10, scale: 6, nullable: true, transformer: decimalColumnTransformer })
    signalScoreAtEntry?: DecimalValue | null;

    @Column({ name: 'position_slot', type: 'varchar', nullable: true })
    positionSlot?: PositionSlotEnum | null;

    @Column({ name: 'time_stop_at', type: 'timestamptz', nullable: true })
    timeStopAt?: Date | null;

    @Column({ name: 'slippage_model_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    slippageModelPct?: DecimalValue | null;

    @Column({ name: 'open_interest_at_entry', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    openInterestAtEntry?: MoneyValue | null;

    @Column({ name: 'oi_change_5m_at_entry', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    oiChange5mAtEntry?: DecimalValue | null;

    @Column({ name: 'flow_type_at_entry', type: 'varchar', nullable: true })
    flowTypeAtEntry?: string | null;

    @Column({ name: 'funding_annualized_at_entry', type: 'numeric', precision: 18, scale: 10, nullable: true, transformer: decimalColumnTransformer })
    fundingAnnualizedAtEntry?: DecimalValue | null;

    @Column({ name: 'book_depth_10bps_at_entry', type: 'numeric', precision: 38, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    bookDepth10bpsAtEntry?: MoneyValue | null;

    @Column({ name: 'spread_at_entry_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    spreadAtEntryPct?: DecimalValue | null;

    @Column({ name: 'vwap_anchor_type', type: 'varchar', nullable: true })
    vwapAnchorType?: VwapAnchorTypeEnum | null;

    @Column({ name: 'symbol_universe_age_hours', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    symbolUniverseAgeHours?: DecimalValue | null;

    // --- lifetime instrumentation (mutable through the position's life, M6) ---

    @Column({ name: 'mae_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    maePct?: DecimalValue | null;

    @Column({ name: 'mfe_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    mfePct?: DecimalValue | null;

    @Column({ name: 'time_to_reversion_secs', type: 'integer', nullable: true })
    timeToReversionSecs?: number | null;

    @Column({ name: 'stop_gap_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    stopGapPct?: DecimalValue | null;

    @Column({ name: 'min_liquidation_distance_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    minLiquidationDistancePct?: DecimalValue | null;

    @Column({ name: 'protective_order_type', type: 'varchar', nullable: true })
    protectiveOrderType?: string | null;

    @Column({ name: 'mark_vs_last_max_divergence_pct', type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: decimalColumnTransformer })
    markVsLastMaxDivergencePct?: DecimalValue | null;
}
