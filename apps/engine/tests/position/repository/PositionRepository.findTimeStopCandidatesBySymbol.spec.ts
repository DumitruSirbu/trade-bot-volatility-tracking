/**
 * PositionRepository.findTimeStopCandidatesBySymbol — M33 Task 3a (GBT M1).
 *
 * This WHERE clause is the AUTHORITATIVE CLOSING-exclusion safety predicate for the time-stop
 * enforcer. The test pins the exact query-builder predicate so a regression cannot widen it to
 * include CLOSING/RECONCILING rows (which `findLiveRisk()` does) and re-introduce HIGH L1.
 *
 * Coverage: excludes CLOSING and qty=0 rows; includes OPEN/PENDING_OPEN with a non-null deadline.
 */

import { PositionStateEnum } from '@bot/shared';
import { Repository } from 'typeorm';

import { PositionEntity } from '../../../src/position/entity';
import { PositionRepository } from '../../../src/position/repository/PositionRepository';

// A minimal query-builder spy that records every where/andWhere predicate + bound params so the
// test can assert the safety predicate without a live Postgres connection.
function buildQueryBuilderSpy(rows: PositionEntity[]) {
    const calls: Array<{ clause: string; params?: Record<string, unknown> }> = [];

    const qb = {
        where(clause: string, params?: Record<string, unknown>) {
            calls.push({ clause, params });

            return qb;
        },
        andWhere(clause: string, params?: Record<string, unknown>) {
            calls.push({ clause, params });

            return qb;
        },
        getMany: jest.fn().mockResolvedValue(rows),
    };

    return { qb, calls };
}

function buildRepository(rows: PositionEntity[]) {
    const { qb, calls } = buildQueryBuilderSpy(rows);
    const typeormRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as Repository<PositionEntity>;
    const repository = new PositionRepository(typeormRepo);

    return { repository, calls, getMany: qb.getMany };
}

describe('PositionRepository.findTimeStopCandidatesBySymbol', () => {
    it('excludes CLOSING and qty=0 rows; includes OPEN/PENDING_OPEN with a non-null deadline', async () => {
        // BUILD: the DB returns only the eligible rows the predicate would match.
        const eligibleRows = [{ id: 1 } as PositionEntity, { id: 2 } as PositionEntity];
        const { repository, calls, getMany } = buildRepository(eligibleRows);

        // OPERATE
        const result = await repository.findTimeStopCandidatesBySymbol('BTCUSDT');

        // CHECK: returns exactly the rows the predicate matched.
        expect(result).toBe(eligibleRows);
        expect(getMany).toHaveBeenCalledTimes(1);

        // CHECK: symbol is bound (no string interpolation).
        expect(calls).toContainEqual({ clause: 'p.symbol = :symbol', params: { symbol: 'BTCUSDT' } });

        // CHECK: residual-qty guard excludes flat (qty=0) rows.
        expect(calls).toContainEqual({ clause: 'p.qty > 0', params: undefined });

        // CHECK: non-null deadline guard.
        expect(calls).toContainEqual({ clause: 'p.time_stop_at IS NOT NULL', params: undefined });

        // CHECK (the load-bearing safety predicate): the state set is EXACTLY {OPEN, PENDING_OPEN}.
        // CLOSING / RECONCILING / MANUAL_ADOPTED_UNMANAGED / CLOSED must NOT appear.
        const stateClause = calls.find((c) => c.clause.includes('p.state IN'));
        expect(stateClause).toBeDefined();

        const states = stateClause?.params?.states as PositionStateEnum[];
        expect(states).toEqual([PositionStateEnum.OPEN, PositionStateEnum.PENDING_OPEN]);
        expect(states).not.toContain(PositionStateEnum.CLOSING);
        expect(states).not.toContain(PositionStateEnum.CLOSED);
        expect(states).not.toContain(PositionStateEnum.RECONCILING);
    });
});
