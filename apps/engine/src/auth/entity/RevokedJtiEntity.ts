import { Column, Entity, PrimaryColumn } from 'typeorm';

// M9 W2 — persistence projection of the `revoked_jti` table (ADR 0020 §2.2).
// Pure entity: no business logic, no relations. The migration is the source
// of truth for the schema; this class only describes the read/write mapping.
@Entity({ name: 'revoked_jti', synchronize: false })
export class RevokedJtiEntity {
    @PrimaryColumn({ name: 'jti', type: 'uuid' })
    jti!: string;

    @Column({ name: 'revoked_at', type: 'timestamptz', default: () => 'now()' })
    revokedAt!: Date;

    @Column({ name: 'reason', type: 'text', nullable: true })
    reason!: string | null;

    @Column({ name: 'revoked_by', type: 'text' })
    revokedBy!: string;
}
