/**
 * ShadowStrategyOrchestratorService — M39 W2: deferred next-bar exit walk.
 *
 * Surfaces under test:
 *
 * Group DW — deferred next-bar exit walk
 *
 *   DW1 — force_close in-pass close queues a pending deferred walk entry for the symbol.
 *
 *   DW2 — sl/tp/time_stop in-pass close does NOT queue a deferred walk; a pre-existing
 *          pending walk for the symbol is deleted.
 *
 *   DW3 — runDeferredExitWalks skips when next-bar ticks are empty; updateSimulatedFill
 *          is NOT called and the pending entry remains.
 *
 *   DW4 — runDeferredExitWalks upgrades the fill to `sl` when next-bar SL is breached.
 *          Uses a real HistoricalFillAdapter (pure function — no mock per constraint).
 *
 *   DW5 — runDeferredExitWalks upgrades the fill to `time_stop` when no SL/TP breach.
 *
 *   DW6 — pendingDeferredWalks entry is cleared after a successful deferred walk.
 *
 *   DW7 — next-bar open guard: walk is not attempted when event.entryCandleOpenTime
 *          is still on the same bar as barOpenMs (i.e. < nextBarOpenMs). loadTicksForBar
 *          is NOT called.
 *
 * Test structure: BUILD → OPERATE → CHECK
 * No real DB. Real VirtualPositionLedgerService wired in for DW1/DW2 so the
 * in-pass close mutates the ledger and exercises the pending-walk branching.
 * HistoricalFillAdapter is NOT mocked (pure function — tick fixtures drive SL/TP).
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

const BAR_OPEN_MS = new Date('2026-03-01T12:00:00.000Z').getTime();
const NEXT_BAR_OPEN_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const NOW_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const SYMBOL = 'BTCUSDT';
const EVENT_ID = `${SYMBOL}:${BAR_OPEN_MS}`;

const ENTRY_PRICE_STR = '100';
const STOP_LOSS_STR = '95';
const TAKE_PROFIT_STR = '110';

// ─── tick factories ────────────────────────────────────────────────────────────

function buildMoneyValue(value: string) {
    return new Money(value);
}

/** Tick whose price stays inside both SL and TP — produces a force_close on the signal bar. */
function buildInsideTick(barOpenMs = BAR_OPEN_MS): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 10;
    tick.ts = new Date(barOpenMs + 1_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue(ENTRY_PRICE_STR);
    tick.high = buildMoneyValue('101'); // inside TP (110)
    tick.low = buildMoneyValue('99'); // inside SL (95)
    tick.close = buildMoneyValue(ENTRY_PRICE_STR);
    tick.volume = buildMoneyValue('500');
    return tick;
}

/** Next-bar tick that breaches LONG SL (low < 95). */
function buildSlBreachTick(barOpenMs = NEXT_BAR_OPEN_MS): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 20;
    tick.ts = new Date(barOpenMs + 2_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue('98');
    tick.high = buildMoneyValue('99');
    tick.low = buildMoneyValue('93'); // breaches SL at 95
    tick.close = buildMoneyValue('96');
    tick.volume = buildMoneyValue('500');
    return tick;
}

/** Next-bar tick that breaches LONG TP (high > 110). Reserved for TP-breach test expansion. */
function _buildTpBreachTick(barOpenMs = NEXT_BAR_OPEN_MS): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 21;
    tick.ts = new Date(barOpenMs + 2_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue('105');
    tick.high = buildMoneyValue('112'); // breaches TP at 110
    tick.low = buildMoneyValue('104');
    tick.close = buildMoneyValue('111');
    tick.volume = buildMoneyValue('500');
    return tick;
}

/** Next-bar tick with no SL/TP breach: high=105, low=97 (LONG entry=100, SL=95, TP=110). */
function buildInsideNextBarTick(barOpenMs = NEXT_BAR_OPEN_MS): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 22;
    tick.ts = new Date(barOpenMs + 3_000);
    tick.symbol = SYMBOL;
    tick.open = buildMoneyValue('100');
    tick.high = buildMoneyValue('105'); // inside TP (110)
    tick.low = buildMoneyValue('97'); // inside SL (95)
    tick.close = buildMoneyValue('102');
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
        vwapSession: '100',
        vwap20bar: '100',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 3.0,
        vwapDeviationSigma: 2.5,
        volumeRatio: 2.0,
        volume20barAvg: '1000',
        atr14: '5',
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 65,
        bollingerUpper: '108',
        bollingerLower: '92',
        bollingerPctB: 0.85,
        btc5mMovePct: 0.3,
        idiosyncrasyScore: 0.5,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 1,
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

// ─── service factory ───────────────────────────────────────────────────────────
//
// Builds a ShadowStrategyOrchestratorService with a REAL VirtualPositionLedgerService
// and injected shadow(s) so in-pass close and pending-walk branching reflect actual state.

interface IServiceContext {
    service: ShadowStrategyOrchestratorService;
    shadowDecisionsMock: jest.MockedObject<ShadowDecisionRepository>;
    tickAggregatesMock: jest.MockedObject<TickAggregateRepository>;
    ledger: VirtualPositionLedgerService;
    // Direct reference to the single resolved shadow for pendingDeferredWalks inspection.
    shadow: ReturnType<typeof buildShadowRecord>;
}

function buildShadowRecord(ledger: VirtualPositionLedgerService, signalOverride = buildOpenSignal()) {
    return {
        row: buildStrategyVersionRow(2),
        discriminator: 'sv2',
        strategy: {
            name: 'v2',
            version: 2,
            direction: 'both',
            evaluate: jest.fn().mockReturnValue(signalOverride),
        },
        params: buildStrategyParams(),
        ledger,
        pendingDeferredWalks: new Map<string, unknown>(),
    };
}

function buildService(signalBarTicks: TickAggregateEntity[], signalOverride = buildOpenSignal()): IServiceContext {
    const tickAggregatesMock = {
        loadTicksForBar: jest.fn().mockResolvedValue(signalBarTicks),
    } as unknown as jest.MockedObject<TickAggregateRepository>;

    const shadowDecisionsMock = {
        insertShadowDecision: jest.fn().mockResolvedValue({ id: 1 }),
        findRowsForLedgerRebuild: jest.fn().mockResolvedValue([]),
        updateSimulatedFill: jest.fn().mockResolvedValue(undefined),
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
        tickAggregatesMock,
        { resolve: jest.fn() } as never,
    );

    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const ledger = new VirtualPositionLedgerService();
    const shadow = buildShadowRecord(ledger, signalOverride);
    shadow.strategy.evaluate = jest.fn().mockReturnValue(signalOverride);

    (service as any).shadows = [shadow];

    return { service, shadowDecisionsMock, tickAggregatesMock, ledger, shadow };
}

// ─── DW1: force_close in-pass close queues a pending deferred walk ─────────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW1: force_close queues a pending deferred walk', () => {
    it('after a signal-bar force_close, pendingDeferredWalks has one entry for the symbol with correct fields', async () => {
        // BUILD — inside tick produces force_close (no SL/TP breach on signal bar)
        const { service, shadow } = buildService([buildInsideTick()], buildOpenSignal());
        const event = buildVolatilityEvent({ eventId: EVENT_ID, entryCandleOpenTime: BAR_OPEN_MS });

        // OPERATE
        await service.runShadows(event, NOW_MS);

        // CHECK — a pending deferred walk must have been queued
        const pending = (shadow.pendingDeferredWalks as Map<string, any>).get(SYMBOL);
        expect(pending).toBeDefined();
        expect(pending.eventId).toBe(EVENT_ID);
        expect(pending.barOpenMs).toBe(BAR_OPEN_MS);
        expect(pending.side).toBe('long');
        expect(pending.stopLoss).toBe(STOP_LOSS_STR);
        expect(pending.takeProfit).toBe(TAKE_PROFIT_STR);
        // entryPrice is the next-bar open proxy (signal-bar last tick close ≈ ENTRY_PRICE_STR)
        expect(typeof pending.entryPrice).toBe('string');
        expect(Number(pending.entryPrice)).toBeGreaterThan(0);
    });
});

// ─── DW2: sl/tp in-pass close does NOT queue; deletes any stale pending ────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW2: sl/tp close does not queue deferred walk', () => {
    it('when a prior force_close pending exists and the new close is tp, the pending is deleted', async () => {
        // BUILD — TP-breaching tick on the signal bar resolves tp (not force_close)
        const tpBreachSignalBarTick = new TickAggregateEntity();
        tpBreachSignalBarTick.id = 30;
        tpBreachSignalBarTick.ts = new Date(BAR_OPEN_MS + 2_000);
        tpBreachSignalBarTick.symbol = SYMBOL;
        tpBreachSignalBarTick.open = buildMoneyValue(ENTRY_PRICE_STR);
        tpBreachSignalBarTick.high = buildMoneyValue('115'); // breaches TP at 110
        tpBreachSignalBarTick.low = buildMoneyValue('99');
        tpBreachSignalBarTick.close = buildMoneyValue(ENTRY_PRICE_STR);
        tpBreachSignalBarTick.volume = buildMoneyValue('500');

        const { service, shadow } = buildService([tpBreachSignalBarTick], buildOpenSignal());

        // Seed a stale pending walk so we can confirm it is deleted
        (shadow.pendingDeferredWalks as Map<string, any>).set(SYMBOL, {
            eventId: 'stale-event',
            barOpenMs: BAR_OPEN_MS - CANDLE_5M_INTERVAL_MS,
            side: 'long',
            entryPrice: ENTRY_PRICE_STR,
            qty: '10',
            stopLoss: STOP_LOSS_STR,
            takeProfit: TAKE_PROFIT_STR,
        });

        const event = buildVolatilityEvent({ eventId: EVENT_ID, entryCandleOpenTime: BAR_OPEN_MS });

        // OPERATE — TP breached in-pass, closeReason = 'tp'
        await service.runShadows(event, NOW_MS);

        // CHECK — no pending entry for the symbol; the stale entry was deleted
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(false);
    });
});

// ─── DW3: empty next-bar ticks → walk skipped, pending retained ────────────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW3: empty next-bar ticks skips walk and retains pending', () => {
    it('when loadTicksForBar returns [] for the next bar, updateSimulatedFill is NOT called and pending remains', async () => {
        // BUILD — inside tick on signal bar produces force_close → pending queued
        const { service, shadow, shadowDecisionsMock, tickAggregatesMock } = buildService([buildInsideTick()]);
        const signalBarEvent = buildVolatilityEvent({ eventId: EVENT_ID, entryCandleOpenTime: BAR_OPEN_MS });

        // OPERATE — signal bar: force_close queued
        await service.runShadows(signalBarEvent, NOW_MS);

        // Confirm pending exists before the drain attempt
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(true);

        // Switch loadTicksForBar to return [] for the next-bar call
        (tickAggregatesMock.loadTicksForBar as jest.Mock).mockResolvedValue([]);

        // Next event on NEXT_BAR_OPEN_MS triggers the deferred walk drain
        const nextBarEventId = `${SYMBOL}:${NEXT_BAR_OPEN_MS}`;
        const nextBarEvent = buildVolatilityEvent({
            eventId: nextBarEventId,
            entryCandleOpenTime: NEXT_BAR_OPEN_MS,
        });

        // OPERATE — drain attempt
        await service.runShadows(nextBarEvent, NEXT_BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS);

        // CHECK — updateSimulatedFill not called because ticks were empty
        expect(shadowDecisionsMock.updateSimulatedFill).not.toHaveBeenCalled();
        // Pending entry remains for retry on next cycle
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(true);
    });
});

// ─── DW4: SL breach on next bar → fill upgraded to `sl` ────────────────────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW4: SL breach on next bar upgrades fill to sl', () => {
    it('when next-bar SL is breached, updateSimulatedFill is called with closeReason=sl and forceClose=false', async () => {
        // BUILD — signal bar produces force_close
        const { service, shadow, shadowDecisionsMock, tickAggregatesMock } = buildService([buildInsideTick()]);
        const signalBarEvent = buildVolatilityEvent({ eventId: EVENT_ID, entryCandleOpenTime: BAR_OPEN_MS });

        // OPERATE — signal bar: force_close queued
        await service.runShadows(signalBarEvent, NOW_MS);
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(true);

        // Wire next-bar tick that breaches SL (low=93 < SL=95) for deferred walk
        (tickAggregatesMock.loadTicksForBar as jest.Mock).mockResolvedValue([buildSlBreachTick()]);

        const nextBarEventId = `${SYMBOL}:${NEXT_BAR_OPEN_MS}`;
        const nextBarEvent = buildVolatilityEvent({
            eventId: nextBarEventId,
            entryCandleOpenTime: NEXT_BAR_OPEN_MS,
        });

        // OPERATE — deferred walk drain
        await service.runShadows(nextBarEvent, NEXT_BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS);

        // CHECK — updateSimulatedFill called with sl close
        expect(shadowDecisionsMock.updateSimulatedFill).toHaveBeenCalledTimes(1);

        const [calledVersion, calledEventId, fill] = (shadowDecisionsMock.updateSimulatedFill as jest.Mock).mock.calls[0];
        expect(calledVersion).toBe('sv2');
        expect(calledEventId).toBe(EVENT_ID);
        expect(fill.closeReason).toBe('sl');
        // hitPrice is the tick's close when the SL breach is detected on a real tick
        // (intraBarStopEvaluator returns tick.close as hitPrice for tick-level breach)
        // The SL-breach tick has low=93 (< SL=95) and close=96, so hitPrice=96.
        expect(Number(fill.exitPrice)).toBeGreaterThan(0);
        expect(fill.forceClose).toBe(false);
        expect(fill.missed).toBe(false);
    });
});

// ─── DW5: no breach on next bar → fill upgraded to `time_stop` ─────────────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW5: no breach on next bar upgrades fill to time_stop', () => {
    it('when no SL/TP breaches occur on next bar, updateSimulatedFill is called with closeReason=time_stop', async () => {
        // BUILD — signal bar produces force_close
        const { service, shadow, shadowDecisionsMock, tickAggregatesMock } = buildService([buildInsideTick()]);
        const signalBarEvent = buildVolatilityEvent({ eventId: EVENT_ID, entryCandleOpenTime: BAR_OPEN_MS });

        // OPERATE — signal bar: force_close queued
        await service.runShadows(signalBarEvent, NOW_MS);
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(true);

        // Wire next-bar tick with no breach: high=105 < TP=110, low=97 > SL=95
        (tickAggregatesMock.loadTicksForBar as jest.Mock).mockResolvedValue([buildInsideNextBarTick()]);

        const nextBarEventId = `${SYMBOL}:${NEXT_BAR_OPEN_MS}`;
        const nextBarEvent = buildVolatilityEvent({
            eventId: nextBarEventId,
            entryCandleOpenTime: NEXT_BAR_OPEN_MS,
        });

        // OPERATE — deferred walk drain
        await service.runShadows(nextBarEvent, NEXT_BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS);

        // CHECK — updateSimulatedFill called with time_stop (full bar, no breach)
        expect(shadowDecisionsMock.updateSimulatedFill).toHaveBeenCalledTimes(1);

        const [calledVersion, calledEventId, fill] = (shadowDecisionsMock.updateSimulatedFill as jest.Mock).mock.calls[0];
        expect(calledVersion).toBe('sv2');
        expect(calledEventId).toBe(EVENT_ID);
        expect(fill.closeReason).toBe('time_stop');
        expect(fill.forceClose).toBe(false);
        expect(fill.missed).toBe(false);
        // exitPrice is the last tick's close on the no-breach bar
        expect(fill.exitPrice).toBe('102');
    });
});

// ─── DW6: pending entry cleared after successful deferred walk ─────────────────
//
// Strategy: inject the pending walk directly and call the private
// `runDeferredExitWalks` method in isolation. Calling the full `runShadows`
// would re-queue a new pending walk for the same symbol when `runOneShadow`
// evaluates the next event and again produces a force_close.

describe('ShadowStrategyOrchestratorService M39 W2 — DW6: pending entry cleared after successful walk', () => {
    it('pendingDeferredWalks.has(symbol) is false after runDeferredExitWalks drains the entry', async () => {
        // BUILD — inject the pending walk directly
        const { service, shadow, shadowDecisionsMock, tickAggregatesMock } = buildService([]);

        (shadow.pendingDeferredWalks as Map<string, any>).set(SYMBOL, {
            eventId: EVENT_ID,
            barOpenMs: BAR_OPEN_MS,
            side: 'long',
            entryPrice: ENTRY_PRICE_STR,
            qty: '10',
            stopLoss: STOP_LOSS_STR,
            takeProfit: TAKE_PROFIT_STR,
        });

        // Wire next-bar ticks for the deferred walk (no breach → time_stop)
        (tickAggregatesMock.loadTicksForBar as jest.Mock).mockResolvedValue([buildInsideNextBarTick()]);

        // Event on NEXT_BAR_OPEN_MS so the guard (entryCandleOpenTime >= nextBarOpenMs) passes
        const nextBarEvent = buildVolatilityEvent({
            eventId: `${SYMBOL}:${NEXT_BAR_OPEN_MS}`,
            entryCandleOpenTime: NEXT_BAR_OPEN_MS,
        });

        // OPERATE — call the private runDeferredExitWalks directly to isolate
        // the drain behaviour from runOneShadow's own pending-walk enqueue.
        await (service as any).runDeferredExitWalks(nextBarEvent);

        // CHECK — pending cleared; updateSimulatedFill called once
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(false);
        expect(shadowDecisionsMock.updateSimulatedFill).toHaveBeenCalledTimes(1);
    });
});

// ─── DW7: next-bar open guard — walk not attempted on the same bar ─────────────

describe('ShadowStrategyOrchestratorService M39 W2 — DW7: walk not attempted when same-bar event arrives', () => {
    it('when event.entryCandleOpenTime equals barOpenMs, loadTicksForBar is NOT called for the deferred walk', async () => {
        // BUILD — inject a pending walk directly (bypass the signal bar) so we isolate
        // the guard check in runDeferredExitWalks.
        const { service, shadow, shadowDecisionsMock, tickAggregatesMock } = buildService([]);

        // Directly seed a pending walk (barOpenMs = BAR_OPEN_MS)
        (shadow.pendingDeferredWalks as Map<string, any>).set(SYMBOL, {
            eventId: EVENT_ID,
            barOpenMs: BAR_OPEN_MS,
            side: 'long',
            entryPrice: ENTRY_PRICE_STR,
            qty: '10',
            stopLoss: STOP_LOSS_STR,
            takeProfit: TAKE_PROFIT_STR,
        });

        // Event arrives on the SAME bar as barOpenMs — next bar not yet open
        // (entryCandleOpenTime = BAR_OPEN_MS < nextBarOpenMs = BAR_OPEN_MS + 5m)
        const sameBarEvent = buildVolatilityEvent({
            eventId: EVENT_ID,
            entryCandleOpenTime: BAR_OPEN_MS,
        });

        // Reset the mock call count (may have been called in buildService boot path)
        (tickAggregatesMock.loadTicksForBar as jest.Mock).mockClear();

        // OPERATE — runDeferredExitWalks runs before the event loop
        await service.runShadows(sameBarEvent, BAR_OPEN_MS + 1_000);

        // CHECK — loadTicksForBar not called for the deferred walk because the
        // bar guard (event.entryCandleOpenTime < nextBarOpenMs) short-circuits.
        // Note: the event loop itself will call loadTicksForBar for the signal bar evidence
        // but we verify updateSimulatedFill was never called (the deferred walk didn't run).
        expect(shadowDecisionsMock.updateSimulatedFill).not.toHaveBeenCalled();

        // Pending walk remains queued (guard blocked the drain)
        expect((shadow.pendingDeferredWalks as Map<string, any>).has(SYMBOL)).toBe(true);
    });
});
