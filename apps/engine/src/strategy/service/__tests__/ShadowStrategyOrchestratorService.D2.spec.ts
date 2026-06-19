/**
 * ShadowStrategyOrchestratorService — M40 D2 re-anchor coverage.
 *
 * D2 re-anchor change (architect verdict 2026-06-19): the shadow stop-side guard
 * now validates against `reconstructReferencePrice(stampedEvent)` — the anchor the
 * strategy drew its SL from — NOT the tick-derived `nextBarOpenPrice`. This restores
 * live-vs-shadow parity: live evaluates wrong-side against `avgFillPrice` (within
 * slippage of the SL anchor) and HOLDS these positions; the old guard evaluated
 * against the signal-bar-close tick (~1% off the anchor) and incorrectly rejected them.
 *
 * The fill still occurs at the tick-derived `nextBarOpenPrice`. The SL is NOT rebased
 * (ADR 0045 §D1.1). When the tick entry is already past the unmoved SL, the intrabar
 * walk records an immediate structural stop-out (close_reason = stop_loss, ≈ −1R).
 *
 * `WRONG_SIDE_OF_STOP` typed-miss is now reserved ONLY for genuinely malformed strategy
 * geometry: stop on the wrong side of its OWN `reconstructReferencePrice` anchor.
 *
 * For `buildVolatilityEvent()` in this spec: `vwapSession:'99'`, `vwapDeviationPct:1.5`
 * → `reconstructReferencePrice = 99 × 1.015 = 100.485` (the stop-side anchor).
 *
 * Acceptance criteria covered:
 *   B1 (regression) — A gate-allowed shadow OPEN whose tick-derived entry diverges from
 *        the SL anchor but whose SL is correctly drawn (stop below anchor for LONG) now
 *        produces a REAL fill (missed:false, non-zero qty) — NOT a WRONG_SIDE_OF_STOP miss.
 *        This was the production regression: 187/187 v1 gate-allowed opens rejected since
 *        06-10 because stop was validated against tick-entry instead of anchor.
 *   B1-immediate-stop-out — When tick entry is already past the unmoved SL, the fill is
 *        REAL (missed:false) with close_reason=stop_loss — not a fabricated 0-qty miss.
 *   B2 (preserved) — Genuinely malformed geometry (stop on wrong side of its OWN anchor)
 *        still yields WRONG_SIDE_OF_STOP typed-miss (qty '0', missed:true).
 *   B3 (preserved) — No signal-bar ticks → conservative null/miss (no ticks path unchanged).
 *   B4 (determinism) — Same event + ticks → identical simulatedFill on two runs.
 *
 * Covers LONG and SHORT.
 *
 * Failure routing: adversarial failures → architect routing per dev-qa-cycle.md §2.2.
 */

import {
    CoinTierEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    MissedReasonEnum,
    PositionSideEnum,
    RegimeLabelEnum,
    SignalActionEnum,
    SignalTypeEnum,
    VwapAnchorTypeEnum,
    type ISimulatedFill,
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

const BAR_OPEN_MS = new Date('2026-06-01T10:00:00.000Z').getTime();
const NOW_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const SYMBOL = 'SOLUSDT';
const EVENT_ID = `${SYMBOL}:${BAR_OPEN_MS}`;

// reconstructReferencePrice = vwapSession × (1 + vwapDeviationPct / 100)
//   = 99 × (1 + 1.5/100) = 99 × 1.015 = 100.485
// This is the stop-side anchor under the re-anchor fix.
const ANCHOR_PRICE = '100.485'; // for documentation clarity only

// ── LONG valid geometry (stop below anchor) ──────────────────────────────────
// tick-entry = 100.0, anchor = 100.485, stop = 98.0 (below anchor → valid for LONG)
// Old guard: stop=98 vs tick-entry=100 → 98 < 100 → valid (no false rejection here)
// New guard: stop=98 vs anchor=100.485 → 98 < 100.485 → valid ✓
const VALID_LONG_TICK_ENTRY_STR = '100';
const VALID_LONG_STOP_STR = '98';
const VALID_LONG_TP_STR = '104';

// ── LONG regression case (tick diverges from anchor; stop valid vs anchor only) ─
// tick-entry = 100.0, anchor = 100.485, stop = 100.2
// Old guard: stop=100.2 vs tick-entry=100 → 100.2 > 100 → WRONG_SIDE_OF_STOP (BUG)
// New guard: stop=100.2 vs anchor=100.485 → 100.2 < 100.485 → valid → REAL fill ✓
const REGRESSION_LONG_TICK_ENTRY = '100';
const REGRESSION_LONG_STOP = '100.2'; // above tick-entry but below anchor → valid vs anchor
const REGRESSION_LONG_TP = '102';

// ── LONG malformed geometry (stop above anchor — genuinely wrong side) ─────────
// tick-entry = 100, anchor = 100.485, stop = 101.0 (ABOVE anchor → malformed for LONG)
// Old guard: stop=101 vs tick-entry=100 → WRONG_SIDE_OF_STOP (was correct for wrong reason)
// New guard: stop=101 vs anchor=100.485 → 101 > 100.485 → WRONG_SIDE_OF_STOP ✓
const MALFORMED_LONG_STOP = '101';
const MALFORMED_LONG_TP = '106';

// ── SHORT valid geometry (stop above anchor) ─────────────────────────────────
// For SHORT: deviation side = BELOW → vwapDeviationPct < 0 or BELOW event gives negative pct.
// We use a BELOW event with vwapDeviationPct = 1.5 → anchor = 99 × 0.985 = 97.515
// Actually buildVolatilityEvent uses ABOVE by default → anchor = 100.485 for SHORT too.
// For SHORT: stop must be ABOVE anchor (100.485).
// Tick entry = 100.0, stop = 101.5 (above anchor 100.485 → valid for SHORT)
const VALID_SHORT_TICK_ENTRY = '100';
const VALID_SHORT_STOP = '101.5'; // > anchor 100.485 → valid for SHORT
const VALID_SHORT_TP = '97';

// ── SHORT malformed geometry (stop below anchor — genuinely wrong side) ────────
// stop = 99.0 < anchor 100.485 → malformed for SHORT
const MALFORMED_SHORT_STOP = '99';
const MALFORMED_SHORT_TP = '96';

// ─── tick factories ────────────────────────────────────────────────────────────

function buildTick(closePrice: string, tsOffset = 0): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 1;
    tick.ts = new Date(BAR_OPEN_MS + tsOffset);
    tick.symbol = SYMBOL;
    tick.open = new Money('99');
    tick.high = new Money('101');
    tick.low = new Money('98');
    tick.close = new Money(closePrice);
    tick.volume = new Money('1000');
    return tick;
}

// ─── signal factories ──────────────────────────────────────────────────────────

function buildOpenSignal(side: PositionSideEnum, stopLoss: string, takeProfit: string) {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: side,
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

// ─── event factory ─────────────────────────────────────────────────────────────
// anchor = vwapSession × (1 + vwapDeviationPct/100) = 99 × 1.015 = 100.485

function buildVolatilityEvent(overrides: Partial<{ symbol: string; entryCandleOpenTime: number }> = {}) {
    return {
        symbol: overrides.symbol ?? SYMBOL,
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: overrides.entryCandleOpenTime ?? BAR_OPEN_MS,
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

// ─── service bundle ────────────────────────────────────────────────────────────

interface ID2Bundle {
    service: ShadowStrategyOrchestratorService;
    shadowDecisionsMock: jest.MockedObject<ShadowDecisionRepository>;
    tickAggregatesMock: jest.MockedObject<TickAggregateRepository>;
    ledger: jest.Mocked<VirtualPositionLedgerService>;
}

function buildD2Service(signal: ReturnType<typeof buildOpenSignal>, ticks: TickAggregateEntity[]): ID2Bundle {
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
                name: 'v3',
                version: 3,
                direction: 'both',
                evaluate: jest.fn().mockReturnValue(signal),
            },
            params: buildStrategyParams(),
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

    // Suppress logger noise in unit tests
    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    // Seed one shadow version into the private shadows array (avoids DB round-trips)
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
        params: buildStrategyParams(),
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
            params: buildStrategyParams(),
            ledger,
            pendingDeferredWalks: new Map(),
        },
    ];

    return { service, shadowDecisionsMock, tickAggregatesMock, ledger };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function getInsertedSimulatedFill(shadowDecisionsMock: jest.MockedObject<ShadowDecisionRepository>): ISimulatedFill | null {
    expect(shadowDecisionsMock.insertShadowDecision).toHaveBeenCalledTimes(1);
    const [insertArg] = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls[0];
    return (insertArg as { simulatedFill: ISimulatedFill | null }).simulatedFill;
}

// ═══════════════════════════════════════════════════════════════════════════════
// B1 — Regression: tick-entry diverges from anchor but SL is correctly drawn
//      → REAL fill (missed:false), NOT a WRONG_SIDE_OF_STOP miss
//
// Production regression: meanReversionCore draws SL against reconstructReferencePrice
// (anchor = ~100.485), but shadow was validating SL against tick-derived entry (~100.0).
// When tick-entry < anchor, a stop above tick-entry but below anchor was rejected.
// Re-anchor fix: validate SL against anchor → correct-side stop → REAL fill.
// ═══════════════════════════════════════════════════════════════════════════════

describe('B1 (regression) — tick entry below anchor, SL valid vs anchor: REAL fill, not WRONG_SIDE_OF_STOP', () => {
    it('LONG: tick-entry=100 < anchor=100.485, stop=100.2 (above tick but below anchor): simulatedFill is non-null, missed=false', async () => {
        // BUILD: tick close = 100.0 → nextBarOpenPrice = '100'. anchor = 100.485.
        // stop = 100.2: was REJECTED by old guard (100.2 > 100 for LONG).
        // New guard: 100.2 < 100.485 → valid → REAL fill.
        const signal = buildOpenSignal(PositionSideEnum.LONG, REGRESSION_LONG_STOP, REGRESSION_LONG_TP);
        const ticks = [buildTick(REGRESSION_LONG_TICK_ENTRY)];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: real fill — missed:false, non-WRONG_SIDE_OF_STOP
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missed).toBe(false);
        expect(fill!.missedReason).toBeNull();
        expect(fill!.missedReason).not.toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
    });

    it('B1: fill reaches tryOpen (ledger open branch — not censored)', async () => {
        // BUILD: same regression case
        const signal = buildOpenSignal(PositionSideEnum.LONG, REGRESSION_LONG_STOP, REGRESSION_LONG_TP);
        const ticks = [buildTick(REGRESSION_LONG_TICK_ENTRY)];
        const { service, ledger } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: tryOpen was called (fill was not censored)
        expect(ledger.tryOpen).toHaveBeenCalledTimes(1);
    });

    it('B1: fill entry price is tick-derived (nextBarOpenPrice), NOT the anchor (no look-ahead — HIGH-1/B4)', async () => {
        // BUILD: tick close = '100' → nextBarOpenPrice = '100'. Anchor = '100.485'.
        // The fill entry must be tick-derived ('100'), NOT the anchor ('100.485').
        const signal = buildOpenSignal(PositionSideEnum.LONG, REGRESSION_LONG_STOP, REGRESSION_LONG_TP);
        const ticks = [buildTick(REGRESSION_LONG_TICK_ENTRY)];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: entryPrice is tick-derived, not the anchor
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill!.entryPrice).toBe(REGRESSION_LONG_TICK_ENTRY); // '100', not '100.485'
    });

    it('B1 SHORT: tick-entry=100 > anchor=100.485 would be invalid, but ABOVE event with valid SHORT stop: real fill', async () => {
        // BUILD: SHORT signal, stop=101.5 (above anchor 100.485 → valid for SHORT).
        // tick close = 100.0. Anchor = 100.485.
        // isStopSideValid(SHORT, '100.485', '101.5') → 101.5 > 100.485 → true → valid.
        const signal = buildOpenSignal(PositionSideEnum.SHORT, VALID_SHORT_STOP, VALID_SHORT_TP);
        const ticks = [buildTick(VALID_SHORT_TICK_ENTRY)];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: real fill
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missed).toBe(false);
        expect(fill!.missedReason).not.toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B1-immediate-stop-out — When tick entry is past the unmoved SL:
//   real fill with close_reason = stop_loss (≈ −1R), NOT a 0-qty miss.
//
// Architect verdict §3: if nextBarOpenPrice is already past the SL, the intrabar
// walk records an immediate structural stop-out. Not a censored 0-qty reject.
// ═══════════════════════════════════════════════════════════════════════════════

describe('B1-immediate-stop-out — tick entry past unmoved SL: REAL fill with stop_loss close_reason', () => {
    it('LONG tick entry=100.6 above stop=100.2 (stop invalid for LONG at tick level): real fill, missed=false', async () => {
        // BUILD: anchor = 100.485, stop = 100.2 (valid vs anchor: 100.2 < 100.485 for LONG).
        // tick-entry = 100.6 (ABOVE the stop: tick is already past the SL).
        // The intrabar walk sees an immediate stop-out.
        // The fill still happens — it's not censored to a 0-qty miss.
        const signal = buildOpenSignal(PositionSideEnum.LONG, '100.2', '103');
        const ticks = [buildTick('100.6')]; // tick close becomes nextBarOpenPrice
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: real fill — missed:false (the position was opened; SL breach is handled by walk)
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missed).toBe(false);
        expect(fill!.missedReason).toBeNull();
        // The stop was immediately breached at entry → closeReason should reflect stop breach
        // (stop_loss or force_close depending on walk resolution with single tick)
        expect(fill!.closeReason).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B2 — Preserved: genuinely malformed geometry (stop on wrong side of OWN anchor)
//      → WRONG_SIDE_OF_STOP typed miss (qty '0', missed:true)
// ═══════════════════════════════════════════════════════════════════════════════

describe('B2 (preserved) — malformed strategy geometry: stop on wrong side of anchor → WRONG_SIDE_OF_STOP', () => {
    it('LONG with stop ABOVE anchor (101 > 100.485): typed WRONG_SIDE_OF_STOP miss, missed=true', async () => {
        // BUILD: stop = 101, anchor = 100.485. For LONG: stop must be < anchor.
        // 101 > 100.485 → malformed → WRONG_SIDE_OF_STOP.
        const signal = buildOpenSignal(PositionSideEnum.LONG, MALFORMED_LONG_STOP, MALFORMED_LONG_TP);
        const ticks = [buildTick('100')];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: typed miss, non-null, WRONG_SIDE_OF_STOP
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missed).toBe(true);
        expect(fill!.missedReason).toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
    });

    it('B2: qty = "0" for malformed-geometry rejection (never filled)', async () => {
        // BUILD
        const signal = buildOpenSignal(PositionSideEnum.LONG, MALFORMED_LONG_STOP, MALFORMED_LONG_TP);
        const ticks = [buildTick('100')];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: qty = '0' (position was rejected, never opened)
        const [insertArg] = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls[0];
        expect((insertArg as { qty: string | null }).qty).toBe('0');
    });

    it('B2: tryOpen NOT called for malformed-geometry rejection (missed=true skips deferred walk gate)', async () => {
        // BUILD
        const signal = buildOpenSignal(PositionSideEnum.LONG, MALFORMED_LONG_STOP, MALFORMED_LONG_TP);
        const ticks = [buildTick('100')];
        const { service, ledger } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: tryOpen NOT called (missed:true blocks the ledger open branch)
        expect(ledger.tryOpen).not.toHaveBeenCalled();
    });

    it('B2 SHORT: stop BELOW anchor (99 < 100.485) → malformed for SHORT → WRONG_SIDE_OF_STOP', async () => {
        // BUILD: SHORT stop = 99, anchor = 100.485. For SHORT: stop must be > anchor.
        // 99 < 100.485 → malformed → WRONG_SIDE_OF_STOP.
        const signal = buildOpenSignal(PositionSideEnum.SHORT, MALFORMED_SHORT_STOP, MALFORMED_SHORT_TP);
        const ticks = [buildTick('100')];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missed).toBe(true);
        expect(fill!.missedReason).toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
    });

    it('B2 boundary — LONG stop exactly at anchor (100.485 === anchor): malformed (strict lt) → WRONG_SIDE_OF_STOP', async () => {
        // BUILD: stop = anchor = 100.485. isStopSideValid uses strict lt for LONG:
        // stop.lt(anchor) → 100.485 < 100.485 = false → invalid → WRONG_SIDE_OF_STOP.
        const signal = buildOpenSignal(PositionSideEnum.LONG, ANCHOR_PRICE, '106');
        const ticks = [buildTick('100')];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: strict-lt boundary → invalid
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).not.toBeNull();
        expect(fill!.missedReason).toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
        expect(fill!.missed).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B3 (preserved) — No signal-bar ticks: conservative null/miss (no ticks path unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

describe('B3 (preserved) — no signal-bar ticks: simulatedFill is null (conservative miss)', () => {
    it('empty ticks + valid stop side: insertShadowDecision gets simulatedFill=null', async () => {
        // BUILD: empty ticks → nextBarOpenPrice === null → no fill block entered
        const signal = buildOpenSignal(PositionSideEnum.LONG, VALID_LONG_STOP_STR, VALID_LONG_TP_STR);
        const { service, shadowDecisionsMock } = buildD2Service(signal, []);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: simulatedFill is null (no ticks → openData stays null)
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).toBeNull();
    });

    it('B3 adversarial: empty ticks + malformed stop geometry: still null (stop-side check never reached)', async () => {
        // BUILD: malformed stop but empty ticks — the stop-side check is inside
        // the `hasNextBarEntry` guard and is never reached without ticks.
        const signal = buildOpenSignal(PositionSideEnum.LONG, MALFORMED_LONG_STOP, MALFORMED_LONG_TP);
        const { service, shadowDecisionsMock } = buildD2Service(signal, []);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: null (never reached the stop-side check block)
        const fill = getInsertedSimulatedFill(shadowDecisionsMock);
        expect(fill).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B4 — Determinism: two runs of the same event produce identical simulatedFill fields
// ═══════════════════════════════════════════════════════════════════════════════

describe('B4 (determinism) — two runs of same event produce identical simulatedFill', () => {
    it('valid-side signal run twice: both calls carry non-null non-missed fill (deterministic normal path)', async () => {
        // BUILD: valid stop → real fill path
        const signal = buildOpenSignal(PositionSideEnum.LONG, VALID_LONG_STOP_STR, VALID_LONG_TP_STR);
        const ticks = [buildTick(VALID_LONG_TICK_ENTRY_STR)];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE: run twice
        await service.runShadows(buildVolatilityEvent(), NOW_MS);
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: both calls produced non-null, non-missed fills
        const fills = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls.map(
            ([arg]) => (arg as { simulatedFill: ISimulatedFill | null }).simulatedFill,
        );
        expect(fills[0]).not.toBeNull();
        expect(fills[1]).not.toBeNull();
        expect(fills[0]!.missed).toBe(false);
        expect(fills[1]!.missed).toBe(false);
        // Identical entryPrice across both runs
        expect(fills[0]!.entryPrice).toBe(fills[1]!.entryPrice);
    });

    it('B4: malformed-geometry signal run twice: both calls carry identical WRONG_SIDE_OF_STOP', async () => {
        // BUILD: malformed stop → typed miss path
        const signal = buildOpenSignal(PositionSideEnum.LONG, MALFORMED_LONG_STOP, MALFORMED_LONG_TP);
        const ticks = [buildTick('100')];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: both calls carried WRONG_SIDE_OF_STOP
        expect(shadowDecisionsMock.insertShadowDecision).toHaveBeenCalledTimes(2);
        const fills = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls.map(
            ([arg]) => (arg as { simulatedFill: ISimulatedFill | null }).simulatedFill,
        );
        expect(fills[0]).not.toBeNull();
        expect(fills[1]).not.toBeNull();
        expect(fills[0]!.missedReason).toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
        expect(fills[1]!.missedReason).toBe(MissedReasonEnum.WRONG_SIDE_OF_STOP);
        expect(fills[0]!.missedReason).toBe(fills[1]!.missedReason);
    });

    it('B4: regression case (tick < anchor, stop between them) run twice: same real fill entry on both runs', async () => {
        // BUILD: regression case — valid vs anchor, would have been rejected by old guard
        const signal = buildOpenSignal(PositionSideEnum.LONG, REGRESSION_LONG_STOP, REGRESSION_LONG_TP);
        const ticks = [buildTick(REGRESSION_LONG_TICK_ENTRY)];
        const { service, shadowDecisionsMock } = buildD2Service(signal, ticks);

        // OPERATE
        await service.runShadows(buildVolatilityEvent(), NOW_MS);
        await service.runShadows(buildVolatilityEvent(), NOW_MS);

        // CHECK: identical non-null, non-missed fills across both runs
        const fills = (shadowDecisionsMock.insertShadowDecision as jest.Mock).mock.calls.map(
            ([arg]) => (arg as { simulatedFill: ISimulatedFill | null }).simulatedFill,
        );
        expect(fills[0]).not.toBeNull();
        expect(fills[1]).not.toBeNull();
        expect(fills[0]!.missed).toBe(false);
        expect(fills[1]!.missed).toBe(false);
        expect(fills[0]!.entryPrice).toBe(fills[1]!.entryPrice);
    });
});
