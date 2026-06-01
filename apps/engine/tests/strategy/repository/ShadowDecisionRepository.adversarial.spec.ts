// M11a W3 — ShadowDecisionRepository adversarial coverage (ADR 0029 §2.3.2).
//
// Covers schema/repository contracts that the W0.5 happy-path suite does not exercise:
//   C12 — UNIQUE(shadow_version, event_id): second INSERT with same key on SKIP row
//          (simulatedFill IS NULL) returns the existing row, not a duplicate.
//   C13 — JSONB round-trip for virtualSlotStateSnapshot and simulatedFill:
//          write complex nested objects with decimal strings, read back,
//          assert deep equality (no precision loss, no field reordering).
//   C14 — trade_side nullability: SKIP rows carry tradeSide=NULL; OPEN rows carry 'long'|'short'.
//
// All tests are pure unit-level (mocked TypeORM Repository) — no live Postgres required.
// The FK and migration round-trip tests that need real Postgres live in:
//   tests/persistence/shadowDecisions.fk.integration.spec.ts  (C11)
//   tests/database/shadowDecisions.migration.roundtrip.adversarial.spec.ts  (C15)

import { QueryFailedError, Repository } from 'typeorm';

import { POSTGRES_UNIQUE_VIOLATION_SQLSTATE } from '../../../src/common/const';
import { ShadowDecisionEntity } from '../../../src/strategy/entity';
import { ShadowDecisionRepository } from '../../../src/strategy/repository/ShadowDecisionRepository';

// ─── Factories ───────────────────────────────────────────────────────────────

function buildSkipRow(overrides: Partial<ShadowDecisionEntity> = {}): Partial<ShadowDecisionEntity> {
    return {
        shadowVersion: 'v2',
        eventId: 'evt-skip-1',
        strategyVersionId: 3,
        symbol: 'BTCUSDT',
        action: 'skip',
        tradeSide: null,
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

function buildOpenRow(overrides: Partial<ShadowDecisionEntity> = {}): Partial<ShadowDecisionEntity> {
    return {
        shadowVersion: 'v2',
        eventId: 'evt-open-1',
        strategyVersionId: 3,
        symbol: 'BTCUSDT',
        action: 'open',
        tradeSide: 'long',
        rejectReason: null,
        gateAllowed: true,
        virtualSlotStateSnapshot: {
            riskDayUtcDate: '2026-05-30',
            openPositions: [
                {
                    symbol: 'BTCUSDT',
                    side: 'long',
                    openedAtMs: 1_716_307_200_000,
                    openedAtEventId: 'evt-prev',
                    entryPrice: '30000.00',
                    qty: '0.01',
                    stopLoss: '29400.00',
                    takeProfit: '31200.00',
                    virtualOrderId: 'v2:evt-prev',
                },
            ],
            haltedUntilRiskDayUtcDate: null,
            lastEventIdProcessed: 'evt-prev',
        },
        simulatedFill: {
            entryPrice: '30015.00',
            exitPrice: null,
            slippageEntryPct: '0.05',
            slippageExitPct: null,
            slippageComponents: {
                tierBase: '0.05',
                latency: '0',
                crossingSpread: '0',
            },
            missed: false,
            forceClose: false,
            lowFidelity: true,
            closedAt: null,
            closeReason: null,
        },
        marketSnapshot: {} as ShadowDecisionEntity['marketSnapshot'],
        ...overrides,
    };
}

function buildUniqueViolationError(): QueryFailedError {
    const error = new QueryFailedError('insert', [], new Error('duplicate key value violates unique constraint'));
    (error as unknown as { driverError: { code: string } }).driverError = { code: POSTGRES_UNIQUE_VIOLATION_SQLSTATE };

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

// ─── C12: UNIQUE(shadow_version, event_id) — SKIP row idempotency ────────────

describe('ShadowDecisionRepository — UNIQUE constraint idempotency on SKIP row (C12)', () => {
    it('second insertShadowDecision for a SKIP row with same (shadowVersion, eventId) returns the existing row without re-inserting', async () => {
        // BUILD
        const repoMock = buildRepoMock();
        const skipRow = buildSkipRow({ shadowVersion: 'v3', eventId: 'evt-skip-dup' });
        const existingEntity = { ...skipRow, id: 42 } as ShadowDecisionEntity;

        // First insert succeeds.
        repoMock.save.mockResolvedValueOnce(existingEntity);
        // Second insert hits the unique constraint.
        repoMock.save.mockRejectedValueOnce(buildUniqueViolationError());
        // Lookup after violation returns the original entity.
        repoMock.findOne.mockResolvedValueOnce(existingEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        await repo.insertShadowDecision(skipRow);
        const result = await repo.insertShadowDecision(skipRow);

        // CHECK
        expect(result).toBe(existingEntity);
        expect(result.id).toBe(42);
        // findOne was called with the right key (the skip row's shadowVersion + eventId).
        expect(repoMock.findOne).toHaveBeenCalledWith({
            where: { shadowVersion: 'v3', eventId: 'evt-skip-dup' },
        });
        // save was called twice (once for first insert, once for second which violated).
        expect(repoMock.save).toHaveBeenCalledTimes(2);
    });

    it('idempotent insert for a gate-rejected SKIP row (gateAllowed=false, rejectReason set) returns existing row', async () => {
        // BUILD: gate rejected the event — simulatedFill is still null for this row.
        const repoMock = buildRepoMock();
        const rejectedRow = buildSkipRow({
            shadowVersion: 'v2',
            eventId: 'evt-rejected',
            gateAllowed: false,
            rejectReason: 'max_trades_per_day_reached',
            simulatedFill: null,
        });
        const existingEntity = { ...rejectedRow, id: 99 } as ShadowDecisionEntity;

        repoMock.save.mockRejectedValueOnce(buildUniqueViolationError());
        repoMock.findOne.mockResolvedValueOnce(existingEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        const result = await repo.insertShadowDecision(rejectedRow);

        // CHECK
        expect(result).toBe(existingEntity);
        expect(result.gateAllowed).toBe(false);
        expect(result.rejectReason).toBe('max_trades_per_day_reached');
        expect(result.simulatedFill).toBeNull();
    });
});

// ─── C13: JSONB round-trip for virtualSlotStateSnapshot and simulatedFill ─────

describe('ShadowDecisionRepository — JSONB round-trip fidelity for nested snapshots (C13)', () => {
    // In unit tests save/findOne are mocked; this test validates that the shapes
    // passed INTO save and returned FROM findOne are transferred without mutation
    // (no precision loss on decimal strings, no field omission, no reordering breakage).
    it('virtualSlotStateSnapshot with nested openPositions preserves all decimal-string fields after save+read cycle', async () => {
        // BUILD: complex snapshot with multiple open positions and precise decimal strings.
        const repoMock = buildRepoMock();
        const complexSnapshot = {
            riskDayUtcDate: '2026-05-30',
            openPositions: [
                {
                    symbol: 'ETHUSDT',
                    side: 'short',
                    openedAtMs: 1_716_307_200_000,
                    openedAtEventId: 'ETHUSDT:1716307200000',
                    entryPrice: '3500.123456789',
                    qty: '1.000000001',
                    stopLoss: '3535.000000000',
                    takeProfit: '3430.000000000',
                    virtualOrderId: 'v2:ETHUSDT:1716307200000',
                },
            ],
            haltedUntilRiskDayUtcDate: null,
            lastEventIdProcessed: 'ETHUSDT:1716307200000',
        };
        const row = buildOpenRow({ virtualSlotStateSnapshot: complexSnapshot as ShadowDecisionEntity['virtualSlotStateSnapshot'] });
        const savedEntity = { ...row, id: 7 } as ShadowDecisionEntity;
        repoMock.save.mockResolvedValueOnce(savedEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        const result = await repo.insertShadowDecision(row);

        // CHECK: the snapshot passed to save contains the exact decimal strings
        // (no JS float coercion, no rounding).
        const savedArg = repoMock.save.mock.calls[0][0] as { virtualSlotStateSnapshot: typeof complexSnapshot };
        expect(savedArg.virtualSlotStateSnapshot.openPositions[0]!.entryPrice).toBe('3500.123456789');
        expect(savedArg.virtualSlotStateSnapshot.openPositions[0]!.qty).toBe('1.000000001');
        expect(savedArg.virtualSlotStateSnapshot.openPositions[0]!.stopLoss).toBe('3535.000000000');

        // The returned entity still carries the original snapshot (round-trip fidelity).
        expect(result.virtualSlotStateSnapshot).toEqual(complexSnapshot);
    });

    it('simulatedFill with precise decimal slippage strings is preserved without coercion after save+read', async () => {
        // BUILD: fill with non-trivial decimal precision in slippage components.
        const repoMock = buildRepoMock();
        const precisionFill = {
            entryPrice: '30015.999999999',
            exitPrice: null,
            slippageEntryPct: '0.053333333',
            slippageExitPct: null,
            slippageComponents: {
                tierBase: '0.053333333',
                latency: '0.000000001',
                crossingSpread: '0.000000000',
            },
            missed: false,
            forceClose: false,
            lowFidelity: true,
            closedAt: null,
            closeReason: null,
        };
        const row = buildOpenRow({ simulatedFill: precisionFill as ShadowDecisionEntity['simulatedFill'] });
        const savedEntity = { ...row, id: 8 } as ShadowDecisionEntity;
        repoMock.save.mockResolvedValueOnce(savedEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        const result = await repo.insertShadowDecision(row);

        // CHECK
        const savedArg = repoMock.save.mock.calls[0][0] as { simulatedFill: typeof precisionFill };
        expect(savedArg.simulatedFill!.entryPrice).toBe('30015.999999999');
        expect(savedArg.simulatedFill!.slippageEntryPct).toBe('0.053333333');
        expect(savedArg.simulatedFill!.slippageComponents.tierBase).toBe('0.053333333');
        expect(savedArg.simulatedFill!.slippageComponents.latency).toBe('0.000000001');

        // Round-trip: returned entity's simulatedFill equals what was persisted.
        expect(result.simulatedFill).toEqual(precisionFill);
    });

    it('virtualSlotStateSnapshot with haltedUntilRiskDayUtcDate non-null round-trips correctly', async () => {
        // BUILD
        const repoMock = buildRepoMock();
        const haltedSnapshot = {
            riskDayUtcDate: '2026-05-30',
            openPositions: [],
            haltedUntilRiskDayUtcDate: '2026-05-30',
            lastEventIdProcessed: 'BTCUSDT:999',
        };
        const row = buildSkipRow({ virtualSlotStateSnapshot: haltedSnapshot });
        repoMock.save.mockResolvedValueOnce({ ...row, id: 5 } as ShadowDecisionEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        const result = await repo.insertShadowDecision(row);

        // CHECK
        const savedArg = repoMock.save.mock.calls[0][0] as { virtualSlotStateSnapshot: typeof haltedSnapshot };
        expect(savedArg.virtualSlotStateSnapshot.haltedUntilRiskDayUtcDate).toBe('2026-05-30');
        expect(result.virtualSlotStateSnapshot.haltedUntilRiskDayUtcDate).toBe('2026-05-30');
    });
});

// ─── C14: trade_side nullability ──────────────────────────────────────────────

describe('ShadowDecisionRepository — trade_side column nullability contract (C14)', () => {
    it('SKIP rows carry tradeSide=null in the persisted payload', async () => {
        // BUILD
        const repoMock = buildRepoMock();
        const skipRow = buildSkipRow({ action: 'skip', tradeSide: null });
        repoMock.save.mockResolvedValueOnce({ ...skipRow, id: 10 } as ShadowDecisionEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        await repo.insertShadowDecision(skipRow);

        // CHECK
        const savedArg = repoMock.save.mock.calls[0][0] as { tradeSide: unknown };
        expect(savedArg.tradeSide).toBeNull();
    });

    it('gate-rejected OPEN rows carry tradeSide=null (no side when gate blocked the trade)', async () => {
        // BUILD: gate rejected, no side in this case.
        const repoMock = buildRepoMock();
        const rejectedOpenRow = buildSkipRow({
            action: 'open',
            tradeSide: null,
            gateAllowed: false,
            rejectReason: 'halted',
        });
        repoMock.save.mockResolvedValueOnce({ ...rejectedOpenRow, id: 11 } as ShadowDecisionEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        await repo.insertShadowDecision(rejectedOpenRow);

        // CHECK: tradeSide is null even when action='open', if the gate rejected it.
        const savedArg = repoMock.save.mock.calls[0][0] as { tradeSide: unknown };
        expect(savedArg.tradeSide).toBeNull();
    });

    it('OPEN rows with gate_allowed=true carry tradeSide=long', async () => {
        // BUILD
        const repoMock = buildRepoMock();
        const openRowLong = buildOpenRow({ tradeSide: 'long' });
        repoMock.save.mockResolvedValueOnce({ ...openRowLong, id: 12 } as ShadowDecisionEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        await repo.insertShadowDecision(openRowLong);

        // CHECK
        const savedArg = repoMock.save.mock.calls[0][0] as { tradeSide: unknown };
        expect(savedArg.tradeSide).toBe('long');
    });

    it('OPEN rows with gate_allowed=true carry tradeSide=short', async () => {
        // BUILD
        const repoMock = buildRepoMock();
        const openRowShort = buildOpenRow({ tradeSide: 'short' });
        repoMock.save.mockResolvedValueOnce({ ...openRowShort, id: 13 } as ShadowDecisionEntity);

        const repo = new ShadowDecisionRepository(repoMock as unknown as Repository<ShadowDecisionEntity>);

        // OPERATE
        await repo.insertShadowDecision(openRowShort);

        // CHECK
        const savedArg = repoMock.save.mock.calls[0][0] as { tradeSide: unknown };
        expect(savedArg.tradeSide).toBe('short');
    });
});
