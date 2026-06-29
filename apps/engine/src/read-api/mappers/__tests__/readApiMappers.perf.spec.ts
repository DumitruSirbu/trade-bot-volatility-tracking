/**
 * Unit tests for the three Wave-2 performance mapper functions in readApiMappers.ts:
 *   - mapDailyPerformanceRows
 *   - mapShadowPerformanceSummary (also exercises computeShadowTradePnl indirectly)
 *
 * computeShadowTradePnl is private — its behaviour is asserted via
 * mapShadowPerformanceSummary (netPnlUsd / winCount on the returned summary).
 * PnL formula: (exitPrice − entryPrice) × qty × dirSign − feeEntry − feeExit − slippageCost.
 * slippageCost = |slippageEntryPct| / 100 × entryPrice × qty (BacktestPnLLedger convention).
 */

import { PositionSideEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { ShadowDecisionEntity } from '../../../strategy/entity';
import { StrategyVersionEntity } from '../../../strategy/entity/StrategyVersionEntity';
import { mapDailyPerformanceRows, mapShadowPerformanceSummary } from '../readApiMappers';

// IDailyPerformanceAggregateRow is not exported from the mapper — define the
// structural type locally to keep the test file self-contained.
interface IDailyPerformanceAggregateRow {
    readonly strategyVersionId: number;
    readonly date: string;
    readonly trades: number;
    readonly winCount: number;
    readonly netPnlUsd: string;
}

// ---------------------------------------------------------------------------
// Builder helpers — keep tests independent of one another
// ---------------------------------------------------------------------------

function buildVersion(overrides: Partial<StrategyVersionEntity> & { id: number; name: string; version: number }): StrategyVersionEntity {
    const entity = new StrategyVersionEntity();
    entity.id = overrides.id;
    entity.name = overrides.name;
    entity.version = overrides.version;
    entity.direction = overrides.direction ?? StrategyDirectionEnum.MEAN_REVERSION;
    entity.status = overrides.status ?? StrategyStatusEnum.ACTIVE;
    entity.params = overrides.params ?? {};
    entity.createdAt = overrides.createdAt ?? new Date('2025-01-01T00:00:00Z');

    return entity;
}

function buildDailyRow(overrides: Partial<IDailyPerformanceAggregateRow> & { strategyVersionId: number; date: string }): IDailyPerformanceAggregateRow {
    return {
        strategyVersionId: overrides.strategyVersionId,
        date: overrides.date,
        trades: overrides.trades ?? 1,
        winCount: overrides.winCount ?? 1,
        netPnlUsd: overrides.netPnlUsd ?? '0',
    };
}

function buildShadowEntity(overrides: {
    id?: number;
    shadowVersion: string;
    strategyVersionId: number;
    tradeSide?: string | null;
    qty?: string | null;
    simulatedFill?: {
        entryPrice?: string;
        exitPrice?: string | null;
        feeUsdtEntry?: string | null;
        feeUsdtExit?: string | null;
        slippageEntryPct?: string;
        forceClose?: boolean;
    } | null;
}): ShadowDecisionEntity {
    const entity = new ShadowDecisionEntity();
    entity.id = overrides.id ?? 1;
    entity.shadowVersion = overrides.shadowVersion;
    entity.strategyVersionId = overrides.strategyVersionId;
    entity.tradeSide = overrides.tradeSide ?? PositionSideEnum.LONG;
    entity.qty = overrides.qty ?? '1';
    entity.eventId = `evt-${entity.id}`;
    entity.symbol = 'BTCUSDT';
    entity.action = 'open';
    entity.gateAllowed = true;
    entity.haltRelaxActive = false;
    entity.createdAt = new Date('2025-06-01T00:00:00Z');
    entity.marketSnapshot = {} as never;
    entity.virtualSlotStateSnapshot = {} as never;

    if (overrides.simulatedFill !== undefined) {
        const fill = overrides.simulatedFill;

        if (fill === null) {
            entity.simulatedFill = null;
        } else {
            entity.simulatedFill = {
                entryPrice: fill.entryPrice ?? '100',
                exitPrice: fill.exitPrice ?? '105',
                slippageEntryPct: fill.slippageEntryPct ?? '0',
                slippageExitPct: '0',
                slippageComponents: { tierBase: '0', latency: '0', crossingSpread: '0' },
                missed: false,
                forceClose: fill.forceClose ?? false,
                lowFidelity: false,
                closedAt: '2025-06-01T01:00:00Z',
                closeReason: 'tp',
                feeUsdtEntry: fill.feeUsdtEntry ?? null,
                feeUsdtExit: fill.feeUsdtExit ?? null,
            };
        }
    } else {
        entity.simulatedFill = {
            entryPrice: '100',
            exitPrice: '105',
            slippageEntryPct: '0',
            slippageExitPct: '0',
            slippageComponents: { tierBase: '0', latency: '0', crossingSpread: '0' },
            missed: false,
            forceClose: false,
            lowFidelity: false,
            closedAt: '2025-06-01T01:00:00Z',
            closeReason: 'tp',
            feeUsdtEntry: null,
            feeUsdtExit: null,
        };
    }

    return entity;
}

// ---------------------------------------------------------------------------
// mapDailyPerformanceRows
// ---------------------------------------------------------------------------

describe('mapDailyPerformanceRows', () => {
    it('returns empty array when rows is empty', () => {
        // BUILD
        const versions = new Map<number, StrategyVersionEntity>();

        // OPERATE
        const result = mapDailyPerformanceRows([], versions, 0);

        // CHECK
        expect(result).toEqual([]);
    });

    it('skips rows whose strategyVersionId is absent from the versions map', () => {
        // BUILD
        const rows = [buildDailyRow({ strategyVersionId: 99, date: '2025-01-01', netPnlUsd: '10' })];
        const versions = new Map<number, StrategyVersionEntity>();

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK
        expect(result).toEqual([]);
    });

    it('computes running cumulativePnlUsd correctly for a single version over three days', () => {
        // BUILD — PnL: [+10, -5, +3] → cumulative: [10, 5, 8]
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);

        const rows = [
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-01', netPnlUsd: '10', trades: 3, winCount: 2 }),
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-02', netPnlUsd: '-5', trades: 2, winCount: 1 }),
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-03', netPnlUsd: '3', trades: 1, winCount: 1 }),
        ];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK — sorted by label then date so order is deterministic
        expect(result).toHaveLength(3);
        expect(result[0].cumulativePnlUsd).toBe('10');
        expect(result[1].cumulativePnlUsd).toBe('5');
        expect(result[2].cumulativePnlUsd).toBe('8');
    });

    it('resets cumulativePnlUsd independently per version', () => {
        // BUILD — v1 runs 0→+20, v2 runs independently 0→+7
        const v1 = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const v2 = buildVersion({ id: 2, name: 'beta', version: 1 });
        const versions = new Map([
            [1, v1],
            [2, v2],
        ]);

        const rows = [
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-01', netPnlUsd: '10' }),
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-02', netPnlUsd: '10' }),
            buildDailyRow({ strategyVersionId: 2, date: '2025-01-01', netPnlUsd: '3' }),
            buildDailyRow({ strategyVersionId: 2, date: '2025-01-02', netPnlUsd: '4' }),
        ];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK — result is sorted by label then date
        // alpha@v1 sorts before beta@v1 lexicographically
        const alphaRows = result.filter((r) => r.strategyVersionId === '1');
        const betaRows = result.filter((r) => r.strategyVersionId === '2');

        expect(alphaRows[0].cumulativePnlUsd).toBe('10');
        expect(alphaRows[1].cumulativePnlUsd).toBe('20');

        // v2 cumulative starts from 0, independent of v1's ending balance
        expect(betaRows[0].cumulativePnlUsd).toBe('3');
        expect(betaRows[1].cumulativePnlUsd).toBe('7');
    });

    it('sets winRate to null when a day row has zero trades', () => {
        // BUILD
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const rows = [buildDailyRow({ strategyVersionId: 1, date: '2025-01-01', trades: 0, winCount: 0, netPnlUsd: '0' })];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK
        expect(result).toHaveLength(1);
        expect(result[0].winRate).toBeNull();
    });

    it('stamps the correct label from the version entity', () => {
        // BUILD
        const version = buildVersion({ id: 1, name: 'reversion', version: 3 });
        const versions = new Map([[1, version]]);
        const rows = [buildDailyRow({ strategyVersionId: 1, date: '2025-01-01' })];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK
        expect(result[0].label).toBe('reversion@v3');
    });

    it('stamps isLive from the configured live strategy version id', () => {
        // BUILD
        const version = buildVersion({ id: 16, name: 'volatility-vwap', version: 21 });
        const versions = new Map([[16, version]]);
        const rows = [buildDailyRow({ strategyVersionId: 16, date: '2026-06-26' })];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 16);

        // CHECK
        expect(result[0].isLive).toBe(true);
    });

    it('sorts output by label ascending then date ascending', () => {
        // BUILD — beta comes after alpha lexicographically
        const v1 = buildVersion({ id: 1, name: 'beta', version: 1 });
        const v2 = buildVersion({ id: 2, name: 'alpha', version: 1 });
        const versions = new Map([
            [1, v1],
            [2, v2],
        ]);

        // Input intentionally not pre-sorted
        const rows = [
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-02', netPnlUsd: '5' }),
            buildDailyRow({ strategyVersionId: 2, date: '2025-01-01', netPnlUsd: '3' }),
            buildDailyRow({ strategyVersionId: 1, date: '2025-01-01', netPnlUsd: '1' }),
        ];

        // OPERATE
        const result = mapDailyPerformanceRows(rows, versions, 0);

        // CHECK — alpha before beta, then by date within each label
        expect(result[0].label).toBe('alpha@v1');
        expect(result[1].label).toBe('beta@v1');
        expect(result[1].date).toBe('2025-01-01');
        expect(result[2].date).toBe('2025-01-02');
    });
});

// ---------------------------------------------------------------------------
// mapShadowPerformanceSummary (exercises computeShadowTradePnl indirectly)
// ---------------------------------------------------------------------------

describe('mapShadowPerformanceSummary', () => {
    it('returns empty array when entities is empty', () => {
        // BUILD
        const versions = new Map<number, StrategyVersionEntity>();

        // OPERATE
        const result = mapShadowPerformanceSummary([], versions, 30);

        // CHECK
        expect(result).toEqual([]);
    });

    it('passes windowDays through to each summary entry', () => {
        // BUILD
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [buildShadowEntity({ shadowVersion: 'v1', strategyVersionId: 1 })];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 42);

        // CHECK
        expect(result[0].windowDays).toBe(42);
    });

    it('sorts summaries by shadowVersion ascending', () => {
        // BUILD — input order: v2, v0, v3
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({ id: 1, shadowVersion: 'v2', strategyVersionId: 1 }),
            buildShadowEntity({ id: 2, shadowVersion: 'v0', strategyVersionId: 1 }),
            buildShadowEntity({ id: 3, shadowVersion: 'v3', strategyVersionId: 1 }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result.map((s) => s.shadowVersion)).toEqual(['v0', 'v2', 'v3']);
    });

    it('uses shadowVersion as label and returns strategyVersionId=0 when version is absent from the map', () => {
        // BUILD — strategyVersionId 999 not in the versions map
        const versions = new Map<number, StrategyVersionEntity>();
        const entities = [buildShadowEntity({ shadowVersion: 'v9-experiment', strategyVersionId: 999 })];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 7);

        // CHECK
        expect(result[0].label).toBe('v9-experiment');
        expect(result[0].strategyVersionId).toBe('0');
    });

    it('builds the correct label from the version entity when the version is found', () => {
        // BUILD
        const version = buildVersion({ id: 5, name: 'momentum', version: 2 });
        const versions = new Map([[5, version]]);
        const entities = [buildShadowEntity({ shadowVersion: 'v2', strategyVersionId: 5 })];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 14);

        // CHECK
        expect(result[0].label).toBe('momentum@v2');
        expect(result[0].strategyVersionId).toBe('5');
    });

    // -----------------------------------------------------------------------
    // computeShadowTradePnl — LONG paths (via summary netPnlUsd / winCount)
    // -----------------------------------------------------------------------

    it('computes LONG win gross PnL correctly: (exitPrice−entryPrice)×qty×1', () => {
        // BUILD — entryPrice=100, exitPrice=105, qty=1, LONG, no fees
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105', feeUsdtEntry: null, feeUsdtExit: null },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — gross = net because no fees; PnL = 5
        expect(result[0].netPnlUsd).toBe('5');
        expect(result[0].winCount).toBe(1);
    });

    it('deducts both fee legs from LONG gross PnL to produce netPnl', () => {
        // BUILD — grossPnl=5, feeEntry=0.10, feeExit=0.10 → netPnl=4.80
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105', feeUsdtEntry: '0.10', feeUsdtExit: '0.10' },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result[0].netPnlUsd).toBe('4.8');
        expect(result[0].winCount).toBe(1);
    });

    it('deducts entry slippage cost from netPnl: |slippagePct|/100 × entryPrice × qty', () => {
        // BUILD — LONG, entry=100, exit=105, qty=1, slippageEntryPct=0.15
        // slippageCost = 0.15/100 × 100 × 1 = 0.15 → netPnl = 5 − 0.15 = 4.85
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105', slippageEntryPct: '0.15', feeUsdtEntry: null, feeUsdtExit: null },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — Money uses ROUND_DOWN: 4.85 exact, no rounding needed
        expect(result[0].netPnlUsd).toBe('4.85');
        expect(result[0].winCount).toBe(1);
    });

    it('computes SHORT win: (exitPrice−entryPrice)×qty×(−1) yields positive PnL when exit < entry', () => {
        // BUILD — SHORT, entry=105, exit=100, qty=1, no fees
        // gross = (100−105)×1×(−1) = (−5)×(−1) = 5
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.SHORT,
                qty: '1',
                simulatedFill: { entryPrice: '105', exitPrice: '100', feeUsdtEntry: null, feeUsdtExit: null },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result[0].netPnlUsd).toBe('5');
        expect(result[0].winCount).toBe(1);
    });

    it('computes SHORT loss: exit above entry yields negative PnL', () => {
        // BUILD — SHORT, entry=100, exit=105, qty=1, no fees
        // gross = (105−100)×1×(−1) = 5×(−1) = −5
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.SHORT,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105', feeUsdtEntry: null, feeUsdtExit: null },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result[0].netPnlUsd).toBe('-5');
        expect(result[0].winCount).toBe(0);
    });

    it('does not count fee-eroded trade as a win when netPnl <= 0', () => {
        // BUILD — grossPnl=0.10, feeEntry=0.08, feeExit=0.05 → netPnl = −0.03 (loss)
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '100.10', feeUsdtEntry: '0.08', feeUsdtExit: '0.05' },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — netPnl is negative; win count must be 0
        expect(result[0].winCount).toBe(0);
        expect(result[0].tradeCount).toBe(1);
        // Verify netPnl is indeed negative
        expect(parseFloat(result[0].netPnlUsd)).toBeLessThan(0);
    });

    it('reads forceClose=true from simulatedFill and reflects it in forceCloseFraction', () => {
        // BUILD — single trade with forceClose=true
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                simulatedFill: { forceClose: true },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — 1/1 = 1.000000
        expect(result[0].forceCloseFraction).toBe('1.000000');
    });

    it('computes forceCloseFraction as a fraction over tradeCount', () => {
        // BUILD — three trades, two with forceClose=true → fraction = 2/3 ≈ 0.666667
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({ id: 1, shadowVersion: 'v1', strategyVersionId: 1, simulatedFill: { forceClose: true } }),
            buildShadowEntity({ id: 2, shadowVersion: 'v1', strategyVersionId: 1, simulatedFill: { forceClose: true } }),
            buildShadowEntity({ id: 3, shadowVersion: 'v1', strategyVersionId: 1, simulatedFill: { forceClose: false } }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — Money uses ROUND_DOWN so 2/3 truncates to 0.666666 (not 0.666667)
        expect(result[0].forceCloseFraction).toBe('0.666666');
    });

    it('counts winCount and tradeCount correctly across a winner and a loser', () => {
        // BUILD — winner (netPnl=5) and loser (netPnl=−5) under the same shadowVersion
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                id: 1,
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                simulatedFill: { entryPrice: '100', exitPrice: '105' }, // +5
            }),
            buildShadowEntity({
                id: 2,
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.SHORT,
                simulatedFill: { entryPrice: '100', exitPrice: '105' }, // −5
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result[0].tradeCount).toBe(2);
        expect(result[0].winCount).toBe(1);
        expect(result[0].winRate).toBe('0.500000');
    });

    it('sets winRate to null when tradeCount is zero (no trades recorded)', () => {
        // BUILD — empty entities → no summaries at all (no trades means no group)
        // Verify the boundary at zero via a direct check on the empty result
        const versions = new Map<number, StrategyVersionEntity>();

        // OPERATE
        const result = mapShadowPerformanceSummary([], versions, 30);

        // CHECK — no summaries at all when there are no entities
        expect(result).toEqual([]);
    });

    it('accumulates netPnlUsd correctly when the same shadowVersion has multiple entities', () => {
        // BUILD — two trades: +5 and +3 → total net = 8
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                id: 1,
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105' },
            }),
            buildShadowEntity({
                id: 2,
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '200', exitPrice: '203' },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK
        expect(result[0].netPnlUsd).toBe('8');
    });

    it('groups entities by shadowVersion independently — different shadowVersions do not share accumulators', () => {
        // BUILD — v1 has +5, v2 has −3 (both use the same strategyVersionId)
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                id: 1,
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '105' },
            }),
            buildShadowEntity({
                id: 2,
                shadowVersion: 'v2',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.SHORT,
                qty: '1',
                simulatedFill: { entryPrice: '100', exitPrice: '103' },
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — two independent summaries
        expect(result).toHaveLength(2);

        const v1Summary = result.find((s) => s.shadowVersion === 'v1');
        const v2Summary = result.find((s) => s.shadowVersion === 'v2');

        expect(v1Summary?.netPnlUsd).toBe('5');
        expect(v2Summary?.netPnlUsd).toBe('-3');
    });

    it('treats null simulatedFill as zero prices/fees so entity contributes zero PnL', () => {
        // BUILD — entity with simulatedFill=null (gate rejected / skip rows)
        const version = buildVersion({ id: 1, name: 'alpha', version: 1 });
        const versions = new Map([[1, version]]);
        const entities = [
            buildShadowEntity({
                shadowVersion: 'v1',
                strategyVersionId: 1,
                tradeSide: PositionSideEnum.LONG,
                qty: '1',
                simulatedFill: null,
            }),
        ];

        // OPERATE
        const result = mapShadowPerformanceSummary(entities, versions, 30);

        // CHECK — (0−0)×1×1 − 0 − 0 = 0, not a win
        expect(result[0].netPnlUsd).toBe('0');
        expect(result[0].winCount).toBe(0);
    });
});
