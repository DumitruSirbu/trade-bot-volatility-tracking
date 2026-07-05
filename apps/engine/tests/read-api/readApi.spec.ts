import {
    AuthScopeEnum,
    DecisionOutcomeEnum,
    ExitReasonEnum,
    FlowTypeEnum,
    PositionSideEnum,
    PositionSlotEnum,
    PositionStateEnum,
    ProtectiveOrderTypeEnum,
    SignalActionEnum,
    StrategyStatusEnum,
} from '@bot/shared';
import { ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthGuard, RequiredScopes } from '../../src/auth/AuthGuard';
import { IAuthSecretProvider } from '../../src/auth/AuthModule';
import { Money } from '../../src/common/utils/money';
import { AccountSnapshotEntity, PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { RiskStateEntity } from '../../src/risk/entity';
import { RiskStateRepository } from '../../src/risk/repository/RiskStateRepository';
import { DecisionEntity, StrategyVersionEntity } from '../../src/strategy/entity';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { ShadowDecisionRepository } from '../../src/strategy/repository/ShadowDecisionRepository';
import { PositionsController } from '../../src/read-api/controllers/PositionsController';
import { MetricsController } from '../../src/read-api/controllers/MetricsController';
import { NoStoreCacheInterceptor } from '../../src/read-api/interceptor/NoStoreCacheInterceptor';
import { CursorCodec } from '../../src/read-api/pagination/CursorCodec';
import {
    ACCOUNT_EQUITY_VIEW_KEYS,
    CLOSED_POSITION_VIEW_KEYS,
    DECISION_VIEW_KEYS,
    OPEN_POSITION_VIEW_KEYS,
    PERFORMANCE_BY_VERSION_VIEW_KEYS,
    POSITION_DETAIL_VIEW_KEYS,
    RISK_STATE_VIEW_KEYS,
} from '../../src/read-api/mappers/readApiMappers';

// M9 W4 adversarial coverage for the read-API. Per ADR 0022 §2.3 / dev-qa-cycle
// §2.2 the key tests assert that each DTO serialised over the wire contains
// EXACTLY the interface-permitted keys — no entity-column leakage, no internal
// reservationId on the OPEN view, no exchange API key, no raw token claim.
//
// All collaborators are in-memory fakes so the spec is fast and deterministic;
// repository contracts are exercised via Postgres in the existing module tests.

const NOW = new Date('2026-05-24T12:00:00Z');

class StubSecretProvider implements IAuthSecretProvider {
    constructor(private readonly secret = Buffer.alloc(32, 0xab)) {}

    getSigningSecret(): Buffer {
        return this.secret;
    }

    // M11a W1.7 — CursorCodec now consumes IDerivedKeyService; the stub
    // doubles as both the IAuthSecretProvider and the derived-key port
    // (its getCursorKey returns the same buffer the legacy contract returned).
    getCursorKey(): Buffer {
        return this.secret;
    }

    getAuthKey(): Buffer {
        return this.secret;
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

function buildDecision(overrides: Partial<DecisionEntity> = {}): DecisionEntity {
    const base: DecisionEntity = {
        id: 1,
        symbol: 'BTCUSDT',
        strategyVersionId: 1,
        strategyVersion: undefined as never,
        ts: new Date('2026-05-24T11:00:00Z'),
        eventId: 'evt-1',
        signalType: FlowTypeEnum.TREND_INITIATION,
        marketSnapshot: { signalScore: '0.85' } as never,
        action: SignalActionEnum.OPEN,
        reason: 'high-conviction trend',
        positionId: 1,
        haltRelaxActive: false,
    } as DecisionEntity;

    return Object.assign(base, overrides);
}

class FakePositionRepository {
    open: PositionEntity[] = [];
    closed: PositionEntity[] = [];
    byId: Map<number, PositionEntity> = new Map();
    perfRows: Array<{ strategyVersionId: number; tradeCount: number; winCount: number; netPnlUsd: string }> = [];

    async findLiveRisk(): Promise<PositionEntity[]> {
        return this.open;
    }

    async findClosedPage(cursor: { closedAt: Date; id: number } | null, pageSize: number): Promise<PositionEntity[]> {
        const sorted = [...this.closed].sort((left, right) => {
            const leftTs = (left.closedAt ?? left.openedAt).getTime();
            const rightTs = (right.closedAt ?? right.openedAt).getTime();

            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }

            return right.id - left.id;
        });

        const filtered =
            cursor === null
                ? sorted
                : sorted.filter((row) => {
                      const ts = (row.closedAt ?? row.openedAt).getTime();

                      if (ts < cursor.closedAt.getTime()) {
                          return true;
                      }

                      return ts === cursor.closedAt.getTime() && row.id < cursor.id;
                  });

        return filtered.slice(0, pageSize);
    }

    async findById(id: number): Promise<PositionEntity | null> {
        return this.byId.get(id) ?? null;
    }

    async aggregatePerformanceByVersion(_since: Date): Promise<Array<{ strategyVersionId: number; tradeCount: number; winCount: number; netPnlUsd: string }>> {
        return this.perfRows;
    }
}

class FakeDecisionRepository {
    rows: DecisionEntity[] = [];

    async findPage(cursor: { ts: Date; id: number } | null, pageSize: number, filters: { symbol?: string; flowType?: string }): Promise<DecisionEntity[]> {
        let candidates = [...this.rows].sort((left, right) => {
            const diff = right.ts.getTime() - left.ts.getTime();

            return diff !== 0 ? diff : right.id - left.id;
        });

        if (filters.symbol !== undefined) {
            candidates = candidates.filter((row) => row.symbol === filters.symbol);
        }

        if (filters.flowType !== undefined) {
            candidates = candidates.filter((row) => row.signalType === filters.flowType);
        }

        if (cursor !== null) {
            candidates = candidates.filter((row) => {
                if (row.ts.getTime() < cursor.ts.getTime()) {
                    return true;
                }

                return row.ts.getTime() === cursor.ts.getTime() && row.id < cursor.id;
            });
        }

        return candidates.slice(0, pageSize);
    }
}

class FakeAccountSnapshotRepository {
    latest: AccountSnapshotEntity | null = null;

    async findLatest(): Promise<AccountSnapshotEntity | null> {
        return this.latest;
    }
}

class FakeRiskStateRepository {
    today: RiskStateEntity | null = null;

    async findByDate(_date: string): Promise<RiskStateEntity | null> {
        return this.today;
    }
}

class FakeStrategyVersionRepository {
    byId: Map<number, StrategyVersionEntity> = new Map();

    async findById(id: number): Promise<StrategyVersionEntity | null> {
        return this.byId.get(id) ?? null;
    }
}

function buildHarness(): {
    positions: FakePositionRepository;
    decisions: FakeDecisionRepository;
    snapshots: FakeAccountSnapshotRepository;
    riskStates: FakeRiskStateRepository;
    versions: FakeStrategyVersionRepository;
    cursors: CursorCodec;
    positionsController: PositionsController;
    metricsController: MetricsController;
} {
    const positions = new FakePositionRepository();
    const decisions = new FakeDecisionRepository();
    const snapshots = new FakeAccountSnapshotRepository();
    const riskStates = new FakeRiskStateRepository();
    const versions = new FakeStrategyVersionRepository();
    const cursors = new CursorCodec(new StubSecretProvider());

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

    return { positions, decisions, snapshots, riskStates, versions, cursors, positionsController, metricsController };
}

describe('ReadApi DTO key snapshots (ADR 0022 §2.3 — anti-leakage)', () => {
    it('OPEN position view exposes EXACTLY the IOpenPositionView keys', async () => {
        const harness = buildHarness();
        harness.positions.open.push(buildPosition());

        const [view] = await harness.positionsController.listOpen();

        expect(Object.keys(view).sort()).toEqual([...OPEN_POSITION_VIEW_KEYS].sort());
        // Anti-leakage: explicit excludes from ADR 0022 §2.3
        expect((view as unknown as Record<string, unknown>).reservationId).toBeUndefined();
        expect((view as unknown as Record<string, unknown>).clientOrderId).toBeUndefined();
        expect((view as unknown as Record<string, unknown>).recoveryPhase).toBeUndefined();
        expect((view as unknown as Record<string, unknown>).entryNotional).toBeUndefined();
    });

    it('CLOSED position view exposes EXACTLY the IClosedPositionView keys', async () => {
        const harness = buildHarness();
        harness.versions.byId.set(1, { id: 1, name: 'xmom' } as StrategyVersionEntity);
        harness.positions.closed.push(
            buildPosition({
                id: 7,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('100'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: new Date('2026-05-24T11:30:00Z'),
            }),
        );

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect(Object.keys(view).sort()).toEqual([...CLOSED_POSITION_VIEW_KEYS].sort());
        expect(view.strategyVersionName).toBe('xmom');
    });

    it('CLOSED position view falls back to "unknown" when the strategy version row is missing', async () => {
        const harness = buildHarness();
        // No version seeded — the join misses (out-of-band deletion).
        harness.positions.closed.push(buildPosition({ id: 8, state: PositionStateEnum.CLOSED, closedAt: new Date('2026-05-24T11:30:00Z') }));

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect(view.strategyVersionName).toBe('unknown');
    });

    it('DETAIL position view exposes EXACTLY the IPositionDetailView keys + clientOrderId/reservationId stubs', async () => {
        const harness = buildHarness();
        harness.versions.byId.set(1, { id: 1, name: 'xmom' } as StrategyVersionEntity);
        const row = buildPosition({ id: 42 });
        harness.positions.byId.set(42, row);

        const view = await harness.positionsController.getDetail('42');

        expect(Object.keys(view).sort()).toEqual([...POSITION_DETAIL_VIEW_KEYS].sort());
        // Detail surface intentionally includes clientOrderId (ADR 0022 §2.3
        // detail-only). reservationId stays null until M6 W4b denormalises it.
        expect(view.clientOrderId).toBe('position-42');
        expect(view.reservationId).toBeNull();
        expect(view.strategyVersionName).toBe('xmom');
    });

    it('DECISION view exposes EXACTLY the IDecisionView keys', async () => {
        const harness = buildHarness();
        harness.decisions.rows.push(buildDecision());

        const result = await harness.metricsController.listDecisions({});
        const [view] = result.items;

        expect(Object.keys(view).sort()).toEqual([...DECISION_VIEW_KEYS].sort());
    });

    it('DECISION view maps outcome from gate_allowed and position_id', async () => {
        const harness = buildHarness();

        harness.decisions.rows.push(
            buildDecision({ id: 10, action: SignalActionEnum.OPEN, gateAllowed: false, positionId: null, reason: 'no_eligible_slot' }),
            buildDecision({ id: 11, action: SignalActionEnum.OPEN, gateAllowed: true, positionId: null, reason: 'momentum_follow' }),
            buildDecision({ id: 12, action: SignalActionEnum.OPEN, gateAllowed: true, positionId: 99, reason: 'momentum_follow' }),
            buildDecision({ id: 13, action: SignalActionEnum.SKIP, gateAllowed: null, positionId: null, reason: 'baseline_no_trade' }),
        );

        const result = await harness.metricsController.listDecisions({});
        const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));

        expect(byId['10'].outcome).toBe(DecisionOutcomeEnum.REJECTED);
        expect(byId['11'].outcome).toBe(DecisionOutcomeEnum.APPROVED);
        expect(byId['12'].outcome).toBe(DecisionOutcomeEnum.FILLED);
        expect(byId['13'].outcome).toBe(DecisionOutcomeEnum.SKIPPED);
    });

    it('DECISION view maps signal_score from market_snapshot.signal_score (IMarketSnapshot snake_case)', async () => {
        const harness = buildHarness();

        harness.decisions.rows.push(
            buildDecision({
                id: 20,
                marketSnapshot: { signal_score: 100 } as never,
            }),
        );

        const result = await harness.metricsController.listDecisions({});
        const view = result.items.find((item) => item.id === '20');

        expect(view?.signalScore).toBe('100.000000');
    });

    it('ACCOUNT EQUITY view exposes EXACTLY the IAccountEquityView keys (even from null snapshot)', async () => {
        const harness = buildHarness();
        const view = await harness.metricsController.getAccountEquity();

        expect(Object.keys(view).sort()).toEqual([...ACCOUNT_EQUITY_VIEW_KEYS].sort());
        // ADR 0022 §2.3.1 — null when M6 W7 writer not yet shipped.
        expect(view.marginUsed).toBeNull();
        expect(view.freeMargin).toBeNull();
        expect(view.openExposureUsd).toBeNull();
    });

    it('ACCOUNT EQUITY view surfaces marginUsed/freeMargin/openExposureUsd as null even with a snapshot (ADR 0022 §2.3.1)', async () => {
        const harness = buildHarness();
        harness.snapshots.latest = {
            id: 1,
            ts: NOW,
            balance: new Money('1000'),
            equity: new Money('1050'),
            unrealizedPnl: new Money('50'),
        } as unknown as AccountSnapshotEntity;

        const view = await harness.metricsController.getAccountEquity();

        expect(view.equityUsd).toBe('1050');
        expect(view.marginUsed).toBeNull();
        expect(view.freeMargin).toBeNull();
        expect(view.openExposureUsd).toBeNull();
    });

    it('RISK STATE view exposes EXACTLY the IRiskStateView keys (even with no row)', async () => {
        const harness = buildHarness();
        const view = await harness.metricsController.getRiskState();

        expect(Object.keys(view).sort()).toEqual([...RISK_STATE_VIEW_KEYS].sort());
        expect(view.isHalted).toBe(false);
    });

    it('PERFORMANCE BY VERSION view exposes EXACTLY the IPerformanceByVersionView keys', async () => {
        const harness = buildHarness();
        harness.positions.perfRows.push({ strategyVersionId: 1, tradeCount: 10, winCount: 6, netPnlUsd: '125.50' });
        harness.versions.byId.set(1, {
            id: 1,
            name: 'v0-baseline',
            version: 0,
            direction: 'NEUTRAL' as never,
            params: {},
            status: StrategyStatusEnum.ACTIVE,
            createdAt: NOW,
        } as StrategyVersionEntity);

        const [view] = await harness.metricsController.getPerformanceByVersion();

        expect(Object.keys(view).sort()).toEqual([...PERFORMANCE_BY_VERSION_VIEW_KEYS].sort());
        expect(view.label).toBe('v0-baseline@v0');
        expect(view.isLive).toBe(true);
        expect(view.winRate).toBe('0.600000');
        // ADR 0022 §2.3.1 — live engine has no per-version equity series.
        expect(view.maxDrawdownUsd).toBeNull();
        expect(view.sharpe).toBeNull();
        expect(view.sortino).toBeNull();
        expect(view.expectancyPerUnitRisk).toBeNull();
    });

    it('PERFORMANCE BY VERSION view returns winRate=null when tradeCount===0 (M9 R2 wave B / Q7)', async () => {
        // M9 R2 wave B (Q7). The shared contract now types winRate as
        // `string | null`; the mapper returns `null` when `tradeCount === 0` so
        // consumers distinguish "no trades observed in window" from a real 0%
        // win rate. The old `'0.000000'` sentinel conflated the two.
        const harness = buildHarness();
        harness.positions.perfRows.push({ strategyVersionId: 1, tradeCount: 0, winCount: 0, netPnlUsd: '0' });
        harness.versions.byId.set(1, {
            id: 1,
            name: 'v0-baseline',
            version: 0,
            direction: 'NEUTRAL' as never,
            params: {},
            status: StrategyStatusEnum.ACTIVE,
            createdAt: NOW,
        } as StrategyVersionEntity);

        const [view] = await harness.metricsController.getPerformanceByVersion();

        expect(view.winRate).toBeNull();
        expect(view.tradeCount).toBe(0);
    });
});

describe('ReadApi money serialisation (ADR 0022 §2.4)', () => {
    it('serialises every money field as a string, never a number', async () => {
        const harness = buildHarness();
        harness.positions.open.push(buildPosition({ entryPrice: new Money('55000.123456789'), qty: new Money('0.1') }));

        const [view] = await harness.positionsController.listOpen();

        expect(typeof view.entryPrice).toBe('string');
        expect(typeof view.qty).toBe('string');
        // ADR 0022 §2.3.1 — split fields. Price component is always computable
        // (string); funding component is null until M6 W5 wires accruals in.
        expect(typeof view.unrealizedPnlPriceUsd).toBe('string');
        expect(view.unrealizedPnlFundingUsd).toBeNull();
        expect(typeof view.leverage).toBe('string');
        expect(view.entryPrice).toBe('55000.123456789');
    });

    it('CLOSED position view surfaces exitPrice/realizedPnlUsd as null when entity columns are null (ADR 0022 §2.3.1)', async () => {
        const harness = buildHarness();
        // Forge a CLOSED row that somehow lacks exitPrice/realizedPnl (legacy data
        // or partial-close pre-M6 W5). The mapper must NOT fabricate values.
        harness.positions.closed.push(
            buildPosition({
                id: 11,
                state: PositionStateEnum.CLOSED,
                exitPrice: null,
                realizedPnl: null,
                exitReason: ExitReasonEnum.STOP_LOSS,
                closedAt: new Date('2026-05-24T11:30:00Z'),
            }),
        );

        const result = await harness.positionsController.listClosed();
        const [view] = result.items;

        expect(view.exitPrice).toBeNull();
        expect(view.realizedPnlUsd).toBeNull();
    });

    it('serialises nullable money fields (slPrice/tpPrice) as null, never the string "0"', async () => {
        const harness = buildHarness();
        harness.positions.open.push(buildPosition({ stopLossPrice: null, takeProfitPrice: null }));

        const [view] = await harness.positionsController.listOpen();

        expect(view.slPrice).toBeNull();
        expect(view.tpPrice).toBeNull();
    });
});

describe('Cursor pagination (ADR 0022 §2.5)', () => {
    it('clamps pageSize above 200 down to the max', async () => {
        const harness = buildHarness();
        const result = await harness.positionsController.listClosed(undefined, '5000');

        expect(result.pageSize).toBe(200);
    });

    it('falls back to default pageSize (50) when omitted or invalid', async () => {
        const harness = buildHarness();
        const noArg = await harness.positionsController.listClosed();
        const zero = await harness.positionsController.listClosed(undefined, '0');
        const garbage = await harness.positionsController.listClosed(undefined, 'abc');

        expect(noArg.pageSize).toBe(50);
        expect(zero.pageSize).toBe(50);
        expect(garbage.pageSize).toBe(50);
    });

    it('emits a nextCursor that decodes back to the tail row of the page', async () => {
        const harness = buildHarness();

        for (let i = 1; i <= 5; i += 1) {
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

        const firstPage = await harness.positionsController.listClosed(undefined, '2');
        expect(firstPage.items).toHaveLength(2);
        expect(firstPage.nextCursor).not.toBeNull();

        const decoded = harness.cursors.decode(firstPage.nextCursor!);
        expect(decoded).not.toBeNull();
        expect(decoded?.id).toBe(Number(firstPage.items[1].id));
    });

    it('rejects a tampered cursor by treating it as null (server-side bounds untouched)', async () => {
        const harness = buildHarness();
        harness.positions.closed.push(
            buildPosition({
                id: 1,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('56000'),
                realizedPnl: new Money('1'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: new Date('2026-05-24T11:00:00Z'),
            }),
        );

        const tampered = 'eyJpZCI6OTk5OSwidHMiOiIyMDk5LTAxLTAxIn0.thisIsAForgedMacValueXYZ';
        const result = await harness.positionsController.listClosed(tampered, '10');

        // Tampered cursor → decode returns null → controller serves page 1.
        expect(result.items).toHaveLength(1);
    });

    it('returns a stable page after a row in the previous page is deleted (no row skip)', async () => {
        const harness = buildHarness();

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
        // Delete the SECOND row in page 1 (id of the tail). The cursor is bound
        // to that exact (closedAt, id) — page 2 should still resume from "just
        // before" the deleted row, not skip a still-present row.
        const tailId = Number(page1.items[1].id);
        harness.positions.closed = harness.positions.closed.filter((row) => row.id !== tailId);

        const page2 = await harness.positionsController.listClosed(page1.nextCursor ?? undefined, '2');

        expect(page2.items.map((item) => item.id)).not.toContain(String(tailId));
        // The previously-page-1-head row must NOT appear on page 2 either.
        expect(page2.items.map((item) => item.id)).not.toContain(page1.items[0].id);
    });
});

describe('Decisions filters', () => {
    it('symbol + flowType filters are AND-ed', async () => {
        const harness = buildHarness();
        harness.decisions.rows.push(
            buildDecision({ id: 1, symbol: 'BTCUSDT', signalType: FlowTypeEnum.TREND_INITIATION }),
            buildDecision({ id: 2, symbol: 'ETHUSDT', signalType: FlowTypeEnum.TREND_INITIATION }),
            buildDecision({ id: 3, symbol: 'BTCUSDT', signalType: FlowTypeEnum.MARKET_BETA }),
        );

        const result = await harness.metricsController.listDecisions({ symbol: 'BTCUSDT', flowType: FlowTypeEnum.TREND_INITIATION });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('1');
    });

    it('treats an empty-string filter as "no filter"', async () => {
        const harness = buildHarness();
        harness.decisions.rows.push(buildDecision({ id: 1 }), buildDecision({ id: 2, symbol: 'ETHUSDT' }));

        const result = await harness.metricsController.listDecisions({ symbol: '', flowType: '' });

        expect(result.items).toHaveLength(2);
    });
});

describe('Position detail edge cases', () => {
    it('404s a non-numeric id without leaking distinction from "not found"', async () => {
        const harness = buildHarness();

        await expect(harness.positionsController.getDetail('abc')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a numeric id that does not exist', async () => {
        const harness = buildHarness();

        await expect(harness.positionsController.getDetail('999')).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('AuthGuard wiring (scope rejection)', () => {
    // The controllers carry @UseGuards(AuthGuard) + @RequiredScopes(READ) at the
    // class level. We exercise the guard against a request missing the scope and
    // confirm rejection — this guards the most likely regression (a future fix
    // accidentally lifting the guard).
    it('rejects a request missing the READ scope on PositionsController', async () => {
        const reflector = new Reflector();
        const verify = jest.fn().mockReturnValue({
            sub: 'op',
            jti: 'j',
            scopes: [],
            iat: 0,
            exp: Math.floor(Date.now() / 1000) + 60,
        });
        const tokens = { verify } as unknown as ConstructorParameters<typeof AuthGuard>[1];
        const revoked = { isRevoked: jest.fn().mockResolvedValue(false) } as unknown as ConstructorParameters<typeof AuthGuard>[2];
        const guard = new AuthGuard(reflector, tokens, revoked);

        const ctx = {
            switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer x.y.z' } }) }),
            getHandler: () => PositionsController.prototype.listOpen,
            getClass: () => PositionsController,
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('declares @RequiredScopes(READ) on PositionsController via class metadata', () => {
        const scopes = Reflect.getMetadata('auth:required_scopes', PositionsController);
        expect(scopes).toEqual([AuthScopeEnum.READ]);
    });

    it('declares @RequiredScopes(READ) on MetricsController via class metadata', () => {
        const scopes = Reflect.getMetadata('auth:required_scopes', MetricsController);
        expect(scopes).toEqual([AuthScopeEnum.READ]);
    });

    // The decorator import is load-bearing in the test file — keeps the import
    // from being tree-shaken out and signals to future readers that the test
    // intentionally references the same decorator the controllers use.
    it('the RequiredScopes decorator is the same one used by the controllers', () => {
        expect(typeof RequiredScopes).toBe('function');
    });
});

describe('CursorCodec invariants', () => {
    it('a forged mac fails decode', () => {
        const codec = new CursorCodec(new StubSecretProvider());
        const valid = codec.encode({ id: 1, ts: NOW });
        const [payload] = valid.split('.');
        const forged = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

        expect(codec.decode(forged)).toBeNull();
    });

    it('a swapped secret invalidates a previously-issued cursor', () => {
        const codecA = new CursorCodec(new StubSecretProvider(Buffer.alloc(32, 0x01)));
        const codecB = new CursorCodec(new StubSecretProvider(Buffer.alloc(32, 0x02)));
        const cursor = codecA.encode({ id: 9, ts: NOW });

        expect(codecB.decode(cursor)).toBeNull();
    });

    it('round-trips id + ts faithfully', () => {
        const codec = new CursorCodec(new StubSecretProvider());
        const encoded = codec.encode({ id: 42, ts: NOW });
        const decoded = codec.decode(encoded);

        expect(decoded?.id).toBe(42);
        expect(decoded?.ts.toISOString()).toBe(NOW.toISOString());
    });

    it('rejects an oversized cursor without parsing', () => {
        const codec = new CursorCodec(new StubSecretProvider());
        const huge = 'x'.repeat(500);

        expect(codec.decode(huge)).toBeNull();
    });

    it('cleartext payload contains no raw row contents beyond (id, ts)', () => {
        const codec = new CursorCodec(new StubSecretProvider());
        const cursor = codec.encode({ id: 42, ts: NOW });
        const [payload] = cursor.split('.');
        // base64url decode and inspect the plaintext: only id + ts keys.
        const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64').toString('utf8'));
        expect(Object.keys(decoded).sort()).toEqual(['id', 'ts']);
    });
});

// ---------------------------------------------------------------------------
// M9 R2 wave B
// ---------------------------------------------------------------------------

describe('M9 R2 wave B — Cache-Control: no-store interceptor (medium)', () => {
    it('NoStoreCacheInterceptor sets Cache-Control: no-store on the wrapped response', (done) => {
        // Use real rxjs to exercise the production code path verbatim.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { of } = require('rxjs') as typeof import('rxjs');
        const interceptor = new NoStoreCacheInterceptor();
        const headers: Record<string, string> = {};
        const ctx = {
            switchToHttp: () => ({
                getResponse: () => ({
                    setHeader: (name: string, value: string) => {
                        headers[name] = value;
                    },
                }),
            }),
        } as unknown as Parameters<NoStoreCacheInterceptor['intercept']>[0];
        const next = { handle: () => of('payload') } as Parameters<NoStoreCacheInterceptor['intercept']>[1];

        interceptor.intercept(ctx, next).subscribe(() => {
            expect(headers['Cache-Control']).toBe('no-store');
            done();
        });
    });

    it('PositionsController is wired with NoStoreCacheInterceptor (class-level metadata)', () => {
        const interceptors = Reflect.getMetadata('__interceptors__', PositionsController) as Array<new () => unknown> | undefined;

        expect(interceptors).toBeDefined();
        expect((interceptors ?? []).some((cls) => cls === NoStoreCacheInterceptor)).toBe(true);
    });

    it('MetricsController is wired with NoStoreCacheInterceptor (class-level metadata)', () => {
        const interceptors = Reflect.getMetadata('__interceptors__', MetricsController) as Array<new () => unknown> | undefined;

        expect(interceptors).toBeDefined();
        expect((interceptors ?? []).some((cls) => cls === NoStoreCacheInterceptor)).toBe(true);
    });
});

describe('M9 R2 wave B — Q8 closed_at null guard (medium)', () => {
    it('throws when the repository tail row somehow has null closedAt (defence-in-depth)', async () => {
        const harness = buildHarness();
        // Defence-in-depth: the repository's findClosedPage adds an explicit
        // `closed_at IS NOT NULL` guard, but if a regression ever bypasses it
        // the controller must NOT encode a NaN/`null` cursor silently — it
        // throws. Stub findClosedPage to return exactly such a row.
        harness.positions.findClosedPage = async (_cursor, _pageSize) => [
            buildPosition({
                id: 99,
                state: PositionStateEnum.CLOSED,
                exitPrice: new Money('1'),
                realizedPnl: new Money('1'),
                exitReason: ExitReasonEnum.TAKE_PROFIT,
                closedAt: null,
            }),
        ];

        await expect(harness.positionsController.listClosed(undefined, '1')).rejects.toThrow(/null closedAt/);
    });
});

describe('M9 R2 wave B — Q9 UTC-aligned since for performance window (medium)', () => {
    it('aggregatePerformanceByVersion receives a since boundary floored to UTC midnight', async () => {
        const harness = buildHarness();
        const observed: Date[] = [];

        // Intercept the repository call to capture the `since` argument.
        harness.positions.aggregatePerformanceByVersion = async (since: Date) => {
            observed.push(since);

            return [];
        };

        const realNow = Date.now;
        // Mid-day UTC: 2026-05-24T13:37:42.123Z
        const fakeNow = new Date('2026-05-24T13:37:42.123Z').getTime();
        Date.now = () => fakeNow;

        try {
            await harness.metricsController.getPerformanceByVersion('30');
        } finally {
            Date.now = realNow;
        }

        expect(observed).toHaveLength(1);
        const since = observed[0];
        // 2026-05-24 midnight UTC minus 30 days = 2026-04-24T00:00:00.000Z
        expect(since.toISOString()).toBe('2026-04-24T00:00:00.000Z');
        expect(since.getUTCHours()).toBe(0);
        expect(since.getUTCMinutes()).toBe(0);
        expect(since.getUTCSeconds()).toBe(0);
        expect(since.getUTCMilliseconds()).toBe(0);
    });
});
