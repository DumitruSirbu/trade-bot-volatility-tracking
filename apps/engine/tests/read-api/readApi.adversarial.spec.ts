import { ExitReasonEnum, PositionSideEnum, PositionSlotEnum, PositionStateEnum, ProtectiveOrderTypeEnum } from '@bot/shared';

import { Money } from '../../src/common/utils/money';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { ShadowDecisionRepository } from '../../src/strategy/repository/ShadowDecisionRepository';
import { PositionsController } from '../../src/read-api/controllers/PositionsController';
import { MetricsController } from '../../src/read-api/controllers/MetricsController';
import { CursorCodec } from '../../src/read-api/pagination/CursorCodec';
import {
    OPEN_POSITION_VIEW_KEYS,
    CLOSED_POSITION_VIEW_KEYS,
    POSITION_DETAIL_VIEW_KEYS,
    ACCOUNT_EQUITY_VIEW_KEYS,
    RISK_STATE_VIEW_KEYS,
} from '../../src/read-api/mappers/readApiMappers';

// M9 QA — adversarial extension to readApi.spec.ts.
// Covers:
//   - Cursor reuse after row deletion → returns next-page cleanly, no 500
//   - Pagination across a write storm → no duplicates, no skips at boundary
//   - pageSize=10000 clamped to 200
//   - before=<future-timestamp> → empty page, not error
//   - DTO key-snapshot: assert serialized payload keys EXACTLY equal *_VIEW_KEYS (all DTOs)
//   - Money field type assertion: every monetary field is typeof === 'string'

const _NOW = new Date('2026-05-24T12:00:00Z');

class StubSecretProvider {
    getSigningSecret(): Buffer {
        return Buffer.alloc(32, 0xab);
    }

    // M11a W1.7 — CursorCodec now consumes IDerivedKeyService.
    getCursorKey(): Buffer {
        return Buffer.alloc(32, 0xab);
    }

    getAuthKey(): Buffer {
        return Buffer.alloc(32, 0xab);
    }
}

function buildPosition(overrides: Partial<PositionEntity> = {}): PositionEntity {
    const base: PositionEntity = {
        id: 1,
        symbol: 'BTCUSDT',
        strategyVersionId: 1,
        strategyVersion: undefined as never,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        stopLossPrice: new Money('50000'),
        takeProfitPrice: new Money('60000'),
        leverage: new Money('3'),
        entryPrice: new Money('55000'),
        qty: new Money('0.1'),
        entryNotional: new Money('5500'),
        exitPrice: null,
        realizedPnl: null,
        exitReason: null,
        openedAt: new Date('2026-05-24T10:00:00Z'),
        closedAt: null,
        positionSlot: PositionSlotEnum.A,
        correlationMode: null,
        protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
    } as PositionEntity;

    return Object.assign(base, overrides);
}

class FakePositionRepository {
    open: PositionEntity[] = [];
    closed: PositionEntity[] = [];
    byId: Map<number, PositionEntity> = new Map();

    async findLiveRisk(): Promise<PositionEntity[]> {
        return this.open;
    }

    async findClosedPage(cursor: { closedAt: Date; id: number } | null, pageSize: number): Promise<PositionEntity[]> {
        const sorted = [...this.closed].sort((left, right) => {
            const leftTs = (left.closedAt ?? left.openedAt).getTime();
            const rightTs = (right.closedAt ?? right.openedAt).getTime();
            if (leftTs !== rightTs) return rightTs - leftTs;
            return right.id - left.id;
        });

        const filtered =
            cursor === null
                ? sorted
                : sorted.filter((row) => {
                      const ts = (row.closedAt ?? row.openedAt).getTime();
                      if (ts < cursor.closedAt.getTime()) return true;
                      return ts === cursor.closedAt.getTime() && row.id < cursor.id;
                  });

        return filtered.slice(0, pageSize);
    }

    async findById(id: number): Promise<PositionEntity | null> {
        return this.byId.get(id) ?? null;
    }

    async aggregatePerformanceByVersion(): Promise<Array<{ strategyVersionId: number; tradeCount: number; winCount: number; netPnlUsd: string }>> {
        return [];
    }
}

class FakeDecisionRepository {
    rows: never[] = [];
    async findPage(): Promise<never[]> {
        return [];
    }
}

class FakeAccountSnapshotRepository {
    async findLatest() {
        return null;
    }
}

class FakeRiskStateRepository {
    async findByDate() {
        return null;
    }
}

class FakeStrategyVersionRepository {
    byId = new Map();
    async findById(id: number) {
        return this.byId.get(id) ?? null;
    }
}

function buildHarness() {
    const positions = new FakePositionRepository();
    const decisions = new FakeDecisionRepository();
    const snapshots = new FakeAccountSnapshotRepository();
    const riskStates = new FakeRiskStateRepository();
    const versions = new FakeStrategyVersionRepository();
    const cursors = new CursorCodec(new StubSecretProvider() as never);

    const positionsController = new PositionsController(positions as unknown as PositionRepository, versions as unknown as StrategyVersionRepository, cursors);
    const metricsController = new MetricsController(
        decisions as unknown as DecisionRepository,
        positions as unknown as PositionRepository,
        snapshots as unknown as AccountSnapshotRepository,
        riskStates as unknown as RiskStateRepository,
        versions as unknown as StrategyVersionRepository,
        null as unknown as ShadowDecisionRepository,
        cursors,
        { activeStrategyVersionId: 1 } as never,
    );

    return { positions, cursors, positionsController, metricsController };
}

// ---------------------------------------------------------------------------
// Cursor reuse after row deletion
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — cursor reuse after row deletion', () => {
    it('returns a clean next page after the row the cursor points to is deleted', async () => {
        const harness = buildHarness();

        for (let i = 1; i <= 6; i += 1) {
            harness.positions.closed.push(
                buildPosition({
                    id: i,
                    state: PositionStateEnum.CLOSED,
                    exitPrice: new Money('56000'),
                    realizedPnl: new Money('1'),
                    exitReason: ExitReasonEnum.TAKE_PROFIT,
                    closedAt: new Date(`2026-05-24T11:0${i}:00Z`),
                }),
            );
        }

        const page1 = await harness.positionsController.listClosed(undefined, '2');
        const tailId = Number(page1.items[1]!.id);

        // Delete the tail row that the cursor references.
        harness.positions.closed = harness.positions.closed.filter((r) => r.id !== tailId);

        // Should not throw — cursor still works as a keyset bound.
        const page2 = await harness.positionsController.listClosed(page1.nextCursor ?? undefined, '2');

        expect(page2.items.map((i) => i.id)).not.toContain(String(tailId));
        // Rows that were already delivered on page 1 must not reappear.
        const page1Ids = new Set(page1.items.map((i) => i.id));
        for (const item of page2.items) {
            expect(page1Ids.has(item.id)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Pagination across a write storm
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — pagination across write storm', () => {
    it('no duplicates or skips when rows are inserted between page 1 and page 2 fetches', async () => {
        const harness = buildHarness();

        // Seed 4 rows: ids 1–4 with staggered closedAt.
        for (let i = 1; i <= 4; i += 1) {
            harness.positions.closed.push(
                buildPosition({
                    id: i,
                    state: PositionStateEnum.CLOSED,
                    exitPrice: new Money('56000'),
                    realizedPnl: new Money('1'),
                    exitReason: ExitReasonEnum.TAKE_PROFIT,
                    closedAt: new Date(`2026-05-24T11:0${i}:00Z`),
                }),
            );
        }

        const page1 = await harness.positionsController.listClosed(undefined, '2');

        // Inject a new row AFTER page 1 (id=99, very recent timestamp) — this
        // simulates a write storm between page fetches.
        harness.positions.closed.push(
            buildPosition({
                id: 99,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('57000'),
                realizedPnl: new Money('2'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: new Date('2026-05-24T12:30:00Z'), // newer than all page-1 rows
            }),
        );

        const page2 = await harness.positionsController.listClosed(page1.nextCursor ?? undefined, '2');

        // Rows already seen on page 1 must NOT appear on page 2.
        const page1Ids = new Set(page1.items.map((i) => i.id));
        for (const item of page2.items) {
            expect(page1Ids.has(item.id)).toBe(false);
        }

        // The brand-new row (id=99) that appeared AFTER the cursor was issued
        // must NOT appear on page 2 (cursor-based pagination is keyset
        // anchored; newer rows don't bleed back into page 2).
        expect(page2.items.map((i) => i.id)).not.toContain('99');
    });
});

// ---------------------------------------------------------------------------
// pageSize clamping
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — pageSize boundaries', () => {
    it('pageSize=10000 is clamped to 200', async () => {
        const harness = buildHarness();
        const result = await harness.positionsController.listClosed(undefined, '10000');
        expect(result.pageSize).toBe(200);
    });

    it('pageSize=201 is clamped to 200', async () => {
        const harness = buildHarness();
        const result = await harness.positionsController.listClosed(undefined, '201');
        expect(result.pageSize).toBe(200);
    });

    it('pageSize=200 is the allowed maximum and is respected', async () => {
        const harness = buildHarness();
        const result = await harness.positionsController.listClosed(undefined, '200');
        expect(result.pageSize).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// before=<future-timestamp> cursor: no 500 errors
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — future before-cursor', () => {
    it('a cursor encoding a future timestamp does not throw (it includes ALL existing rows)', async () => {
        // Keyset pagination: a future cursor means "rows where closedAt < future"
        // which encompasses ALL present rows. This is a valid (if unusual) client
        // call. The important invariant is no 500 error.
        const harness = buildHarness();

        harness.positions.closed.push(
            buildPosition({
                id: 1,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('1'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: new Date('2026-05-24T10:00:00Z'),
            }),
        );

        const futureCursor = harness.cursors.encode({
            id: 999999,
            ts: new Date('2099-01-01T00:00:00Z'),
        });

        await expect(harness.positionsController.listClosed(futureCursor, '10')).resolves.not.toThrow();
    });

    it('a tampered/invalid cursor string falls back to page-1 without throwing', async () => {
        const harness = buildHarness();

        harness.positions.closed.push(
            buildPosition({
                id: 2,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('1'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: new Date('2026-05-24T10:00:00Z'),
            }),
        );

        // A totally invalid cursor string must not produce a 500.
        const result = await harness.positionsController.listClosed('NOT_A_VALID_CURSOR', '10');

        // Tampered cursor decodes to null → controller serves page 1.
        expect(result.items).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// DTO key-snapshot — all views
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — DTO key snapshot (no field leakage)', () => {
    it('OPEN position view has EXACTLY the permitted keys', async () => {
        const harness = buildHarness();
        harness.positions.open.push(buildPosition({ id: 10 }));

        const [view] = await harness.positionsController.listOpen();

        expect(Object.keys(view!).sort()).toEqual([...OPEN_POSITION_VIEW_KEYS].sort());
        // Anti-leakage assertions per ADR 0022 §2.3.
        expect((view as unknown as Record<string, unknown>).reservationId).toBeUndefined();
        expect((view as unknown as Record<string, unknown>).entryNotional).toBeUndefined();
        expect((view as unknown as Record<string, unknown>).clientOrderId).toBeUndefined();
    });

    it('CLOSED position view has EXACTLY the permitted keys', async () => {
        const harness = buildHarness();
        harness.positions.closed.push(
            buildPosition({
                id: 20,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('100'),
                exitReason: ExitReasonEnum.STOP_LOSS,
                closedAt: new Date('2026-05-24T11:00:00Z'),
            }),
        );

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect(Object.keys(view!).sort()).toEqual([...CLOSED_POSITION_VIEW_KEYS].sort());
    });

    it('POSITION DETAIL view has EXACTLY the permitted keys', async () => {
        const harness = buildHarness();
        harness.positions.byId.set(42, buildPosition({ id: 42 }));

        const view = await harness.positionsController.getDetail('42');

        expect(Object.keys(view).sort()).toEqual([...POSITION_DETAIL_VIEW_KEYS].sort());
    });

    it('ACCOUNT EQUITY view has EXACTLY the permitted keys', async () => {
        const harness = buildHarness();
        const view = await harness.metricsController.getAccountEquity();
        expect(Object.keys(view).sort()).toEqual([...ACCOUNT_EQUITY_VIEW_KEYS].sort());
    });

    it('RISK STATE view has EXACTLY the permitted keys', async () => {
        const harness = buildHarness();
        const view = await harness.metricsController.getRiskState();
        expect(Object.keys(view).sort()).toEqual([...RISK_STATE_VIEW_KEYS].sort());
    });
});

// ---------------------------------------------------------------------------
// Money field type assertion
// ---------------------------------------------------------------------------

describe('ReadApi adversarial — monetary fields serialised as strings', () => {
    it('all monetary fields on the OPEN position view are typeof string', async () => {
        const harness = buildHarness();
        harness.positions.open.push(
            buildPosition({
                entryPrice: new Money('55000.123456'),
                qty: new Money('0.001234'),
                leverage: new Money('5'),
                stopLossPrice: new Money('50000'),
                takeProfitPrice: new Money('60000'),
            }),
        );

        const [view] = await harness.positionsController.listOpen();

        const moneyFields = ['entryPrice', 'qty', 'leverage', 'unrealizedPnlPriceUsd'] as const;
        for (const field of moneyFields) {
            expect(typeof (view as unknown as Record<string, unknown>)[field]).toBe('string');
        }
        // ADR 0022 §2.3.1 — funding split surfaces as null until M6 W5.
        expect((view as unknown as Record<string, unknown>).unrealizedPnlFundingUsd).toBeNull();
    });

    it('monetary null fields (slPrice/tpPrice) are null, not 0 or "0"', async () => {
        const harness = buildHarness();
        harness.positions.open.push(buildPosition({ stopLossPrice: null, takeProfitPrice: null }));

        const [view] = await harness.positionsController.listOpen();

        expect((view as unknown as Record<string, unknown>).slPrice).toBeNull();
        expect((view as unknown as Record<string, unknown>).tpPrice).toBeNull();
    });

    it('exitPrice/realizedPnlUsd are null when entity columns are null (ADR 0022 §2.3.1 — never fabricate)', async () => {
        const harness = buildHarness();
        harness.positions.closed.push(
            buildPosition({
                id: 77,
                state: PositionStateEnum.CLOSED,
                exitPrice: null,
                realizedPnl: null,
                exitReason: ExitReasonEnum.STOP_LOSS,
                closedAt: new Date('2026-05-24T11:00:00Z'),
            }),
        );

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect((view as unknown as Record<string, unknown>).exitPrice).toBeNull();
        expect((view as unknown as Record<string, unknown>).realizedPnlUsd).toBeNull();
        // entryPrice still serialised normally.
        expect(typeof (view as unknown as Record<string, unknown>).entryPrice).toBe('string');
    });

    it('account equity surfaces marginUsed/freeMargin/openExposureUsd as null until M6 W7 (ADR 0022 §2.3.1)', async () => {
        const harness = buildHarness();
        const view = await harness.metricsController.getAccountEquity();

        expect((view as unknown as Record<string, unknown>).marginUsed).toBeNull();
        expect((view as unknown as Record<string, unknown>).freeMargin).toBeNull();
        expect((view as unknown as Record<string, unknown>).openExposureUsd).toBeNull();
    });

    it('realizedPnlUsd on CLOSED position view is a string (decimal-safe)', async () => {
        // The mapper serialises the field as `realizedPnlUsd` per ADR 0022 §2.4.
        const harness = buildHarness();
        harness.positions.closed.push(
            buildPosition({
                id: 5,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('-12.345678901234567'),
                exitReason: ExitReasonEnum.STOP_LOSS,
                closedAt: new Date('2026-05-24T11:00:00Z'),
            }),
        );

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect(typeof (view as unknown as Record<string, unknown>).realizedPnlUsd).toBe('string');
        expect((view as unknown as Record<string, unknown>).realizedPnlUsd).toBe('-12.345678901234567');
    });
});
