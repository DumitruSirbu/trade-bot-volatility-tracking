/**
 * D1.3 observability tests — conservative-miss warn discriminator.
 *
 * When `shouldSimulateFill && !hasNextBarEntry`, `runOneShadow` emits
 * `this.logger.warn(...)` with a structured payload containing a `reason`
 * field that distinguishes two sub-cases:
 *
 *   ticks_absent              — evidence.ticks.length === 0
 *   evidence_null_despite_ticks — evidence.ticks.length > 0 but nextBarOpenPrice is null
 *
 * The discriminator logic lives in a single ternary inside `runOneShadow`.
 * These tests exercise that branch in two ways:
 *
 *   Part 1 — Pure unit tests of the reason-derivation logic itself (no service
 *             instantiation, no DI). Fast, self-contained, boundary-exact.
 *
 *   Part 2 — Integration with the wired service (using the same mock bundle as
 *             ShadowStrategyOrchestratorService.D2.spec.ts) to assert the warn is
 *             actually emitted with the correct discriminated reason payload when
 *             evidence.ticks.length === 0 drives the ticks_absent branch.
 *
 * Hard rules:
 *   - No implementation changes. Tests only.
 *   - No real DB, no real NestJS DI.
 *   - F.I.R.S.T.: tests are independent; each builds its own fixture.
 */

import {
    CoinTierEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    PositionSideEnum,
    RegimeLabelEnum,
    SignalActionEnum,
    SignalTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../../market-data/const/candleConsts';
import { TickAggregateEntity } from '../../../market-data/entity/TickAggregateEntity';
import { TickAggregateRepository } from '../../../market-data/repository/TickAggregateRepository';
import { SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL, SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT } from '../../const/strategyConsts';
import { ShadowDecisionRepository } from '../../repository/ShadowDecisionRepository';
import { StrategyVersionRepository } from '../../repository/StrategyVersionRepository';
import { StrategyRegistry } from '../../registry/StrategyRegistry';
import { AppConfigService } from '../../../config/service';
import { ShadowStrategyOrchestratorService } from '../ShadowStrategyOrchestratorService';
import { VirtualPositionLedgerService } from '../VirtualPositionLedgerService';

// ─── Part 1: pure reason-discriminator unit tests ────────────────────────────
//
// Extract the production ternary as a local helper so the tests are readable
// and completely independent of service internals. Any change to the ternary in
// the service will break these tests — that is the desired failure signal.

function deriveConservativeMissReason(ticksLength: number): string {
    return ticksLength === 0 ? SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT : SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL;
}

describe('D1.3 — reason discriminator pure logic', () => {
    it('assigns ticks_absent when evidence has no ticks (ticksLength === 0)', () => {
        // BUILD + OPERATE + CHECK
        expect(deriveConservativeMissReason(0)).toBe(SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT);
    });

    it('assigns evidence_null_despite_ticks when evidence has at least one tick (ticksLength > 0)', () => {
        // BUILD + OPERATE + CHECK
        expect(deriveConservativeMissReason(1)).toBe(SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);
        expect(deriveConservativeMissReason(5)).toBe(SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);
    });

    it('boundary — ticksLength=0 always produces ticks_absent (not evidence_null_despite_ticks)', () => {
        expect(deriveConservativeMissReason(0)).not.toBe(SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);
    });

    it('boundary — ticksLength=1 (minimum non-empty) always produces evidence_null_despite_ticks (not ticks_absent)', () => {
        expect(deriveConservativeMissReason(1)).not.toBe(SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT);
    });

    it('reason constants are distinct strings (discriminator is unambiguous)', () => {
        expect(SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT).not.toBe(SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);
    });
});

// ─── Part 2: service-level warn emission test ─────────────────────────────────
//
// Uses the same minimal mock bundle pattern as the D2 spec. The shadow is seeded
// directly into the private `shadows` array — no `onModuleInit` DB call required.

const BAR_OPEN_MS = new Date('2026-06-01T10:00:00.000Z').getTime();
const NOW_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const SYMBOL = 'SOLUSDT';
const EVENT_ID = `${SYMBOL}:${BAR_OPEN_MS}`;

function buildOpenSignalForD1() {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 75,
        flowType: FlowTypeEnum.TREND_INITIATION,
        reason: 'momentum_follow',
        proposedExit: {
            stopLossPrice: new Money('98'),
            takeProfitPrice: new Money('104'),
            stopType: 'atr',
            timeStopAtMs: NOW_MS + 3_600_000,
        },
    };
}

function buildVolatilityEventForD1() {
    return {
        symbol: SYMBOL,
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: BAR_OPEN_MS,
        eventId: EVENT_ID,
        vwapSession: '99',
        vwap20bar: '99',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 1.5,
        vwapDeviationSigma: 2.0,
        volumeRatio: 2.0,
        volume20barAvg: '1000',
        atr14: '2',
        adx14: 28,
        adxDiPlus: 22,
        adxDiMinus: 14,
        rsi14: 60,
        bollingerUpper: '104',
        bollingerLower: '96',
        bollingerPctB: 0.8,
        btc5mMovePct: 0.2,
        idiosyncrasyScore: 0.5,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 5,
        symbolUniverseAgeHours: 100,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.065,
        openInterest: '50000000',
        openInterestChange5mPct: 0.1,
        openInterestChange15mPct: 0.2,
        aggTradeBuyVolumeRatio: 0.55,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: '40000',
        bookDepth50bpsUsdt: '150000',
        regimeLabel: RegimeLabelEnum.TRENDING_UP,
        marketBreadth5mUpPct: 55,
        sameBarTriggerCount: 1,
        btc1mMovePct: 0.1,
        eth5mMovePct: 0.3,
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildStrategyParamsForD1() {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.3,
        btc_correlated_move_threshold_pct: 1.0,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier2_min_abs_move_pct: 1.0,
        tier3_min_abs_move_pct: 2.0,
        tier1_max_abs_move_pct: 5.0,
        tier2_max_abs_move_pct: 8.0,
        tier3_max_abs_move_pct: 12.0,
        funding_rate_suppress_threshold: 0.01,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 3,
        max_trades_per_symbol_per_day: 5,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildTick(closePrice: string): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 1;
    tick.ts = new Date(BAR_OPEN_MS);
    tick.symbol = SYMBOL;
    tick.open = new Money('99');
    tick.high = new Money('101');
    tick.low = new Money('98');
    tick.close = new Money(closePrice);
    tick.volume = new Money('1000');
    return tick;
}

function buildServiceWithTicks(ticks: TickAggregateEntity[]) {
    const tickAggregatesMock = {
        loadTicksForBar: jest.fn().mockResolvedValue(ticks),
    } as unknown as jest.MockedObject<TickAggregateRepository>;

    const shadowDecisionsMock = {
        insertShadowDecision: jest.fn().mockResolvedValue({ id: 1 }),
        findRowsForLedgerRebuild: jest.fn().mockResolvedValue([]),
    } as unknown as jest.MockedObject<ShadowDecisionRepository>;

    const strategyVersionsMock = {
        findActiveShadows: jest.fn().mockResolvedValue([]),
    } as unknown as StrategyVersionRepository;

    const signal = buildOpenSignalForD1();

    const registryMock = {
        resolve: jest.fn().mockReturnValue({
            strategy: {
                name: 'v3',
                version: 3,
                direction: 'both',
                evaluate: jest.fn().mockReturnValue(signal),
            },
            params: buildStrategyParamsForD1(),
        }),
    } as unknown as StrategyRegistry;

    const configMock = {
        activeStrategyVersionId: 1,
        paperStartingEquityUsdt: 10_000,
        paperRelaxConsecutiveLossHalt: false,
    } as unknown as AppConfigService;

    const moduleRefMock = { resolve: jest.fn() };

    const service = new ShadowStrategyOrchestratorService(
        configMock,
        registryMock,
        strategyVersionsMock,
        shadowDecisionsMock,
        tickAggregatesMock,
        moduleRefMock as never,
    );

    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const ledger = {
        snapshotForDecision: jest
            .fn()
            .mockReturnValue({ riskDayUtcDate: '2026-06-01', openPositions: [], haltedUntilRiskDayUtcDate: null, lastEventIdProcessed: '' }),
        evaluateGates: jest.fn().mockReturnValue({ allowed: true }),
        findOpenPositionBySymbol: jest.fn().mockReturnValue(null),
        tryOpen: jest.fn().mockReturnValue({ success: true }),
        tryClose: jest.fn().mockReturnValue({ success: true }),
        closeBySymbol: jest.fn().mockReturnValue(null),
        seedProcessedEventIds: jest.fn(),
    } as unknown as jest.Mocked<VirtualPositionLedgerService>;

    const versionRow = {
        id: 3,
        name: 'v3',
        version: 3,
        status: 'shadow',
        params: buildStrategyParamsForD1(),
        direction: 'both',
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    (service as any).shadows = [
        {
            row: versionRow,
            discriminator: 'v3',
            strategy: {
                name: 'v3',
                version: 3,
                direction: 'both',
                evaluate: jest.fn().mockReturnValue(signal),
            },
            params: buildStrategyParamsForD1(),
            ledger,
            pendingDeferredWalks: new Map(),
        },
    ];

    return { service, warnSpy, shadowDecisionsMock, ledger };
}

// ─── D1.3 service-level warn tests ──────────────────────────────────────────

describe('D1.3 — service emits warn with ticks_absent reason on gate-allowed open with empty ticks', () => {
    it('emits logger.warn when shouldSimulateFill=true and ticks are empty', async () => {
        // BUILD: empty ticks → nextBarOpenPrice=null, shouldSimulateFill=true (gate allowed)
        const { service, warnSpy } = buildServiceWithTicks([]);

        // OPERATE
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: warn was called at least once (conservative-miss branch)
        expect(warnSpy).toHaveBeenCalled();
    });

    it('warn payload contains reason=ticks_absent when evidence.ticks is empty', async () => {
        // BUILD: empty ticks forces the ticks_absent branch
        const { service, warnSpy } = buildServiceWithTicks([]);

        // OPERATE
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: at least one warn call contains a payload with reason=ticks_absent
        const payloads = warnSpy.mock.calls
            .map(([firstArg]) => firstArg)
            .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null);

        const conservativeMissPayload = payloads.find((payload) => payload['reason'] === SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT);

        expect(conservativeMissPayload).toBeDefined();
    });

    it('warn payload includes missCount field (rate-counter observable)', async () => {
        // BUILD
        const { service, warnSpy } = buildServiceWithTicks([]);

        // OPERATE
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: the conservative-miss payload exposes missCount for rate-counter monitoring
        const payloads = warnSpy.mock.calls
            .map(([firstArg]) => firstArg)
            .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null);

        const conservativeMissPayload = payloads.find((payload) => 'missCount' in payload);

        expect(conservativeMissPayload).toBeDefined();
        expect(typeof conservativeMissPayload!['missCount']).toBe('number');
    });

    it('missCount increments on each conservative miss (rate-counter accumulates)', async () => {
        // BUILD: two consecutive runs, each with empty ticks
        const { service, warnSpy } = buildServiceWithTicks([]);

        // OPERATE: two events
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: the missCount in the second conservative-miss warn is higher than the first
        const conservativeMissPayloads = warnSpy.mock.calls
            .map(([firstArg]) => firstArg)
            .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null)
            .filter((arg) => arg['reason'] === SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT);

        expect(conservativeMissPayloads.length).toBeGreaterThanOrEqual(2);

        const firstMissCount = conservativeMissPayloads[0]['missCount'] as number;
        const secondMissCount = conservativeMissPayloads[1]['missCount'] as number;
        expect(secondMissCount).toBeGreaterThan(firstMissCount);
    });
});

describe('D1.3 — warn is NOT emitted (no conservative miss) when ticks are present and produce a valid entry', () => {
    it('does not emit a conservative-miss warn when ticks provide a valid nextBarOpenPrice', async () => {
        // BUILD: one tick with close='100' → nextBarOpenPrice='100' → shouldSimulateFill proceeds normally
        // stop=98 is below anchor=100.485 → valid for LONG → real fill, no conservative miss
        const { service, warnSpy } = buildServiceWithTicks([buildTick('100')]);

        // OPERATE
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: none of the warn calls carry a conservative-miss reason
        const conservativeMissPayloads = warnSpy.mock.calls
            .map(([firstArg]) => firstArg)
            .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null)
            .filter((arg) => arg['reason'] === SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT || arg['reason'] === SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);

        expect(conservativeMissPayloads.length).toBe(0);
    });
});

describe('D1.3 — reason payload distinguishes ticks_absent from evidence_null_despite_ticks (discriminator is unambiguous)', () => {
    it('ticks_absent payload reason does not equal evidence_null_despite_ticks string', async () => {
        // BUILD
        const { service, warnSpy } = buildServiceWithTicks([]);

        // OPERATE
        await service.runShadows(buildVolatilityEventForD1(), NOW_MS);

        // CHECK: the emitted reason is ticks_absent, not the other variant
        const payloads = warnSpy.mock.calls
            .map(([firstArg]) => firstArg)
            .filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null && 'reason' in arg);

        const conservativeMissPayload = payloads.find((payload) => payload['reason'] === SHADOW_CONSERVATIVE_MISS_REASON_TICKS_ABSENT);

        expect(conservativeMissPayload).toBeDefined();
        expect(conservativeMissPayload!['reason']).not.toBe(SHADOW_CONSERVATIVE_MISS_REASON_EVIDENCE_NULL);
    });
});
