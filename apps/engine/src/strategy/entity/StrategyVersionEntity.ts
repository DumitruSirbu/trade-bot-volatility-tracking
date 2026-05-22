import { StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

// A versioned strategy definition (v0–v3) with its canonical params JSONB. v0/v1/v2/v3
// are compared on the same trigger event in M8. parent_version_id is a self-FK lineage
// pointer (SET NULL on delete — a deleted parent must not orphan-cascade its children).
@Entity({ name: 'strategy_versions', synchronize: false })
@Unique('uq_strategy_versions_name_version', ['name', 'version'])
export class StrategyVersionEntity {
    @PrimaryGeneratedColumn({ name: 'strategy_versions_id' })
    id!: number;

    @Column({ name: 'name', type: 'varchar' })
    name!: string;

    @Column({ name: 'version', type: 'integer' })
    version!: number;

    @Column({ name: 'direction', type: 'varchar' })
    direction!: StrategyDirectionEnum;

    @Column({ name: 'params', type: 'jsonb' })
    params!: Record<string, unknown>;

    @Column({ name: 'status', type: 'varchar' })
    status!: StrategyStatusEnum;

    @Column({ name: 'parent_version_id', type: 'integer', nullable: true })
    parentVersionId?: number | null;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'parent_version_id', referencedColumnName: 'id' })
    parentVersion?: StrategyVersionEntity | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
