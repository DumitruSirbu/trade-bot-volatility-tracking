import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Persistence projection of `paper_account_state_meta` (ADR 0032 §D3 / §D17).
//
// CRITICAL — this table holds ONLY non-secret derived metadata. No bootstrap
// secret, no HKDF seed_master, no per-order seed, no CRN tape root. The two
// columns that look secret-adjacent are deliberately fingerprints:
//
//   - `simulator_config_hash` — SHA-256 hex of the committed M7 simulator
//     config file. The simulator refuses to start if its config file hash
//     differs from this value (defence against an operator tuning the
//     simulator to flatter v1 — D3).
//   - `bootstrap_at_start_fingerprint` — SHA-256 hex of the bootstrap secret
//     captured at soak start (D17). Used to verify the operator names the
//     same secret post-soak when re-deriving the CRN root for the offline
//     evaluator. The raw secret is NEVER persisted; this column is the
//     fingerprint only.
//
// Keyed naturally by `soak_start_id` (UNIQUE). The surrogate uuid PK exists
// for repository ergonomics; lookup-by-soak-start-id is the load-bearing
// access path.
//
// Retention: at least through M11b decision (ADR 0032 §D16 retention table).
@Entity({ name: 'paper_account_state_meta', synchronize: false })
export class PaperAccountStateMetaEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_account_state_meta_id' })
    id!: string;

    @Column({ name: 'soak_start_id', type: 'uuid' })
    soakStartId!: string;

    @Column({ name: 'soak_start_ts', type: 'timestamptz' })
    soakStartTs!: Date;

    // e.g. 'paper_simulator_seed v1' — the HKDF info string label.
    @Column({ name: 'seed_version_label', type: 'text' })
    seedVersionLabel!: string;

    // Free-form version string, e.g. 'v1'.
    @Column({ name: 'hkdf_info_version', type: 'text' })
    hkdfInfoVersion!: string;

    // SHA-256 hex of the committed M7 simulator config file.
    @Column({ name: 'simulator_config_hash', type: 'text' })
    simulatorConfigHash!: string;

    // SHA-256 hex of the bootstrap secret captured at soak start. NEVER the
    // raw secret.
    @Column({ name: 'bootstrap_at_start_fingerprint', type: 'text' })
    bootstrapAtStartFingerprint!: string;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
