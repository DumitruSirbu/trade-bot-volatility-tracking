import { PositionStatusEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, LessThan, MoreThanOrEqual, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { PositionEntity } from '../entity';

// Reads/writes authoritative position state. No live writer until M3–M6; M2 ships the
// query surface later milestones need.
@Injectable()
export class PositionRepository extends BaseRepository<PositionEntity> {
    constructor(@InjectRepository(PositionEntity) repository: Repository<PositionEntity>) {
        super(repository);
    }

    async findOpen(): Promise<PositionEntity[]> {
        return this.repository.find({ where: { status: PositionStatusEnum.OPEN } });
    }

    async findOpenBySymbol(symbol: string): Promise<PositionEntity[]> {
        return this.repository.find({ where: { symbol, status: PositionStatusEnum.OPEN } });
    }

    // Closed positions whose realized PnL booked on the given UTC day (ADR 0004 §5: realized
    // PnL books to the CLOSE date). Ordered by closedAt for the consecutive-loss derivation.
    async findClosedOnUtcDay(dateString: string): Promise<PositionEntity[]> {
        const dayStart = new Date(`${dateString}T00:00:00.000Z`);
        const nextDay = new Date(dayStart.getTime());
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);

        return this.repository.find({
            where: { status: PositionStatusEnum.CLOSED, closedAt: And(MoreThanOrEqual(dayStart), LessThan(nextDay)) },
            order: { closedAt: 'ASC' },
        });
    }

    // Most recently closed position on a symbol — drives the post-loss cooldown window.
    async findLastClosedBySymbol(symbol: string): Promise<PositionEntity | null> {
        return this.repository.findOne({
            where: { symbol, status: PositionStatusEnum.CLOSED },
            order: { closedAt: 'DESC' },
        });
    }

    // Count of positions OPENED on the given UTC day for a symbol — the per-symbol/day
    // overtrading cap counts entries, not exits.
    async countOpenedOnUtcDayForSymbol(symbol: string, dateString: string): Promise<number> {
        const dayStart = new Date(`${dateString}T00:00:00.000Z`);
        const nextDay = new Date(dayStart.getTime());
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);

        return this.repository.count({
            where: { symbol, openedAt: And(MoreThanOrEqual(dayStart), LessThan(nextDay)) },
        });
    }
}
