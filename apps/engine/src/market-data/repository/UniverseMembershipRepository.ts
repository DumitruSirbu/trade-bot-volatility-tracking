import { CoinTierEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { UniverseMembershipEntity } from '../entity';

// Maintains a gap-free point-in-time tier timeline (ADR 0002 §4). enter → openMembership;
// leave → closeOpenMembership; tier change → close prior + open new. The open row is the
// one with left_at IS NULL. The DB also enforces at most one open row per symbol via a
// partial UNIQUE index (symbol WHERE left_at IS NULL), so a race cannot create a second.
@Injectable()
export class UniverseMembershipRepository extends BaseRepository<UniverseMembershipEntity> {
    constructor(@InjectRepository(UniverseMembershipEntity) repository: Repository<UniverseMembershipEntity>) {
        super(repository);
    }

    async findOpenMembership(symbol: string): Promise<UniverseMembershipEntity | null> {
        return this.repository.findOne({ where: { symbol, leftAt: IsNull() } });
    }

    // Idempotent open: a no-op when an open row already exists (a restart re-seeds every
    // current member as 'entered', and duplicate enters must not stack a second open row).
    async openMembership(symbol: string, coinTier: CoinTierEnum, enteredAt: Date): Promise<void> {
        await this.openMembershipWith(this.repository.manager, symbol, coinTier, enteredAt);
    }

    async closeOpenMembership(symbol: string, leftAt: Date): Promise<void> {
        await this.closeOpenMembershipWith(this.repository.manager, symbol, leftAt);
    }

    // Atomic tier change: close the prior open row and open the new one in ONE transaction
    // so a crash between the two writes can never leave a symbol with zero open rows (which
    // would be a timeline gap — the survivorship bug this table exists to prevent).
    async changeTier(symbol: string, coinTier: CoinTierEnum, changedAt: Date): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            await this.closeOpenMembershipWith(manager, symbol, changedAt);
            await this.openMembershipWith(manager, symbol, coinTier, changedAt);
        });
    }

    private async openMembershipWith(manager: EntityManager, symbol: string, coinTier: CoinTierEnum, enteredAt: Date): Promise<void> {
        const existing = await manager.findOne(UniverseMembershipEntity, { where: { symbol, leftAt: IsNull() } });

        if (existing !== null) {
            return;
        }

        await manager.save(manager.create(UniverseMembershipEntity, { symbol, coinTier, enteredAt, leftAt: null }));
    }

    private async closeOpenMembershipWith(manager: EntityManager, symbol: string, leftAt: Date): Promise<void> {
        await manager.update(UniverseMembershipEntity, { symbol, leftAt: IsNull() }, { leftAt });
    }
}
