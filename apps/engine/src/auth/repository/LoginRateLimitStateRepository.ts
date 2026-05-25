import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoginRateLimitStateEntity } from '../entity/LoginRateLimitStateEntity';

// M11a W1.9. Repository for `login_rate_limit_state`. The limiter uses this
// at boot (`loadAll`) to rebuild in-memory windows, and on every enforce()
// pass (`upsert`) to persist the just-recorded attempt. The hot-path is the
// in-memory limiter; this is a write-through cache.
//
// PK is composite `(source_ip, scope)` so each scope writes independently and
// retains its own pruning cadence.

export type LoginRateLimitScope = 'burst' | 'sustained' | 'global';

export interface ILoginRateLimitRow {
    sourceIp: string;
    scope: LoginRateLimitScope;
    timestampsMs: number[];
}

@Injectable()
export class LoginRateLimitStateRepository {
    constructor(@InjectRepository(LoginRateLimitStateEntity) private readonly repository: Repository<LoginRateLimitStateEntity>) {}

    async loadAll(): Promise<ILoginRateLimitRow[]> {
        const rows = await this.repository.find();

        return rows.map((row) => ({
            sourceIp: row.sourceIp,
            scope: row.scope as LoginRateLimitScope,
            timestampsMs: Array.isArray(row.timestampsMs) ? row.timestampsMs : [],
        }));
    }

    async upsert(row: ILoginRateLimitRow, now: Date): Promise<void> {
        // ON CONFLICT (source_ip, scope) DO UPDATE — rewrites the timestamps
        // array and bumps updated_at. The hot-path keeps the call O(1) on the
        // engine side; Postgres handles the row replace under the PK index.
        await this.repository
            .createQueryBuilder()
            .insert()
            .values({
                sourceIp: row.sourceIp,
                scope: row.scope,
                timestampsMs: row.timestampsMs,
                updatedAt: now,
            })
            .orUpdate(['timestamps_ms', 'updated_at'], ['source_ip', 'scope'])
            .execute();
    }

    async deleteByKey(sourceIp: string, scope: LoginRateLimitScope): Promise<void> {
        await this.repository.delete({ sourceIp, scope });
    }
}
