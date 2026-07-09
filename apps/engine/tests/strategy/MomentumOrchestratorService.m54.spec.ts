/**
 * MomentumOrchestratorService — M54 D2 adversarial QA (docs/plans/M54-xmom-entry-geometry-expected-fill.md §9).
 *
 * Covers plan §9 items 1 (no-op), 2 (anchor pins the offset), 3 (referencePrice/midAtTrigger
 * unchanged), 5 (sizer notional unchanged), 6 (skip fails closed), 7 (skip fires only above budget),
 * 8 (schema coupling), 10 (no new nondeterminism). Item 4 (slFloor outcome-may-flip) lives in
 * `exitGeometryHelper.m54.spec.ts` (pure-function level, no orchestrator needed). Item 9 (M52 retry
 * inherits the skip) lives in `MomentumOrchestratorService.m54.retry.spec.ts` (needs the armed-retry
 * harness). Item 11 (guard untouched) is a source-boundary check in `exitGeometryHelper.m54.spec.ts`.
 *
 * Harness mirrors `MomentumOrchestratorService.m53.spec.ts` — a real `onRebalanceDue` open leg,
 * inspecting the emitted `ORDER_INTENT_APPROVED_EVENT` payload. `buildSymbolState` here additionally
 * accepts configurable spread/depth so each test can pin the two new liquidity inputs independently.
 */

import {
    CoinTierEnum,
    ExchangeEnvironmentEnum,
    momentumParamsSchema,
    PortfolioSelectionReasonEnum,
    RebalanceTriggerSourceEnum,
    RiskOutcomeEnum,
} from '@bot/shared';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORDER_INTENT_APPROVED_EVENT } from '../../src/common/const';
import { AppConfigService } from '../../src/config/service';
import { ICandle } from '../../src/market-data/interface/ICandle';
import { CandleRepository } from '../../src/market-data/repository/CandleRepository';
import { UniverseMembershipRepository } from '../../src/market-data/repository/UniverseMembershipRepository';
import { SymbolStateRegistry } from '../../src/market-data/service/SymbolStateRegistry';
import { UniverseService } from '../../src/market-data/service/UniverseService';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { InstrumentPortAdapter, OpenPositionsPortAdapter, PositionSizer, RiskGateService, RiskStatePortAdapter } from '../../src/risk/service';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { MomentumOrchestratorService } from '../../src/strategy/service/MomentumOrchestratorService';
import { XMomPortfolioStrategy } from '../../src/strategy/strategies/XMomPortfolioStrategy';
import { Money, MoneyValue } from '../../src/common/utils/money';

const NOW_MS = 1_700_000_000_000;
const ACTIVE_VERSION_ID = 7;
const ENTRY_PRICE = 100; // buildMockBars() closes are flat at 100 — P0
const MOCK_NOTIONAL = 100; // fixed sizer.size() mock output notional

function buildMockBars(count = 20): ICandle[] {
    // Flat close=100, H=110/L=90 every bar → true range converges to a constant 20 → ATR = 20 exactly.
    return Array.from({ length: count }, (_, index) => ({
        openTimeMs: NOW_MS - (count - index) * 5 * 60_000,
        open: new Money('100'),
        high: new Money('110'),
        low: new Money('90'),
        close: new Money('100'),
        volume: new Money('1000'),
        quoteVolume: new Money('100000'),
        isClosed: true,
    }));
}

function buildSymbolState(spreadPct: number | null = 0, bookDepth10bpsUsdt: MoneyValue | null = new Money('0')) {
    const bars = buildMockBars();

    return {
        movePctOverWindow: jest.fn().mockReturnValue(5.0),
        candles5m: {
            getLatestClosedBar: jest.fn().mockReturnValue(bars[bars.length - 1]),
            getClosedBars: jest.fn().mockReturnValue(bars),
        },
        getFundingRate: jest.fn().mockReturnValue(0),
        getFundingRateAnnualized: jest.fn().mockReturnValue(0),
        getSpreadPct: jest.fn().mockReturnValue(spreadPct),
        latestOpenInterest: jest.fn().mockReturnValue(new Money('0')),
        getBookDepth10bpsUsdt: jest.fn().mockReturnValue(bookDepth10bpsUsdt),
        getBookDepth50bpsUsdt: jest.fn().mockReturnValue(new Money('0')),
    };
}

function buildMembershipEntry(symbol: string) {
    return { symbol, volumeRank: 1, tier: CoinTierEnum.TIER_1, quoteVolume24h: new Money('1000000') };
}

function buildApprovedDecision() {
    return {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: null,
        approvedSizing: {
            qty: new Money('0.01'),
            notional: new Money(MOCK_NOTIONAL),
            leverage: new Money('1'),
            riskPerTradeUsdt: new Money('10'),
            effectiveRiskUsdt: new Money('10'),
        },
        clampedExit: null,
        haltReasonDetail: null,
        reservationId: 'test-res',
    };
}

interface IMockSet {
    config: Record<string, unknown>;
    strategyVersions: { findById: jest.Mock };
    universe: { getEntries: jest.Mock; getEntry: jest.Mock };
    symbolStates: { get: jest.Mock };
    candles: { findRange: jest.Mock };
    positions: { findOpen: jest.Mock };
    riskGate: { evaluate: jest.Mock };
    instrumentPort: { findConstraints: jest.Mock };
    sizer: { size: jest.Mock };
    riskStatePort: Record<string, jest.Mock>;
    openPositionsPort: Record<string, jest.Mock>;
    universeMembership: { findOpenMembership: jest.Mock };
    decisions: { record: jest.Mock };
    strategy: { selectUniverse: jest.Mock };
    events: { emit: jest.Mock };
}

/** `params` is passed through untouched — the real momentumParamsSchema.parse applies defaults
 * (mirrors the M53 harness), so a test can omit any M54 key and get the schema default. */
function buildDefaultMocks(params: Record<string, unknown>, spreadPct: number | null = 0, bookDepth10bpsUsdt: MoneyValue | null = new Money('0')): IMockSet {
    return {
        config: {
            exchangeEnv: ExchangeEnvironmentEnum.PAPER,
            activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            accountCapitalUsdt: 1000,
            maxOpenPositions: 3,
            maxExposurePerCoinUsdt: 500,
            dailyLossLimitUsdt: 100,
            weeklyLossLimitUsdt: 300,
            maxSameDirectionExposureUsdt: 800,
            cooldownAfterLossMs: 0,
            paperRelaxConsecutiveLossHalt: false,
        },
        strategyVersions: {
            findById: jest.fn().mockResolvedValue({ id: ACTIVE_VERSION_ID, name: 'xmom', version: 1, params }),
        },
        universe: {
            getEntries: jest.fn().mockReturnValue([buildMembershipEntry('BTCUSDT')]),
            getEntry: jest.fn().mockReturnValue(buildMembershipEntry('BTCUSDT')),
        },
        symbolStates: { get: jest.fn().mockReturnValue(buildSymbolState(spreadPct, bookDepth10bpsUsdt)) },
        candles: { findRange: jest.fn().mockResolvedValue(buildMockBars()) },
        positions: { findOpen: jest.fn().mockResolvedValue([]) },
        riskGate: { evaluate: jest.fn().mockResolvedValue(buildApprovedDecision()) },
        instrumentPort: {
            findConstraints: jest.fn().mockResolvedValue({
                symbol: 'BTCUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.1'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        },
        sizer: {
            size: jest.fn().mockReturnValue({
                kind: 'sized',
                sizing: {
                    qty: new Money('0.01'),
                    notional: new Money(MOCK_NOTIONAL),
                    leverage: new Money('1'),
                    riskPerTradeUsdt: new Money('10'),
                    effectiveRiskUsdt: new Money('10'),
                },
            }),
        },
        riskStatePort: {
            getDay: jest.fn().mockResolvedValue(null),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money('0')),
            upsertDay: jest.fn().mockResolvedValue(undefined),
        },
        openPositionsPort: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
            findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
            countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
        },
        universeMembership: { findOpenMembership: jest.fn().mockResolvedValue({}) },
        decisions: { record: jest.fn().mockResolvedValue({}) },
        strategy: {
            selectUniverse: jest
                .fn()
                .mockReturnValue({ ranked: [{ symbol: 'BTCUSDT', rank: 1, trailingReturnPct: 5.0 }], reason: PortfolioSelectionReasonEnum.RANKED }),
        },
        events: { emit: jest.fn() },
    };
}

async function buildTestModule(mocks: IMockSet): Promise<{ service: MomentumOrchestratorService; mocks: IMockSet }> {
    const module: TestingModule = await Test.createTestingModule({
        providers: [
            MomentumOrchestratorService,
            { provide: AppConfigService, useValue: mocks.config },
            { provide: StrategyVersionRepository, useValue: mocks.strategyVersions },
            { provide: UniverseService, useValue: mocks.universe },
            { provide: SymbolStateRegistry, useValue: mocks.symbolStates },
            { provide: CandleRepository, useValue: mocks.candles },
            { provide: PositionRepository, useValue: mocks.positions },
            { provide: RiskGateService, useValue: mocks.riskGate },
            { provide: InstrumentPortAdapter, useValue: mocks.instrumentPort },
            { provide: PositionSizer, useValue: mocks.sizer },
            { provide: RiskStatePortAdapter, useValue: mocks.riskStatePort },
            { provide: OpenPositionsPortAdapter, useValue: mocks.openPositionsPort },
            { provide: UniverseMembershipRepository, useValue: mocks.universeMembership },
            { provide: DecisionRepository, useValue: mocks.decisions },
            { provide: XMomPortfolioStrategy, useValue: mocks.strategy },
            { provide: EventEmitter2, useValue: mocks.events },
        ],
    }).compile();

    return { service: module.get(MomentumOrchestratorService), mocks };
}

/** Runs one BTCUSDT open leg and returns { payload, mocks } — payload undefined if no approval fired. */
async function runOpen(
    params: Record<string, unknown>,
    spreadPct: number | null = 0,
    bookDepth10bpsUsdt: MoneyValue | null = new Money('0'),
): Promise<{ payload: any; mocks: IMockSet }> {
    const mocks = buildDefaultMocks(params, spreadPct, bookDepth10bpsUsdt);
    const { service } = await buildTestModule(mocks);

    await service.onRebalanceDue({ nowMs: NOW_MS, triggerSource: RebalanceTriggerSourceEnum.SCHEDULED });

    const approvedEmit = mocks.events.emit.mock.calls.find(([eventName]) => eventName === ORDER_INTENT_APPROVED_EVENT);

    return { payload: approvedEmit?.[1], mocks };
}

const BASE_PARAMS = {
    top_n: 1,
    lookback_ms: 86_400_000,
    rebalance_interval_ms: 86_400_000,
    min_universe_size: 5,
    xmom_atr_stop_multiplier: 2.0,
    xmom_min_rr: 1.5,
    xmom_tp_arm_rr: 1.5,
};

// ─── Item 1 — no-op at defaults ──────────────────────────────────────────────

describe('MomentumOrchestratorService — M54 item 1: no-op at defaults (params={} / enabled=false)', () => {
    it('arms SL/TP off P0 byte-identical to pre-M54 when xmom_expected_fill_enabled is omitted', async () => {
        const { payload } = await runOpen(BASE_PARAMS, 0.5, new Money('0'));

        expect(payload).toBeDefined();

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedSl = new Money(ENTRY_PRICE).minus(atrDistance.times(2.0));
        const expectedTp = new Money(ENTRY_PRICE).plus(atrDistance.times(2.0).times(1.5));

        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(expectedSl.toFixed(8));
        expect(payload.intent.proposedExit.takeProfitPrice.toFixed(8)).toBe(expectedTp.toFixed(8));
        expect(payload.intent.entryPrice.toFixed(8)).toBe(new Money(ENTRY_PRICE).toFixed(8));
    });

    it('never skips a candidate on depth even at zero book depth, when xmom_max_depth_fraction is null (skip disabled by default)', async () => {
        const { payload } = await runOpen(BASE_PARAMS, 0.5, new Money('0'));

        expect(payload).toBeDefined();
    });

    it('arms identically when xmom_expected_fill_enabled is explicitly false', async () => {
        const { payload } = await runOpen({ ...BASE_PARAMS, xmom_expected_fill_enabled: false }, 0.5, new Money('0'));

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance;
        const expectedSl = new Money(ENTRY_PRICE).minus(atrDistance.times(2.0));

        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(expectedSl.toFixed(8));
    });
});

// ─── Item 2 — anchor pins the offset, not a bare price ───────────────────────

describe('MomentumOrchestratorService — M54 item 2: anchor pins the offset F_exp = P0 × (1 + halfSpread/100)', () => {
    it('arms SL/TP off F_exp, and a fill AT F_exp realizes R:R = arm ratio (clears the floor) while the old P0 anchor would not', async () => {
        const spreadPct = 0.2; // halfSpread = 0.10%
        const { payload } = await runOpen(
            { ...BASE_PARAMS, xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 1_000_000 },
            spreadPct,
            new Money('1000000'),
        );

        expect(payload).toBeDefined();

        const atrDistance: MoneyValue = payload.intent.proposedExit.atrDistance; // D
        const stopDistance = atrDistance.times(2.0); // D
        const p0 = new Money(ENTRY_PRICE);
        const fExp = p0.times(1 + spreadPct / 2 / 100);

        const expectedSl = fExp.minus(stopDistance);
        const expectedTp = fExp.plus(stopDistance.times(1.5));

        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(expectedSl.toFixed(8));
        expect(payload.intent.proposedExit.takeProfitPrice.toFixed(8)).toBe(expectedTp.toFixed(8));

        // At a fill F = F_exp (residual r = 0), realized R:R against THIS anchor:
        const fill = fExp;
        const slDistAtFill = fill.minus(expectedSl);
        const tpDistAtFill = expectedTp.minus(fill);
        const realizedRrM54 = tpDistAtFill.dividedBy(slDistAtFill).toNumber();

        expect(realizedRrM54).toBeCloseTo(1.5, 10); // exactly the arm ratio a

        // Contrast: the SAME fill under the OLD P0 anchor (slippage s = fExp vs P0, as a fraction of D).
        const slippageFractionS = fill.minus(p0).dividedBy(stopDistance).toNumber();
        const oldSl = p0.minus(stopDistance);
        const oldTp = p0.plus(stopDistance.times(1.5));
        const oldSlDistAtFill = fill.minus(oldSl);
        const oldTpDistAtFill = oldTp.minus(fill);
        const realizedRrOldAnchor = oldTpDistAtFill.dividedBy(oldSlDistAtFill).toNumber();

        expect(slippageFractionS).toBeGreaterThan(0); // adverse slippage relative to P0
        expect(realizedRrOldAnchor).toBeLessThan(1.5); // (a-s)/(1+s) < a for s>0
        expect(realizedRrOldAnchor).toBeLessThan(realizedRrM54);
    });
});

// ─── Item 3 — referencePrice / midAtTrigger stay P0 ──────────────────────────

describe('MomentumOrchestratorService — M54 item 3: referencePrice, midAtTrigger, entryPrice stay P0 when the anchor moves', () => {
    it('leaves entryPrice/referencePrice/midAtTrigger at the signal price P0 even with the anchor enabled', async () => {
        const { payload } = await runOpen({ ...BASE_PARAMS, xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 1_000_000 }, 0.5, new Money('1000000'));

        const p0 = new Money(ENTRY_PRICE);

        expect(payload.intent.entryPrice.toFixed(8)).toBe(p0.toFixed(8));
        expect(payload.intent.referencePrice.toFixed(8)).toBe(p0.toFixed(8));
        expect(payload.intent.midAtTrigger.toFixed(8)).toBe(p0.toFixed(8));

        // Sanity: entryPrice is NOT the anchored F_exp (they must diverge given nonzero spread).
        expect(payload.intent.entryPrice.toFixed(8)).not.toBe(
            payload.intent.proposedExit.stopLossPrice.plus(payload.intent.proposedExit.atrDistance.times(2.0)).toFixed(8),
        );
    });
});

// ─── Item 5 — sizer notional unchanged (stopDistance fed to sizer stays D) ───

describe('MomentumOrchestratorService — M54 item 5: sizer receives entryPrice=F_exp / stopLossPrice=F_exp-D, so stopDistance stays D', () => {
    it('feeds the sizer a stopDistance of exactly D with the anchor enabled, matching the P0-anchored baseline', async () => {
        const paramsAnchored = { ...BASE_PARAMS, xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 1_000_000 };
        const { mocks: anchoredMocks } = await runOpen(paramsAnchored, 0.5, new Money('1000000'));
        const { mocks: baselineMocks } = await runOpen(BASE_PARAMS, 0.5, new Money('1000000'));

        const anchoredCall = anchoredMocks.sizer.size.mock.calls[0][0];
        const baselineCall = baselineMocks.sizer.size.mock.calls[0][0];

        const anchoredStopDistance: MoneyValue = anchoredCall.entryPrice.minus(anchoredCall.stopLossPrice);
        const baselineStopDistance: MoneyValue = baselineCall.entryPrice.minus(baselineCall.stopLossPrice);

        expect(anchoredStopDistance.toFixed(8)).toBe(baselineStopDistance.toFixed(8));

        // The anchor DOES move entryPrice fed to the sizer (F_exp != P0), only stopDistance is pinned.
        expect(anchoredCall.entryPrice.toFixed(8)).not.toBe(baselineCall.entryPrice.toFixed(8));
    });
});

// ─── Item 6 — skip fails CLOSED on bad data ──────────────────────────────────

describe('MomentumOrchestratorService — M54 item 6: skip fails CLOSED on null/≤0 depth; spread null/0 no-ops the anchor without skipping', () => {
    const skipParams = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: 100 };

    it('skips the candidate when book_depth_10bps_usdt is null', async () => {
        const { payload } = await runOpen(skipParams, 0, null);

        expect(payload).toBeUndefined();
    });

    it('skips the candidate when book_depth_10bps_usdt is exactly 0', async () => {
        const { payload } = await runOpen(skipParams, 0, new Money('0'));

        expect(payload).toBeUndefined();
    });

    it('skips the candidate when book_depth_10bps_usdt is negative', async () => {
        const { payload } = await runOpen(skipParams, 0, new Money('-5'));

        expect(payload).toBeUndefined();
    });

    it('does NOT skip on spread alone when spread is null — the anchor no-ops (F_exp=P0) but depth is healthy', async () => {
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: 1_000_000 };
        const { payload } = await runOpen(params, null, new Money('1000000'));

        expect(payload).toBeDefined();
        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(
            new Money(ENTRY_PRICE).minus(payload.intent.proposedExit.atrDistance.times(2.0)).toFixed(8),
        );
    });

    it('does NOT skip on spread alone when spread is exactly 0 — the anchor no-ops but depth is healthy', async () => {
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 1_000_000 };
        const { payload } = await runOpen(params, 0, new Money('1000000'));

        expect(payload).toBeDefined();
        // Anchor no-op: F_exp = P0 exactly, since halfSpread resolves to 0 on a ≤0 spread reading.
        expect(payload.intent.proposedExit.stopLossPrice.toFixed(8)).toBe(
            new Money(ENTRY_PRICE).minus(payload.intent.proposedExit.atrDistance.times(2.0)).toFixed(8),
        );
    });
});

// ─── Item 7 — skip fires only above budget ───────────────────────────────────

describe('MomentumOrchestratorService — M54 item 7: skip fires only when orderNotional/depth exceeds xmom_max_depth_fraction', () => {
    // Fixed mock notional = 100. Budget = 0.5 → threshold depth = 200.
    const budget = 0.5;

    it('skips (no intent) when depthFraction is just ABOVE the budget', async () => {
        const depth = new Money('190'); // 100/190 ≈ 0.526 > 0.5
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: budget };
        const { payload } = await runOpen(params, 0, depth);

        expect(payload).toBeUndefined();
    });

    it('builds the intent normally when depthFraction is just BELOW the budget', async () => {
        const depth = new Money('210'); // 100/210 ≈ 0.476 < 0.5
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: budget };
        const { payload } = await runOpen(params, 0, depth);

        expect(payload).toBeDefined();
    });

    it('builds the intent normally when depthFraction is EXACTLY at the budget (strict > required to skip)', async () => {
        const depth = new Money('200'); // 100/200 = 0.5 exactly
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: budget };
        const { payload } = await runOpen(params, 0, depth);

        expect(payload).toBeDefined();
    });
});

// ─── Item 8 — schema coupling enforced ───────────────────────────────────────

describe('momentumParamsSchema — M54 item 8: xmom_expected_fill_enabled requires a finite xmom_max_depth_fraction', () => {
    it('throws when enabled=true and xmom_max_depth_fraction is absent', () => {
        expect(() => momentumParamsSchema.parse({ xmom_expected_fill_enabled: true })).toThrow();
    });

    it('throws when enabled=true and xmom_max_depth_fraction is explicitly null', () => {
        expect(() => momentumParamsSchema.parse({ xmom_expected_fill_enabled: true, xmom_max_depth_fraction: null })).toThrow();
    });

    it('throws when enabled=true and xmom_max_depth_fraction is non-finite (Infinity)', () => {
        expect(() => momentumParamsSchema.parse({ xmom_expected_fill_enabled: true, xmom_max_depth_fraction: Infinity })).toThrow();
    });

    it('throws when enabled=true and xmom_max_depth_fraction is not positive (0 or negative)', () => {
        expect(() => momentumParamsSchema.parse({ xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 0 })).toThrow();
        expect(() => momentumParamsSchema.parse({ xmom_expected_fill_enabled: true, xmom_max_depth_fraction: -1 })).toThrow();
    });

    it('parses when enabled=true and xmom_max_depth_fraction is a finite positive number', () => {
        const parsed = momentumParamsSchema.parse({ xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 0.1 });

        expect(parsed.xmom_expected_fill_enabled).toBe(true);
        expect(parsed.xmom_max_depth_fraction).toBe(0.1);
    });

    it('parses skip-only config: enabled=false with a finite budget', () => {
        const parsed = momentumParamsSchema.parse({ xmom_expected_fill_enabled: false, xmom_max_depth_fraction: 0.1 });

        expect(parsed.xmom_expected_fill_enabled).toBe(false);
        expect(parsed.xmom_max_depth_fraction).toBe(0.1);
    });

    it('parses the full no-op default: params={}', () => {
        const parsed = momentumParamsSchema.parse({});

        expect(parsed.xmom_expected_fill_enabled).toBe(false);
        expect(parsed.xmom_max_depth_fraction).toBeNull();
    });
});

// ─── Item 10 — no new nondeterminism ─────────────────────────────────────────

describe('MomentumOrchestratorService — M54 item 10: same snapshot → same F_exp, same skip decision (determinism)', () => {
    it('two independent rebalances with identical inputs produce an identical anchored SL/TP', async () => {
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: true, xmom_max_depth_fraction: 0.5 };

        const runOne = await runOpen(params, 0.2, new Money('1000'));
        const runTwo = await runOpen(params, 0.2, new Money('1000'));

        expect(runOne.payload).toBeDefined();
        expect(runTwo.payload).toBeDefined();
        expect(runOne.payload.intent.proposedExit.stopLossPrice.toFixed(18)).toBe(runTwo.payload.intent.proposedExit.stopLossPrice.toFixed(18));
        expect(runOne.payload.intent.proposedExit.takeProfitPrice.toFixed(18)).toBe(runTwo.payload.intent.proposedExit.takeProfitPrice.toFixed(18));
    });

    it('two independent rebalances at an identical budget-exceeding depth produce the SAME skip decision (both skipped)', async () => {
        const params = { ...BASE_PARAMS, xmom_expected_fill_enabled: false, xmom_max_depth_fraction: 0.5 };

        const runOne = await runOpen(params, 0, new Money('190'));
        const runTwo = await runOpen(params, 0, new Money('190'));

        expect(runOne.payload).toBeUndefined();
        expect(runTwo.payload).toBeUndefined();
    });
});
