import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { StrategyVersionEntity } from './StrategyVersionEntity';

// M13 W0 (ADR 0036 §"agent_run_history") — one row per weekly agent run.
//
// Lifecycle: a row is INSERTed when a run starts (terminal_state stays NULL
// until the run finishes, at which point a follow-up UPDATE is intentionally
// disallowed for agent_writer — the application code commits the row in its
// terminal shape via the engine's full-rights connection, while the agent's
// only write path is the draft_strategy_version SDF on strategy_versions).
//
// week_iso is UNIQUE: at most one run per ISO 8601 week (e.g. `2026-W22`).
// IDEMPOTENT_SKIP rows record the no-op outcome when a draft for the same
// (parent, week) already exists.
//
// agent_run_id is BIGSERIAL — runs are weekly, but the column matches the
// pattern set by comparison_reports (BIGSERIAL primary, TS `number`). At
// weekly cadence the id will not exceed 2^53.
@Entity({ name: 'agent_run_history', synchronize: false })
@Unique('uq_agent_run_history_week_iso', ['weekIso'])
export class AgentRunHistoryEntity {
    @PrimaryGeneratedColumn({ name: 'agent_run_id', type: 'bigint' })
    id!: number;

    @Column({ name: 'week_iso', type: 'text' })
    weekIso!: string;

    @Column({ name: 'parent_version_id', type: 'integer' })
    parentVersionId!: number;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'parent_version_id', referencedColumnName: 'id' })
    parentVersion?: StrategyVersionEntity;

    @Column({ name: 'draft_version_id', type: 'integer', nullable: true })
    draftVersionId?: number | null;

    @ManyToOne(() => StrategyVersionEntity, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'draft_version_id', referencedColumnName: 'id' })
    draftVersion?: StrategyVersionEntity | null;

    @Column({ name: 'model_id', type: 'text' })
    modelId!: string;

    @Column({ name: 'report_md_path', type: 'text', nullable: true })
    reportMdPath?: string | null;

    @Column({ name: 'report_json_path', type: 'text', nullable: true })
    reportJsonPath?: string | null;

    // CHECK-constrained at the DB level to ('COMPLETED','SKIPPED_HALTED',
    // 'IDEMPOTENT_SKIP','FAILED'). Kept as a string here; a shared enum
    // belongs in packages/shared/ once M13 W1 consumers stabilise.
    @Column({ name: 'terminal_state', type: 'text' })
    terminalState!: string;

    @Column({ name: 'failure_reason', type: 'text', nullable: true })
    failureReason?: string | null;

    @Column({ name: 'started_at', type: 'timestamptz' })
    startedAt!: Date;

    @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
    finishedAt?: Date | null;

    // Decimal columns: stored as `numeric` in Postgres, exposed as `string`
    // in TS (TypeORM's default for numeric to avoid float coercion). The
    // service layer converts to decimal.js as needed.
    @Column({ name: 'bootstrap_ci_lo', type: 'numeric', nullable: true })
    bootstrapCiLo?: string | null;

    @Column({ name: 'bootstrap_ci_hi', type: 'numeric', nullable: true })
    bootstrapCiHi?: string | null;

    @Column({ name: 'passes_promotion_gate', type: 'boolean', nullable: true })
    passesPromotionGate?: boolean | null;
}
