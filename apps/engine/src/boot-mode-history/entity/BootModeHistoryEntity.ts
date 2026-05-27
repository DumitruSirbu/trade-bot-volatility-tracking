import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Persistence projection of `boot_mode_history` (ADR 0032 §D6).
// Append-only typed-row HMAC chain over every successful boot, transition,
// rotation witness, restore, or machine-repurpose-wipe. Verified at every
// boot via `BootModeChainService.verifyChainIntegrity`. Retained forever for
// the security audit trail across milestones (ADR 0032 §D16 retention table).
//
// Schema source of truth is the corresponding migration; `synchronize: false`
// is non-negotiable.
//
// Timestamp dump/restore note: `bootedAt` is `timestamptz` with microsecond
// precision in Postgres; ISO-8601 serialisation truncates to milliseconds.
// Dump-then-restore of a row signed under microsecond precision will not
// re-verify after restore if the new Postgres truncates differently. M11a
// runs single-host so this is not load-bearing; M11b will widen the codec
// to encode microseconds explicitly.
@Entity({ name: 'boot_mode_history', synchronize: false })
@Index('idx_boot_mode_history_seq', ['seq'], { unique: true })
export class BootModeHistoryEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'boot_mode_history_id' })
    id!: string;

    // BIGSERIAL — monotonic ordering independent of clock. Included in the
    // signed payload so clock-skew cannot let an attacker insert a row that
    // appears earlier than tip (D6 / security round-2 M3).
    @Column({ name: 'seq', type: 'bigint' })
    seq!: string;

    @Column({ name: 'booted_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    bootedAt!: Date;

    // Restricted to the BootModeHistoryRowKindEnum value set via DB CHECK
    // constraint (in the migration).
    @Column({ name: 'row_kind', type: 'text' })
    rowKind!: string;

    // Env in effect AFTER this row applies. For BOOT rows this equals the
    // current `EXCHANGE_ENV`; for TRANSITION rows it equals `to_env`.
    @Column({ name: 'exchange_env', type: 'text' })
    exchangeEnv!: string;

    @Column({ name: 'from_env', type: 'text', nullable: true })
    fromEnv!: string | null;

    @Column({ name: 'to_env', type: 'text', nullable: true })
    toEnv!: string | null;

    // HMAC of the prior row's signed payload. Null only on the genesis row.
    @Column({ name: 'prev_row_hash', type: 'bytea', nullable: true })
    prevRowHash!: Buffer | null;

    // HMAC of THIS row's signed payload, computed under the per-purpose
    // sub-key derived from `AUTH_BOOTSTRAP_SECRET` via HKDF.
    @Column({ name: 'this_row_hmac', type: 'bytea' })
    thisRowHmac!: Buffer;
}
