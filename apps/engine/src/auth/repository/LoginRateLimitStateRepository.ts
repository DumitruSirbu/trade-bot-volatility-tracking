import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';

import { LOGIN_PER_IP_SUSTAINED_WINDOW_MS } from '../const/authConsts';
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
        // Only hydrate rows updated within the longest configured window
        // (`LOGIN_PER_IP_SUSTAINED_WINDOW_MS`, currently 10 min). Older rows
        // can only contain timestamps that are guaranteed to be pruned by the
        // first enforce() pass anyway — loading them wastes memory and slows
        // boot under a poisoned table.
        const freshSince = new Date(Date.now() - LOGIN_PER_IP_SUSTAINED_WINDOW_MS);
        const rows = await this.repository.find({ where: { updatedAt: MoreThan(freshSince) } });

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
