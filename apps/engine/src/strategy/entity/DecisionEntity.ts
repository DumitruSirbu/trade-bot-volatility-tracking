import { IMarketSnapshot } from '@bot/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { PositionEntity } from '../../position/entity';
import { StrategyVersionEntity } from './StrategyVersionEntity';

// One row per (strategy version, trigger). event_id is a stable id shared by every
// version writing a decision for the SAME VWAP trigger, so M8 compares v0/v1/v2/v3 on
// the same event under the same market path. market_snapshot is a Zod-validated JSONB
// payload (DecisionRepository safeParse hook). No live writer until M3.
@Entity({ name: 'decisions', synchronize: false })
@Index('idx_decisions_strategy_version_id_ts', ['strategyVersionId', 'ts'])
@Index('idx_decisions_event_id', ['eventId'])
export class DecisionEntity {
    @PrimaryGeneratedColumn({ name: 'decisions_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'strategy_version_id', type: 'integer' })
    strategyVersionId!: number;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'strategy_version_id', referencedColumnName: 'id' })
    strategyVersion!: StrategyVersionEntity;

    @Column({ name: 'ts', type: 'timestamptz' })
    ts!: Date;

    @Column({ name: 'event_id', type: 'varchar' })
    eventId!: string;

    @Column({ name: 'signal_type', type: 'varchar' })
    signalType!: string;

    @Column({ name: 'market_snapshot', type: 'jsonb' })
    marketSnapshot!: IMarketSnapshot;

    @Column({ name: 'action', type: 'varchar' })
    action!: string;

    @Column({ name: 'reason', type: 'varchar', nullable: true })
    reason?: string | null;

    @Column({ name: 'position_id', type: 'integer', nullable: true })
    positionId?: number | null;

    @ManyToOne(() => PositionEntity, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'position_id', referencedColumnName: 'id' })
    position?: PositionEntity | null;
}
