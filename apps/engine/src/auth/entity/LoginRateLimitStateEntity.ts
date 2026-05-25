import { Column, Entity, PrimaryColumn } from 'typeorm';

// M11a W1.9. Persistence projection of `login_rate_limit_state` — per
// (source_ip, scope) windowed attempt timestamps. Loaded at boot to rebuild
// LoginRateLimiter in-memory state; re-saved on every enforce() pass so a
// crash within a brute-force window does not silently reset counters.
//
// `scope` is constrained to `'burst' | 'sustained' | 'global'` by the
// migration's CHECK constraint; the TS type widens to `string` (TypeORM's
// CHECK constraints are schema-side, not type-side).
@Entity({ name: 'login_rate_limit_state', synchronize: false })
export class LoginRateLimitStateEntity {
    @PrimaryColumn({ name: 'source_ip', type: 'text' })
    sourceIp!: string;

    @PrimaryColumn({ name: 'scope', type: 'text' })
    scope!: string;

    // jsonb array of integer ms timestamps. TypeORM hands jsonb back as the
    // parsed JS value; consumers cast to `number[]`.
    @Column({ name: 'timestamps_ms', type: 'jsonb', default: () => `'[]'::jsonb` })
    timestampsMs!: number[];

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
    updatedAt!: Date;
}
