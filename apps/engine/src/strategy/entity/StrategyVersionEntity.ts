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

    // M8 W2 (ADR 0016 §2.1) promotion-audit fields. Populated by PromotionService when a
    // draft row is promoted to active; cleared/refreshed by reactivate. promotion_report_id
    // FKs comparison_reports.id (ON DELETE SET NULL) so a deleted report unlinks but does
    // not orphan-cascade the strategy row. promotion_note is a free-text operator reason
    // (M11 will add identity; the column is forward-compatible).
    @Column({ name: 'promoted_at', type: 'timestamptz', nullable: true })
    promotedAt?: Date | null;

    @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
    archivedAt?: Date | null;

    @Column({ name: 'promotion_report_id', type: 'integer', nullable: true })
    promotionReportId?: number | null;

    @Column({ name: 'promotion_note', type: 'text', nullable: true })
    promotionNote?: string | null;
}
