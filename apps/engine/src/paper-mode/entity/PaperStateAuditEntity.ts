import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Persistence projection of `paper_state_audit` (ADR 0032 §D6 / §D16).
// Append-only HMAC-chained audit row written in the SAME transaction as
// every mutation to `paper_account_state`, `paper_account_state_history`,
// `paper_account_state_meta`, and `paper_account_snapshots`. Verified
// (HMAC walk + prev linkage) by PaperStateAuditChainService whenever the
// soak-exit evaluator or operator runbook checks chain integrity.
//
// Schema source of truth is the corresponding migration; `synchronize: false`
// is non-negotiable.
@Entity({ name: 'paper_state_audit', synchronize: false })
@Index('idx_paper_state_audit_seq', ['seq'], { unique: true })
@Index('idx_paper_state_audit_subject', ['subjectKind', 'subjectId'])
@Index('idx_paper_state_audit_recorded_at', ['recordedAt'])
export class PaperStateAuditEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_state_audit_id' })
    id!: string;

    // BIGSERIAL — monotonic ordering independent of clock. Included in the
    // signed payload so clock-skew cannot let an attacker insert a row that
    // appears earlier than tip (D6 / security round-2 M3).
    @Column({ name: 'seq', type: 'bigint' })
    seq!: string;

    @Column({ name: 'recorded_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    recordedAt!: Date;

    // Restricted to the MutationKindEnum value set via DB CHECK constraint in
    // the migration. Stored as text rather than a Postgres ENUM to keep
    // forward-only widening cheap (a new mutation kind needs only a CHECK
    // widening migration).
    @Column({ name: 'mutation_kind', type: 'text' })
    mutationKind!: string;

    // Restricted to the SubjectKindEnum value set via DB CHECK constraint.
    @Column({ name: 'subject_kind', type: 'text' })
    subjectKind!: string;

    // PK of the audited row. NOT a FK because the parent row may be deleted
    // (close → paper_account_state row delete); the audit row stays.
    @Column({ name: 'subject_id', type: 'uuid' })
    subjectId!: string;

    // SHA-256 of the canonical mutation payload. The audit row stays small;
    // the offline verifier reconstructs the canonical payload from the audited
    // row to recompute the hash.
    @Column({ name: 'payload_hash', type: 'bytea' })
    payloadHash!: Buffer;

    // HMAC of the prior audit row's signed payload. Null only on the genesis
    // row of this chain.
    @Column({ name: 'prev_row_hash', type: 'bytea', nullable: true })
    prevRowHash!: Buffer | null;

    // HMAC of THIS row's signed payload under the per-purpose
    // `paper_state_audit v1` sub-key.
    @Column({ name: 'this_row_hmac', type: 'bytea' })
    thisRowHmac!: Buffer;
}
