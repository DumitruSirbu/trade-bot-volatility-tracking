import { CoinTierEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UniverseMembershipEntity } from '../../market-data/entity';

// Loads universe membership as it existed at a specific UTC date (point-in-time, no
// survivorship bias). A symbol is "in" at date T iff: entered_at <= T AND (left_at IS
// NULL OR left_at > T). The replay loop calls `resolveAt` at each day boundary so the
// candidate universe walks forward exactly the way live did.
@Injectable()
export class PointInTimeUniverse {
    constructor(@InjectRepository(UniverseMembershipEntity) private readonly repository: Repository<UniverseMembershipEntity>) {}

    // Returns the active symbol → tier map at the start of `utcDateString` (YYYY-MM-DD).
    // When a symbol has multiple open rows that overlap the timestamp (tier changes
    // close + open a fresh row), the most recently entered row wins — that's the row
    // representing the symbol's tier as of T.
    async resolveAt(utcDateString: string): Promise<Map<string, CoinTierEnum>> {
        const at = toUtcDayStart(utcDateString);

        const rows = await this.repository
            .createQueryBuilder('membership')
            .where('membership.entered_at <= :at', { at })
            .andWhere('(membership.left_at IS NULL OR membership.left_at > :at)', { at })
            .orderBy('membership.symbol', 'ASC')
            .addOrderBy('membership.entered_at', 'DESC')
            .getMany();

        const result = new Map<string, CoinTierEnum>();

        for (const row of rows) {

            if (!result.has(row.symbol)) {
                result.set(row.symbol, row.coinTier);
            }
        }

        return result;
    }

    // Returns the symbols active for ANY day in [fromUtcDate, toUtcDate) — used to
    // pre-load the candle set for the entire replay window. A symbol counts as active
    // if its membership row overlaps the window: entered_at < toAt AND (left_at IS NULL
    // OR left_at > fromAt).
    async resolveForWindow(fromUtcDate: string, toUtcDate: string): Promise<string[]> {
        const fromAt = toUtcDayStart(fromUtcDate);
        const toAt = toUtcDayStart(toUtcDate);

        const rows = await this.repository
            .createQueryBuilder('membership')
            .select('DISTINCT membership.symbol', 'symbol')
            .where('membership.entered_at < :toAt', { toAt })
            .andWhere('(membership.left_at IS NULL OR membership.left_at > :fromAt)', { fromAt })
            .orderBy('symbol', 'ASC')
            .getRawMany<{ symbol: string }>();

        return rows.map((row) => row.symbol);
    }
}

// Parses a `YYYY-MM-DD` calendar date as the UTC midnight Date for that day. Throws on
// malformed input — the replay config is validated at the boundary so a bad string here
// indicates a programmer bug, not a runtime data problem.
function toUtcDayStart(utcDateString: string): Date {
    const parsed = new Date(`${utcDateString}T00:00:00.000Z`);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid UTC date string: ${utcDateString}`);
    }

    return parsed;
}
