/**
 * Unit tests for TickAggregateRepository.loadTicksForBar (M26 A1/A5).
 *
 * Surfaces under test (half-open window [barOpen, barOpen + CANDLE_5M_INTERVAL_MS)):
 *   T1 — A tick at exactly barOpen is included.
 *   T2 — A tick at barOpen + CANDLE_5M_INTERVAL_MS - 1000 ms is included.
 *   T3 — A tick at exactly barOpen + CANDLE_5M_INTERVAL_MS (next-bar first tick) is excluded.
 *   T4 — No ticks in window → returns [].
 *   T5 — Results are ordered ASC by ts (QueryBuilder uses orderBy ts ASC).
 *
 * No real DB, no real Postgres. The TypeORM Repository<TickAggregateEntity> and its
 * QueryBuilder chain are mocked with jest.fn() stubs following the engine project's
 * as-unknown cast pattern (see BacktestRunnerService.spec.ts, EngineBootstrapService.paper.spec.ts).
 */

import { Repository } from 'typeorm';

import { CANDLE_5M_INTERVAL_MS } from '../../const/candleConsts';
import { TickAggregateEntity } from '../../entity/TickAggregateEntity';
import { TickAggregateRepository } from '../TickAggregateRepository';

// ─── helpers ──────────────────────────────────────────────────────────────────

const BAR_OPEN_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
const SYMBOL = 'ETHUSDT';

function buildTick(tsMs: number, close = 30_000): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = tsMs;
    tick.ts = new Date(tsMs);
    tick.symbol = SYMBOL;
    // MoneyValue (Decimal) columns — cast via as unknown for the mock context.
    tick.open = { toFixed: () => String(close - 10) } as unknown as TickAggregateEntity['open'];
    tick.high = { toFixed: () => String(close + 20) } as unknown as TickAggregateEntity['high'];
    tick.low = { toFixed: () => String(close - 20) } as unknown as TickAggregateEntity['low'];
    tick.close = { toFixed: () => String(close) } as unknown as TickAggregateEntity['close'];
    tick.volume = { toFixed: () => '1000' } as unknown as TickAggregateEntity['volume'];

    return tick;
}

interface IQueryBuilderCaptured {
    whereCalls: Array<[string, Record<string, unknown>]>;
    andWhereCalls: Array<[string, Record<string, unknown>]>;
    orderByCalls: Array<[string, string]>;
    getManyMock: jest.Mock;
}

interface IBuiltRepository {
    repo: TickAggregateRepository;
    getManyMock: jest.Mock;
    whereCalls: Array<[string, Record<string, unknown>]>;
    andWhereCalls: Array<[string, Record<string, unknown>]>;
    orderByCalls: Array<[string, string]>;
}

// Builds a TickAggregateRepository backed by a QueryBuilder mock whose `getMany`
// returns the provided tick array. The `where` / `andWhere` / `orderBy` calls are
// captured so tests can inspect the query parameters.
function buildRepository(ticksToReturn: TickAggregateEntity[]): IBuiltRepository {
    const captured: IQueryBuilderCaptured = {
        whereCalls: [],
        andWhereCalls: [],
        orderByCalls: [],
        getManyMock: jest.fn().mockResolvedValue(ticksToReturn),
    };

    // Fluent QueryBuilder stub: every method returns `this` except `getMany`.
    // Typed as unknown to avoid the TS7022 self-referential initializer error
    // while keeping the jest mock fluent chain intact.
    const queryBuilderStub: unknown = {
        where: jest.fn((cond: string, params: Record<string, unknown>) => {
            captured.whereCalls.push([cond, params]);
            return queryBuilderStub;
        }),
        andWhere: jest.fn((cond: string, params: Record<string, unknown>) => {
            captured.andWhereCalls.push([cond, params]);
            return queryBuilderStub;
        }),
        orderBy: jest.fn((col: string, dir: string) => {
            captured.orderByCalls.push([col, dir]);
            return queryBuilderStub;
        }),
        getMany: captured.getManyMock,
    };

    const typeormRepository = {
        create: jest.fn((entity: unknown) => entity),
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilderStub),
    } as unknown as Repository<TickAggregateEntity>;

    const repo = new TickAggregateRepository(typeormRepository);

    return {
        repo,
        getManyMock: captured.getManyMock,
        whereCalls: captured.whereCalls,
        andWhereCalls: captured.andWhereCalls,
        orderByCalls: captured.orderByCalls,
    };
}

// ─── T1 — tick at exactly barOpen is included ─────────────────────────────────

describe('TickAggregateRepository.loadTicksForBar — T1: lower boundary tick at barOpen is included', () => {
    it('returns a tick whose ts equals barOpen (ts >= barOpen is inclusive)', async () => {
        const tickAtBarOpen = buildTick(BAR_OPEN_MS);
        const { repo, getManyMock, andWhereCalls } = buildRepository([tickAtBarOpen]);

        const result = await repo.loadTicksForBar(SYMBOL, BAR_OPEN_MS);

        expect(getManyMock).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].ts.getTime()).toBe(BAR_OPEN_MS);

        // Assert the lower-bound clause is >= (inclusive), not >
        const lowerBoundClause = andWhereCalls.find(([cond]) => cond.includes('>= :fromDate'));
        expect(lowerBoundClause).toBeDefined();
        expect(lowerBoundClause![1]['fromDate']).toEqual(new Date(BAR_OPEN_MS));
    });
});

// ─── T2 — tick at barOpen + 5m - 1s is included ───────────────────────────────

describe('TickAggregateRepository.loadTicksForBar — T2: tick 1 second before next bar open is included', () => {
    it('returns a tick at barOpen + CANDLE_5M_INTERVAL_MS - 1000 ms (last second of the bar)', async () => {
        const lastSecondOfBar = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS - 1_000;
        const tickNearEnd = buildTick(lastSecondOfBar);
        const { repo, getManyMock } = buildRepository([tickNearEnd]);

        const result = await repo.loadTicksForBar(SYMBOL, BAR_OPEN_MS);

        expect(getManyMock).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].ts.getTime()).toBe(lastSecondOfBar);
    });
});

// ─── T3 — tick at exactly barOpen + 5m is excluded ────────────────────────────

describe('TickAggregateRepository.loadTicksForBar — T3: next-bar first tick at barOpen + 5m is excluded', () => {
    it('upper-bound clause uses strict < (ts < toDate), so the next-bar open tick is never returned', async () => {
        const nextBarOpen = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
        const { repo, getManyMock, andWhereCalls } = buildRepository([]);

        await repo.loadTicksForBar(SYMBOL, BAR_OPEN_MS);

        expect(getManyMock).toHaveBeenCalledTimes(1);

        // The upper-bound clause must be strictly < (not <=)
        const upperBoundClause = andWhereCalls.find(([cond]) => cond.includes('< :toDate'));
        expect(upperBoundClause).toBeDefined();
        expect(upperBoundClause![1]['toDate']).toEqual(new Date(nextBarOpen));

        // No <= clause must be present — that would include the next bar's first tick
        const inclusiveUpperClause = andWhereCalls.find(([cond]) => cond.includes('<= :toDate'));
        expect(inclusiveUpperClause).toBeUndefined();
    });
});

// ─── T4 — empty result when no ticks fall in window ───────────────────────────

describe('TickAggregateRepository.loadTicksForBar — T4: empty window returns []', () => {
    it('returns an empty array when no tick_aggregates exist for the signal bar', async () => {
        const { repo, getManyMock } = buildRepository([]);

        const result = await repo.loadTicksForBar(SYMBOL, BAR_OPEN_MS);

        expect(getManyMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual([]);
    });
});

// ─── T5 — results ordered ASC by ts ───────────────────────────────────────────

describe('TickAggregateRepository.loadTicksForBar — T5: QueryBuilder orders results ASC by ts', () => {
    it('passes orderBy tick.ts ASC to the QueryBuilder so results arrive in chronological order', async () => {
        const { repo, orderByCalls } = buildRepository([]);

        await repo.loadTicksForBar(SYMBOL, BAR_OPEN_MS);

        expect(orderByCalls).toHaveLength(1);
        expect(orderByCalls[0][0]).toBe('tick.ts');
        expect(orderByCalls[0][1]).toBe('ASC');
    });
});

// ─── Adversarial: symbol filter is applied ────────────────────────────────────

describe('TickAggregateRepository.loadTicksForBar — adversarial: symbol predicate is included in query', () => {
    it('filters by symbol so ticks from a different symbol in the same bar window are excluded', async () => {
        const { repo, whereCalls } = buildRepository([]);

        await repo.loadTicksForBar('BTCUSDT', BAR_OPEN_MS);

        const symbolClause = whereCalls.find(([cond, params]) => cond.includes(':symbol') && params['symbol'] === 'BTCUSDT');
        expect(symbolClause).toBeDefined();
    });
});
