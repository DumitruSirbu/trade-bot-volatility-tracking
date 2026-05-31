// M11a W0.5 — ShadowDecisionRepository unit tests (paired with the W0.5
// dispatch). Drives the idempotent-insert path with a mocked TypeORM
// Repository so we can simulate the SQLSTATE 23505 unique-violation that the
// UNIQUE(shadow_version, event_id) index produces on replay — without
// depending on live Postgres. The integration counterpart (Postgres-backed
// migration roundtrip + true UNIQUE enforcement) will run alongside the
// existing strategy-module integration suite once the migration lands on
// CI's pg fixture.

import { QueryFailedError, Repository } from 'typeorm';

import { POSTGRES_UNIQUE_VIOLATION_SQLSTATE } from '../../../src/common/const';
import { ShadowDecisionEntity } from '../../../src/strategy/entity';
import { ShadowDecisionRepository } from '../../../src/strategy/repository/ShadowDecisionRepository';

function buildRow(overrides: Partial<ShadowDecisionEntity> = {}): Partial<ShadowDecisionEntity> {
    return {
        shadowVersion: 'v2',
        eventId: 'evt-1',
        strategyVersionId: 3,
        symbol: 'BTCUSDT',
        action: 'open',
        rejectReason: null,
        gateAllowed: true,
        virtualSlotStateSnapshot: {
            riskDayUtcDate: '2026-05-30',
            openPositions: [],
            haltedUntilRiskDayUtcDate: null,
            lastEventIdProcessed: '',
        },
        simulatedFill: null,
        marketSnapshot: {} as ShadowDecisionEntity['marketSnapshot'],
        ...overrides,
    };
}

// Build a QueryFailedError whose `driverError.code` mirrors the Postgres
// `unique_violation` SQLSTATE the production catch path detects.
function buildUniqueViolationError(): QueryFailedError {
    const error = new QueryFailedError('insert', [], new Error('duplicate'));
    (error as unknown as { driverError: { code: string } }).driverError = { code: POSTGRES_UNIQUE_VIOLATION_SQLSTATE };

    return error;
}

function buildOtherDbError(): QueryFailedError {
    const error = new QueryFailedError('insert', [], new Error('connection lost'));
    (error as unknown as { driverError: { code: string } }).driverError = { code: '08006' };

    return error;
}

interface IRepoMock {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
}

function buildRepoMock(): IRepoMock {
    return {
        create: jest.fn((entityLike: Partial<ShadowDecisionEntity>) => entityLike as ShadowDecisionEntity),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
}

describe('ShadowDecisionRepository — insertShadowDecision', () => {
    it('persists a fresh row on the happy path (no unique-violation, save returns saved row)', async () => {
        const repoMock = buildRepoMock();
        const saved = { ...buildRow(), id: 1 } as ShadowDecisionEntity;
        repoMock.save.mockResolvedValueOnce(saved);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        const result = await repo.insertShadowDecision(buildRow());

        expect(result).toBe(saved);
        expect(repoMock.save).toHaveBeenCalledTimes(1);
        expect(repoMock.findOne).not.toHaveBeenCalled();
    });

    it('returns the existing row on SQLSTATE 23505 unique-violation (idempotent replay)', async () => {
        const repoMock = buildRepoMock();
        const existing = { ...buildRow(), id: 7 } as ShadowDecisionEntity;
        repoMock.save.mockRejectedValueOnce(buildUniqueViolationError());
        repoMock.findOne.mockResolvedValueOnce(existing);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        const result = await repo.insertShadowDecision(buildRow({ shadowVersion: 'v2', eventId: 'evt-1' }));

        expect(result).toBe(existing);
        expect(repoMock.findOne).toHaveBeenCalledWith({ where: { shadowVersion: 'v2', eventId: 'evt-1' } });
    });

    it('rethrows non-unique-violation DB errors (does NOT swallow them)', async () => {
        const repoMock = buildRepoMock();
        const other = buildOtherDbError();
        repoMock.save.mockRejectedValueOnce(other);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        await expect(repo.insertShadowDecision(buildRow())).rejects.toBe(other);
        expect(repoMock.findOne).not.toHaveBeenCalled();
    });

    it('rethrows on race: unique-violation but no existing row found on lookup', async () => {
        const repoMock = buildRepoMock();
        const violation = buildUniqueViolationError();
        repoMock.save.mockRejectedValueOnce(violation);
        repoMock.findOne.mockResolvedValueOnce(null);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        await expect(repo.insertShadowDecision(buildRow())).rejects.toBe(violation);
    });
});

describe('ShadowDecisionRepository — read methods', () => {
    it('findRowsForLedgerRebuild reads rows for a single shadowVersion ordered by eventId ASC', async () => {
        // W5b FIX 4: replay order is the eventId cursor (ADR 0029 §2.1.2),
        // not createdAt — two events sharing a creation second must replay
        // deterministically in eventId order.
        const repoMock = buildRepoMock();
        const rows: ShadowDecisionEntity[] = [{ ...buildRow(), id: 1 } as ShadowDecisionEntity];
        repoMock.find.mockResolvedValueOnce(rows);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        const result = await repo.findRowsForLedgerRebuild('v2');

        expect(result).toBe(rows);
        expect(repoMock.find).toHaveBeenCalledWith({ where: { shadowVersion: 'v2' }, order: { eventId: 'ASC' } });
    });

    it('findByShadowVersionSince builds a query bounded by shadowVersion + createdAt and ordered by eventId ASC', async () => {
        // W5b FIX 4: TypeORM QueryBuilder uses entity property names (camelCase),
        // not DB column names (snake_case). Asserting raw column names like
        // `row.shadow_version` silently fails to filter — the test must pin
        // the entity-property surface.
        const repoMock = buildRepoMock();
        const rows: ShadowDecisionEntity[] = [];
        const qb = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValueOnce(rows),
        };
        repoMock.createQueryBuilder.mockReturnValueOnce(qb);
        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        const result = await repo.findByShadowVersionSince('v3', 1_700_000_000_000);

        expect(result).toBe(rows);
        expect(qb.where).toHaveBeenCalledWith('sd.shadowVersion = :shadowVersion', { shadowVersion: 'v3' });
        expect(qb.andWhere).toHaveBeenCalledWith('sd.createdAt >= :sinceDate', { sinceDate: new Date(1_700_000_000_000) });
        expect(qb.orderBy).toHaveBeenCalledWith('sd.eventId', 'ASC');
    });
});
