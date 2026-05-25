import { PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, DeepPartial, In, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm';

import { BaseRepository } from '../../common/repository/BaseRepository';
import { PositionEntity } from '../entity';
import { IPositionQuery } from '../interface';

// Reads/writes authoritative position state. No live writer until M3–M6; M2 ships the
// query surface later milestones need.
//
// Implements `IPositionQuery` — the minimal read-only port the risk gate consumes
// via the `POSITION_QUERY` token. The interface is structurally satisfied by
// `BaseRepository<T>.findById`; the explicit `implements` clause locks the
// contract so a future signature drift on `findById` breaks compilation here
// instead of silently breaking the gate.
@Injectable()
export class PositionRepository extends BaseRepository<PositionEntity> implements IPositionQuery {
    constructor(@InjectRepository(PositionEntity) repository: Repository<PositionEntity>) {
        super(repository);
    }

    async findOpen(): Promise<PositionEntity[]> {
        return this.repository.find({ where: { state: Not(PositionStateEnum.CLOSED) } });
    }

    async findOpenBySymbol(symbol: string): Promise<PositionEntity[]> {
        return this.repository.find({ where: { symbol, state: Not(PositionStateEnum.CLOSED) } });
    }

    // Slot-scoped lookup used by the ADD path: an ADD against the existing slot must target
    // that exact row — never an arbitrary `findOpenBySymbol(...)[0]`, which would pick the
    // wrong leg if two slots on the same symbol were ever open simultaneously.
    async findOpenBySymbolAndSlot(symbol: string, slot: PositionSlotEnum): Promise<PositionEntity | null> {
        return this.repository.findOne({ where: { symbol, positionSlot: slot, state: Not(PositionStateEnum.CLOSED) } });
    }

    // Closed positions whose realized PnL booked on the given UTC day (ADR 0004 §5: realized
    // PnL books to the CLOSE date). Ordered by closedAt for the consecutive-loss derivation.
    async findClosedOnUtcDay(dateString: string): Promise<PositionEntity[]> {
        const dayStart = new Date(`${dateString}T00:00:00.000Z`);
        const nextDay = new Date(dayStart.getTime());
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);

        return this.repository.find({
            where: { state: PositionStateEnum.CLOSED, closedAt: And(MoreThanOrEqual(dayStart), LessThan(nextDay)) },
            order: { closedAt: 'ASC' },
        });
    }

    // Most recently closed position on a symbol — drives the post-loss cooldown window.
    async findLastClosedBySymbol(symbol: string): Promise<PositionEntity | null> {
        return this.repository.findOne({
            where: { symbol, state: PositionStateEnum.CLOSED },
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

    // M9 W4 — cursor-paginated read of closed positions for `GET /v1/positions/closed`.
    // Cursor is the (closedAt, id) tuple of the previous page's tail row, monotonic
    // descending; nullable cursor returns the first page. The id tiebreaker handles
    // multiple closes within the same millisecond deterministically.
    async findClosedPage(cursor: { closedAt: Date; id: number } | null, pageSize: number): Promise<PositionEntity[]> {
        // M9 R2 wave B (Q8): explicit `closed_at IS NOT NULL` guard. A CLOSED
        // row without a closedAt would crash the (closed_at, id) cursor tuple
        // and the controller's nextCursor derivation. The state filter alone
        // does not enforce this — a legacy partial-close path could mark a row
        // CLOSED before stamping closedAt; we surface only fully-finalised rows.
        const qb = this.repository.createQueryBuilder('p').where('p.state = :state', { state: PositionStateEnum.CLOSED }).andWhere('p.closed_at IS NOT NULL');

        if (cursor !== null) {
            qb.andWhere('(p.closed_at, p.positions_id) < (:cursorTs, :cursorId)', {
                cursorTs: cursor.closedAt,
                cursorId: cursor.id,
            });
        }

        return qb.orderBy('p.closed_at', 'DESC').addOrderBy('p.positions_id', 'DESC').take(pageSize).getMany();
    }

    // M9 W4 — aggregate per-version performance over a trailing day window for
    // `GET /v1/performance/by-version`. Returns a SUM(realized_pnl), COUNT, win-count
    // tuple per strategy_version_id over CLOSED positions in [since, now].
    async aggregatePerformanceByVersion(since: Date): Promise<Array<{ strategyVersionId: number; tradeCount: number; winCount: number; netPnlUsd: string }>> {
        const rows = await this.repository
            .createQueryBuilder('p')
            .select('p.strategy_version_id', 'strategyVersionId')
            .addSelect('COUNT(*)', 'tradeCount')
            .addSelect('COUNT(*) FILTER (WHERE p.realized_pnl > 0)', 'winCount')
            .addSelect('COALESCE(SUM(p.realized_pnl), 0)', 'netPnlUsd')
            .where('p.state = :state', { state: PositionStateEnum.CLOSED })
            .andWhere('p.closed_at >= :since', { since })
            .groupBy('p.strategy_version_id')
            .getRawMany<{ strategyVersionId: string; tradeCount: string; winCount: string; netPnlUsd: string }>();

        return rows.map((row) => ({
            strategyVersionId: Number(row.strategyVersionId),
            tradeCount: Number(row.tradeCount),
            winCount: Number(row.winCount),
            netPnlUsd: String(row.netPnlUsd),
        }));
    }

    // M5: persist a fresh OPEN position from the entry-fill outcome. Returns the saved row
    // (with assigned id) so the executor can arm SL/TP + protection against the real positionId.
    async createOpen(entityLike: DeepPartial<PositionEntity>): Promise<PositionEntity> {
        const entity = this.create({ ...entityLike });

        return this.repository.save(entity);
    }

    // M6 R1.2.5 (ADR 0010 §1e + ADR 0009 §6.1). Conditional column-scoped UPDATE
    // for case-(e) PROTECTIVE_ORDER_DRIFT. The state guard in the WHERE clause
    // prevents the dual-write race ReconciliationService had with a concurrent
    // state transition: the prior `position.protectiveOrderType = ...; save(...)`
    // sequence read the row at top-of-runPass, mutated, then `save` issued a
    // full-row UPDATE that could clobber a concurrent state change. This UPDATE
    // touches only `protective_order_type` (one column) AND requires the row's
    // current state to still be in `acceptableStates` — Postgres atomically
    // matches the WHERE-row and updates the single column.
    //
    // Returns the affected-row count: 1 → mutation applied, 0 → row state moved
    // (caller logs + skips re-arm). Acceptable states for case-(e): the set the
    // reconciler considers "still alive and protected" — PENDING_OPEN / OPEN /
    // CLOSING. RECONCILING / MANUAL_ADOPTED_UNMANAGED / CLOSED block the update.
    async updateProtectiveOrderTypeIfState(
        positionId: number,
        nextType: ProtectiveOrderTypeEnum,
        acceptableStates: readonly PositionStateEnum[],
    ): Promise<number> {
        const result = await this.repository.update({ id: positionId, state: In(acceptableStates as PositionStateEnum[]) }, { protectiveOrderType: nextType });

        return result.affected ?? 0;
    }
}
