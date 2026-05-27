import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Persistence projection of `boot_mode_chain_rotations` (ADR 0032 §D7).
// Records every sanctioned transition between EXCHANGE_ENV values, separately
// from `boot_mode_history` so a forensic auditor can distinguish a sanctioned
// transition from a compromise. HMAC-chained under a dedicated sub-key
// (`boot_mode_chain_rotations v1`) derived independently from
// `boot_mode_history v1` per ADR 0032 §D6. Retained forever.
@Entity({ name: 'boot_mode_chain_rotations', synchronize: false })
@Index('idx_boot_mode_chain_rotations_seq', ['seq'], { unique: true })
export class BootModeChainRotationEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'boot_mode_chain_rotation_id' })
    id!: string;

    @Column({ name: 'seq', type: 'bigint' })
    seq!: string;

    @Column({ name: 'rotated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    rotatedAt!: Date;

    @Column({ name: 'from_env', type: 'text' })
    fromEnv!: string;

    @Column({ name: 'to_env', type: 'text' })
    toEnv!: string;

    // HMAC of the boot_mode_history tip BEFORE the transition row was written.
    // Lets a forensic auditor walk forward through both chains and confirm the
    // transition row hash appears in boot_mode_history immediately after this
    // rotation row's `pre_tip_hash` value.
    @Column({ name: 'pre_tip_hash', type: 'bytea' })
    preTipHash!: Buffer;

    // SHA-256 of the operator-provided transition token file's trimmed
    // content. Single-use — once written, the same token cannot drive
    // another transition without rotating.
    @Column({ name: 'transition_token_hash', type: 'bytea' })
    transitionTokenHash!: Buffer;

    @Column({ name: 'prev_row_hash', type: 'bytea', nullable: true })
    prevRowHash!: Buffer | null;

    @Column({ name: 'this_row_hmac', type: 'bytea' })
    thisRowHmac!: Buffer;
}
