/**
 * ShadowStrategyOrchestratorService — M39 W1: in-pass close and rebuild close path.
 *
 * Surfaces under test:
 *
 * Group 2 — in-pass close (live runShadows path)
 *
 *   IP1 — After a gate-allowed OPEN with a TP-breaching tick, countOpenPositions() = 0
 *          (in-pass closeBySymbol freed the slot before runShadows returned).
 *
 *   IP2 — Replaying the same eventId a second time does NOT double-open or double-close
 *          (idempotency: the `:exit` close eventId deduplicates, the open eventId deduplicates).
 *
 *   IP3 — Two consecutive gate-allowed OPENs on different eventIds: after the first event
 *          the slot is free; the second event opens successfully (not rejected with
 *          `max_open_positions_reached`).
 *
 * Group 3 — rebuildLedger close path
 *
 *   RB1 — rebuildLedger with a resolved-exit row (exitPrice + closeReason non-null):
 *          after rebuild countOpenPositions() = 0 (slot is free).
 *
 *   RB2 — rebuildLedger with a missed/hollow row (simulatedFill.missed=true):
 *          after rebuild countOpenPositions() = 0 (regression guard — hollow rows must
 *          NOT open a slot).
 *
 *   RB3 — rebuildLedger with a resolved-exit row then a live open: the live open
 *          succeeds, confirming the slot is truly free after rebuild.
 *
 * Test structure: BUILD → OPERATE → CHECK
 * No real DB. Real VirtualPositionLedgerService (not a mock) is wired in for these
 * tests so the in-pass close and countOpenPositions() reflect actual ledger state.
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
import { ShadowDecisionRepository } from '../../repository/ShadowDecisionRepository';
import { StrategyVersionRepository } from '../../repository/StrategyVersionRepository';
import { StrategyRegistry } from '../../registry/StrategyRegistry';
import { AppConfigService } from '../../../config/service';
import { ShadowStrategyOrchestratorService } from '../ShadowStrategyOrchestratorService';
import { VirtualPositionLedgerService } from '../VirtualPositionLedgerService';

// ─── constants ────────────────────────────────────────────────────────────────

const BAR_OPEN_MS = new Date('2026-02-01T10:00:00.000Z').getTime();
const NOW_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const SYMBOL = 'ETHUSDT';
const EVENT_ID = `${SYMBOL}:${BAR_OPEN_MS}`;

const ENTRY_PRICE_STR = '30450';
const STOP_LOSS_STR = '29500';
const TAKE_PROFIT_STR = '31500';

// ─── tick factories ────────────────────────────────────────────────────────────

function buildMoneyValue(value: string) {
    return new Money(value);
}

/**
 * A tick whose HIGH breaches the LONG take-profit (31600 > 31500).
 * The forward-only stop simulator will resolve `tp` as the close reason.
 */
function buildTpBreachTick(): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 20;
    tick.ts = new Date(BAR_OPEN_MS + 2_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue('30400');
    tick.high = buildMoneyValue('31600'); // breaches TP (31500)
    tick.low = buildMoneyValue('30300');
    tick.close = buildMoneyValue(ENTRY_PRICE_STR);
    tick.volume = buildMoneyValue('500');

    return tick;
}

/**
 * A tick whose price stays inside both SL and TP → force_close at bar close.
 */
function buildInsideTick(): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 21;
    tick.ts = new Date(BAR_OPEN_MS + 1_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue('30400');
    tick.high = buildMoneyValue('30500'); // inside TP (31500)
    tick.low = buildMoneyValue('30400'); // inside SL (29500)
    tick.close = buildMoneyValue(ENTRY_PRICE_STR);
    tick.volume = buildMoneyValue('500');

    return tick;
}

// ─── event factory ─────────────────────────────────────────────────────────────

function buildVolatilityEvent(overrides: Partial<{ eventId: string; symbol: string; entryCandleOpenTime: number }> = {}) {
    return {
        symbol: overrides.symbol ?? SYMBOL,
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: overrides.entryCandleOpenTime ?? BAR_OPEN_MS,
        eventId: overrides.eventId ?? EVENT_ID,
        vwapSession: '30000',
        vwap20bar: '30000',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 3.0,
        vwapDeviationSigma: 2.5,
        volumeRatio: 2.0,
        volume20barAvg: '1000',
        atr14: '200',
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 65,
        bollingerUpper: '31000',
        bollingerLower: '29000',
        bollingerPctB: 0.85,
        btc5mMovePct: 0.3,
        idiosyncrasyScore: 0.5,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 2,
        symbolUniverseAgeHours: 72,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.065,
        openInterest: '500000000',
        openInterestChange5mPct: 0.1,
        openInterestChange15mPct: 0.3,
        aggTradeBuyVolumeRatio: 0.6,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: '50000',
        bookDepth50bpsUsdt: '200000',
        regimeLabel: RegimeLabelEnum.TRENDING_UP,
        marketBreadth5mUpPct: 60,
        sameBarTriggerCount: 1,
        btc1mMovePct: 0.1,
        eth5mMovePct: 0.5,
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

// ─── signal factories ──────────────────────────────────────────────────────────

function buildOpenSignal(stopLoss = STOP_LOSS_STR, takeProfit = TAKE_PROFIT_STR) {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 75,
        flowType: FlowTypeEnum.TREND_INITIATION,
        reason: 'momentum_follow',
        proposedExit: {
            stopLossPrice: new Money(stopLoss),
            takeProfitPrice: new Money(takeProfit),
            stopType: 'atr',
            timeStopAtMs: NOW_MS + 3_600_000,
        },
    };
}

// ─── strategy params factory ───────────────────────────────────────────────────

function buildStrategyParams() {
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

// ─── strategy version factory ──────────────────────────────────────────────────

function buildStrategyVersionRow(version = 2) {
    return {
        id: version,
        name: 'v2',
        version,
        status: 'shadow',
        params: buildStrategyParams(),
        direction: 'both',
        createdAt: new Date(),
        updatedAt: new Date(),
    } as unknown as import('../../entity/StrategyVersionEntity').StrategyVersionEntity;
}

// ─── real-ledger service factory ──────────────────────────────────────────────
//
// Unlike the mock-ledger factory in the main spec, these tests wire a REAL
// VirtualPositionLedgerService so that in-pass closeBySymbol + countOpenPositions()
// reflect actual ledger mutations.

interface IRealLedgerServiceContext {
    service: ShadowStrategyOrchestratorService;
    shadowDecisionsMock: jest.MockedObject<ShadowDecisionRepository>;
    ledger: VirtualPositionLedgerService;
}

function buildRealLedgerService(
    ticks: TickAggregateEntity[],
    signalOverride = buildOpenSignal(),
    shadowVersions: Array<{ version: number }> = [{ version: 2 }],
): IRealLedgerServiceContext {
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

    const registryMock = {
        resolve: jest.fn().mockReturnValue({
            strategy: {
                name: 'v2',
                version: 2,
                direction: 'both',
                evaluate: jest.fn().mockReturnValue(signalOverride),
            },
            params: buildStrategyParams(),
        }),
    } as unknown as StrategyRegistry;

    // paperRelaxConsecutiveLossHalt = false: use normal halt threshold so the
    // sentinel is NOT applied and the effective threshold is SHADOW_GATE_HALT_AFTER_CONSECUTIVE_LOSSES.
    const configMock = {
        activeStrategyVersionId: 1,
        paperStartingEquityUsdt: 10_000,
        paperRelaxConsecutiveLossHalt: false,
    } as unknown as AppConfigService;

    const service = new ShadowStrategyOrchestratorService(configMock, registryMock, strategyVersionsMock, shadowDecisionsMock, tickAggregatesMock, {
        resolve: jest.fn(),
    } as never);

    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    // Real ledger — NOT a mock — so in-pass closeBySymbol actually mutates state.
    const ledger = new VirtualPositionLedgerService();

    const resolvedShadows = shadowVersions.map(({ version }) => ({
        row: buildStrategyVersionRow(version),
        discriminator: `v${version}`,
        strategy: {
            name: 'v2',
            version,
            direction: 'both',
            evaluate: jest.fn().mockReturnValue(signalOverride),
        },
        params: buildStrategyParams(),
        ledger,
    }));

    (service as any).shadows = resolvedShadows;

    return { service, shadowDecisionsMock, ledger };
}

// ─── IP1: in-pass close frees the slot before runShadows returns ──────────────

describe('ShadowStrategyOrchestratorService M39 — IP1: in-pass close with TP-breach tick frees the slot', () => {
    it('after runShadows with a TP-breaching tick, countOpenPositions() === 0', async () => {
        // BUILD
        const { service, ledger } = buildRealLedgerService([buildTpBreachTick()], buildOpenSignal());
        const event = buildVolatilityEvent();

        // OPERATE
        await service.runShadows(event, NOW_MS);

        // CHECK — the in-pass closeBySymbol must have freed the slot
        expect(ledger.countOpenPositions()).toBe(0);
    });
});

// ─── IP2: idempotency — replaying the same eventId does not double-open/close ──

describe('ShadowStrategyOrchestratorService M39 — IP2: replaying the same eventId is idempotent', () => {
    it('calling runShadows twice with the same eventId does not double-open or double-close', async () => {
        // BUILD — TP-breach tick causes open + in-pass close on the first call.
        // On the second call with the same eventId, tryOpen must be rejected by the
        // processedEventIds dedup guard (duplicate_event_id).
        const { service, ledger } = buildRealLedgerService([buildTpBreachTick()], buildOpenSignal());
        const event = buildVolatilityEvent();

        // OPERATE
        await service.runShadows(event, NOW_MS);
        await service.runShadows(event, NOW_MS);

        // CHECK — after two calls with the same eventId: still 0 open positions
        // (not 1, which would indicate the close was skipped on replay)
        expect(ledger.countOpenPositions()).toBe(0);
    });
});

// ─── IP3: two consecutive events both open successfully ───────────────────────

describe('ShadowStrategyOrchestratorService M39 — IP3: two consecutive events open successfully when slot is freed in-pass', () => {
    it('second event is not rejected with max_open_positions_reached after the first event closes in-pass', async () => {
        // BUILD
        // Both events use a TP-breaching tick, so each opens + in-pass closes.
        // The second event uses a distinct eventId (different barOpenMs) so it
        // is not deduplicated.
        const secondBarOpenMs = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
        const secondNowMs = secondBarOpenMs + CANDLE_5M_INTERVAL_MS;

        const { service, ledger, shadowDecisionsMock } = buildRealLedgerService([buildTpBreachTick()], buildOpenSignal());
        const firstEvent = buildVolatilityEvent({ eventId: `${SYMBOL}:${BAR_OPEN_MS}`, entryCandleOpenTime: BAR_OPEN_MS });
        const secondEvent = buildVolatilityEvent({
            eventId: `${SYMBOL}:${secondBarOpenMs}`,
            entryCandleOpenTime: secondBarOpenMs,
        });

        // OPERATE
        await service.runShadows(firstEvent, NOW_MS);
        await service.runShadows(secondEvent, secondNowMs);

        // CHECK — both events should have inserted a shadow decision,
        // and the second one must not carry max_open_positions_reached as reject reason.
        const allInsertCalls = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls;
        expect(allInsertCalls).toHaveLength(2);

        const secondInsertArg = allInsertCalls[1][0];
        expect(secondInsertArg.rejectReason).not.toBe('max_open_positions_reached');
        // The second open also succeeds, so simulatedFill must be non-null
        expect(secondInsertArg.simulatedFill).not.toBeNull();
        expect(secondInsertArg.simulatedFill.missed).toBe(false);

        // After both events, slot is again free (both closed in-pass)
        expect(ledger.countOpenPositions()).toBe(0);
    });
});

// ─── helpers for rebuildLedger tests ─────────────────────────────────────────

function buildRebuildService(rows: unknown[]): { service: ShadowStrategyOrchestratorService; ledger: VirtualPositionLedgerService } {
    const shadowDecisionsMock = {
        insertShadowDecision: jest.fn().mockResolvedValue({ id: 1 }),
        findRowsForLedgerRebuild: jest.fn().mockResolvedValue(rows),
    } as unknown as jest.MockedObject<ShadowDecisionRepository>;

    const configMock = {
        activeStrategyVersionId: 1,
        paperStartingEquityUsdt: 10_000,
        paperRelaxConsecutiveLossHalt: false,
    } as unknown as AppConfigService;

    const service = new ShadowStrategyOrchestratorService(
        configMock,
        {} as StrategyRegistry,
        {} as StrategyVersionRepository,
        shadowDecisionsMock,
        { loadTicksForBar: jest.fn().mockResolvedValue([]) } as unknown as TickAggregateRepository,
        { resolve: jest.fn() } as never,
    );

    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const ledger = new VirtualPositionLedgerService();

    return { service, ledger };
}

function buildShadow(ledger: VirtualPositionLedgerService) {
    return {
        row: buildStrategyVersionRow(2),
        discriminator: 'v2',
        strategy: { evaluate: jest.fn() },
        params: buildStrategyParams(),
        ledger,
    };
}

// ─── RB1: rebuildLedger with a resolved-exit row → countOpenPositions() = 0 ───

describe('ShadowStrategyOrchestratorService M39 — RB1: rebuildLedger with resolved-exit row leaves slot free', () => {
    it('after rebuildLedger replays an open+exit row, countOpenPositions() === 0', async () => {
        // BUILD — a row with exitPrice + closeReason non-null (resolved exit)
        const resolvedExitFill = {
            entryPrice: ENTRY_PRICE_STR,
            exitPrice: TAKE_PROFIT_STR,
            slippageEntryPct: '-0.05',
            slippageExitPct: '0',
            slippageComponents: { tierBase: '-0.05', latency: '0', crossingSpread: '0' },
            missed: false,
            forceClose: false,
            lowFidelity: true,
            closedAt: new Date(BAR_OPEN_MS + 2_000).toISOString(),
            closeReason: 'tp',
        };

        const rows = [
            {
                eventId: EVENT_ID,
                symbol: SYMBOL,
                action: SignalActionEnum.OPEN,
                gateAllowed: true,
                tradeSide: 'long',
                qty: '0.5',
                stopLoss: STOP_LOSS_STR,
                takeProfit: TAKE_PROFIT_STR,
                simulatedFill: resolvedExitFill,
                createdAt: new Date(BAR_OPEN_MS),
            },
        ];

        const { service, ledger } = buildRebuildService(rows);
        const shadow = buildShadow(ledger);

        // OPERATE
        await (service as any).rebuildLedger(shadow);

        // CHECK — slot must be free: open replayed then immediately closed by rebuildLedger
        expect(ledger.countOpenPositions()).toBe(0);
    });
});

// ─── RB2: rebuildLedger with a missed/hollow row → countOpenPositions() = 0 ──

describe('ShadowStrategyOrchestratorService M39 — RB2: rebuildLedger with missed row does NOT open a slot (regression)', () => {
    it('after rebuildLedger replays a missed fill row, countOpenPositions() === 0', async () => {
        // BUILD — hollow row: simulatedFill.missed = true (pre-M26 conservative miss)
        const missedFill = {
            entryPrice: '0',
            exitPrice: null,
            slippageEntryPct: '0',
            slippageExitPct: null,
            slippageComponents: { tierBase: '0', latency: '0', crossingSpread: '0' },
            missed: true,
            forceClose: false,
            lowFidelity: true,
            closedAt: null,
            closeReason: null,
        };

        const rows = [
            {
                eventId: EVENT_ID,
                symbol: SYMBOL,
                action: SignalActionEnum.OPEN,
                gateAllowed: true,
                tradeSide: 'long',
                qty: '0.5',
                stopLoss: STOP_LOSS_STR,
                takeProfit: TAKE_PROFIT_STR,
                simulatedFill: missedFill,
                createdAt: new Date(BAR_OPEN_MS),
            },
        ];

        const { service, ledger } = buildRebuildService(rows);
        const shadow = buildShadow(ledger);

        // OPERATE
        await (service as any).rebuildLedger(shadow);

        // CHECK — hollow rows must not open a slot
        expect(ledger.countOpenPositions()).toBe(0);
    });
});

// ─── RB3: post-rebuild live open succeeds when resolved-exit row freed the slot ─

describe('ShadowStrategyOrchestratorService M39 — RB3: live open after rebuild succeeds when slot was freed', () => {
    it('a live runShadows open is not rejected after rebuildLedger closes the resolved-exit row', async () => {
        // BUILD — resolved-exit row (same as RB1): after rebuild the slot is free.
        const resolvedExitFill = {
            entryPrice: ENTRY_PRICE_STR,
            exitPrice: TAKE_PROFIT_STR,
            slippageEntryPct: '-0.05',
            slippageExitPct: '0',
            slippageComponents: { tierBase: '-0.05', latency: '0', crossingSpread: '0' },
            missed: false,
            forceClose: false,
            lowFidelity: true,
            closedAt: new Date(BAR_OPEN_MS + 2_000).toISOString(),
            closeReason: 'tp',
        };

        const rebuildRows = [
            {
                eventId: EVENT_ID,
                symbol: SYMBOL,
                action: SignalActionEnum.OPEN,
                gateAllowed: true,
                tradeSide: 'long',
                qty: '0.5',
                stopLoss: STOP_LOSS_STR,
                takeProfit: TAKE_PROFIT_STR,
                simulatedFill: resolvedExitFill,
                createdAt: new Date(BAR_OPEN_MS),
            },
        ];

        // Use a force_close tick for the live event so we know the slot is occupied then freed in-pass.
        const liveBarOpenMs = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS * 2;
        const liveNowMs = liveBarOpenMs + CANDLE_5M_INTERVAL_MS;
        const liveEventId = `${SYMBOL}:${liveBarOpenMs}`;

        const liveTick = buildInsideTick();
        liveTick.ts = new Date(liveBarOpenMs + 1_000);

        const tickAggregatesMock = {
            loadTicksForBar: jest.fn().mockResolvedValue([liveTick]),
        } as unknown as jest.MockedObject<TickAggregateRepository>;

        const shadowDecisionsMock = {
            insertShadowDecision: jest.fn().mockResolvedValue({ id: 1 }),
            findRowsForLedgerRebuild: jest.fn().mockResolvedValue(rebuildRows),
        } as unknown as jest.MockedObject<ShadowDecisionRepository>;

        const configMock = {
            activeStrategyVersionId: 1,
            paperStartingEquityUsdt: 10_000,
            paperRelaxConsecutiveLossHalt: false,
        } as unknown as AppConfigService;

        const registryMock = {
            resolve: jest.fn().mockReturnValue({
                strategy: { name: 'v2', version: 2, direction: 'both', evaluate: jest.fn().mockReturnValue(buildOpenSignal()) },
                params: buildStrategyParams(),
            }),
        } as unknown as StrategyRegistry;

        const service = new ShadowStrategyOrchestratorService(
            configMock,
            registryMock,
            {} as StrategyVersionRepository,
            shadowDecisionsMock,
            tickAggregatesMock,
            { resolve: jest.fn() } as never,
        );

        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

        const ledger = new VirtualPositionLedgerService();
        const shadow = buildShadow(ledger);
        shadow.strategy.evaluate = jest.fn().mockReturnValue(buildOpenSignal());

        (service as any).shadows = [shadow];

        // Rebuild the ledger (opens + immediately closes the resolved-exit row)
        await (service as any).rebuildLedger(shadow);

        // Confirm post-rebuild state is clean
        expect(ledger.countOpenPositions()).toBe(0);

        // OPERATE — live open on a new eventId; must succeed, not rejected
        const liveEvent = buildVolatilityEvent({ eventId: liveEventId, entryCandleOpenTime: liveBarOpenMs });
        await service.runShadows(liveEvent, liveNowMs);

        // CHECK — live open was admitted (not rejected with max_open_positions_reached)
        const allInsertCalls = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls;
        // The live event must produce a shadow decision insert
        const liveInsertCall = allInsertCalls.find((args) => args[0].eventId === liveEventId);
        expect(liveInsertCall).toBeDefined();
        expect(liveInsertCall![0].rejectReason).not.toBe('max_open_positions_reached');
        // The live event's fill must not be missed (force_close tick is inside range but valid)
        expect(liveInsertCall![0].simulatedFill).not.toBeNull();
    });
});
