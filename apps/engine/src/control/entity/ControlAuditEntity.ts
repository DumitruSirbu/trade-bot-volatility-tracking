import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// M10 W0.5 — widened from `'HALT' | 'RESUME'` to include login-attempt actions
// (ADR 0027 §2.5). The DB CHECK constraint widening lives in migration
// 20260601000000-WidenControlAuditActionForLogin.ts.
export type ControlAuditActionDb = 'HALT' | 'RESUME' | 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'LOGIN_THROTTLED';

// M9 W3 (ADR 0021 §2.3). Persistence projection of `control_audit`. One row
// per accepted halt/resume toggle — operator-driven (via /v1/control/halt) or
// programmatic (M4 market-stress, model-divergence, loss-window). Append-only;
// no UPDATE/DELETE from the engine path.
//
// Schema source-of-truth is `20260528000000-CreateControlAudit.ts`. This entity
// only describes the mapping; `synchronize: false` is non-negotiable.
//
// Action / state values are stored UPPERCASE in the DB (per the migration's
// CHECK constraints) and surfaced to consumers via the shared
// `'halt' | 'resume'` and `'running' | 'halted'` literal types — the
// `ControlAuditRepository` mapper handles the case translation so this entity
// stays a pure column mapping.
@Entity({ name: 'control_audit', synchronize: false })
@Index('idx_control_audit_occurred_at', ['occurredAt'])
@Index('idx_control_audit_actor_occurred', ['actorSub', 'occurredAt'])
export class ControlAuditEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'control_audit_id' })
    controlAuditId!: string;

    @Column({ name: 'occurred_at', type: 'timestamptz' })
    occurredAt!: Date;

    @Column({ name: 'actor_sub', type: 'text' })
    actorSub!: string;

    @Column({ name: 'actor_jti', type: 'text' })
    actorJti!: string;

    // `inet` maps to a string in TypeORM; null when loopback / programmatic.
    @Column({ name: 'source_ip', type: 'inet', nullable: true })
    sourceIp!: string | null;

    @Column({ name: 'action', type: 'text' })
    action!: ControlAuditActionDb;

    @Column({ name: 'reason', type: 'text' })
    reason!: string;

    @Column({ name: 'flatten_requested', type: 'boolean', default: false })
    flattenRequested!: boolean;

    @Column({ name: 'previous_state', type: 'text' })
    previousState!: 'RUNNING' | 'HALTED';

    @Column({ name: 'new_state', type: 'text' })
    newState!: 'RUNNING' | 'HALTED';

    @Column({ name: 'correlation_event_id', type: 'text', nullable: true })
    correlationEventId!: string | null;
}
