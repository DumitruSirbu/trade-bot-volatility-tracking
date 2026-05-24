import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// M8 W2 anchor row for a walk-forward / same-event comparison run (ADR 0017 §2.6).
// One row per run. split_policy / folds / summary are stored as jsonb; the full
// IComparisonReport JSON lives on disk at `artefact_uri` (M11 will swap for S3).
//
// Typed access to summary/split_policy/folds happens at the service layer in W4+ once
// IComparisonReportSummary stabilises. At the entity boundary the jsonb fields are
// unknown — premature shared-typing would force a packages/shared/ change every time a
// summary field is added during W3 iteration. (Routing rule: if the typed shape is
// needed by the dashboard or another workspace, that triggers bot-shared-maintainer.)
//
// version_ids is a Postgres integer[] referencing strategy_versions.id. It is NOT an
// FK array — Postgres has no array-FK; referential integrity for the membership set is
// enforced at the application layer when a comparison run is recorded.
@Entity({ name: 'comparison_reports', synchronize: false })
@Index('idx_comparison_reports_created_at', ['createdAt'])
export class ComparisonReportEntity {
    // BIGSERIAL in DB; TS keeps `number` to satisfy BaseRepository.IdentifiableEntity
    // (the pattern used by tick_aggregates). At M8 cadence the id will not exceed
    // 2^53 — comparison runs are operator-driven, hours-scale.
    @PrimaryGeneratedColumn({ name: 'comparison_reports_id' })
    id!: number;

    @Column({ name: 'run_label', type: 'text' })
    runLabel!: string;

    @Column({ name: 'from_ms', type: 'bigint' })
    fromMs!: string;

    @Column({ name: 'to_ms', type: 'bigint' })
    toMs!: string;

    @Column({ name: 'split_policy', type: 'jsonb' })
    splitPolicy!: Record<string, unknown>;

    @Column({ name: 'folds', type: 'jsonb' })
    folds!: unknown[];

    @Column({ name: 'version_ids', type: 'integer', array: true })
    versionIds!: number[];

    @Column({ name: 'summary', type: 'jsonb' })
    summary!: Record<string, unknown>;

    @Column({ name: 'artefact_uri', type: 'text' })
    artefactUri!: string;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
