/**
 * RiskGateService — M23 breadth auto-resume (ADR 0004 §6d)
 *
 * Surfaces under test (all exercised through the public `evaluate()` API):
 *   AR1  — Happy path: breadth halt + 3 clean ticks → auto-resume; next entry admitted
 *   AR2  — Counter mechanics: stress tick mid-streak resets counter to 0
 *   AR3  — Counter mechanics: reset + fresh 3-tick streak → resumes on tick 6 total
 *   AR4  — NaN snapshot resets counter (fail-closed)
 *   AR5  — Hysteresis lower edge: breadth=11% does NOT advance counter
 *   AR6  — Hysteresis exact boundary: breadth=20% DOES advance counter
 *   AR7  — Hysteresis exact boundary: breadth=80% DOES advance counter
 *   AR8  — Hysteresis upper edge: breadth=81% does NOT advance counter
 *   AR9  — Non-breadth halt stays full-day locked (btc_shock, oi, multi)
 *   AR10 — Legacy bare 'market_stress' reason stays locked
 *   AR11 — Loss-based halts never auto-resume
 *   AR12 — Per-day re-halt cap: 3rd breadth re-halt → full-day lock; next UTC day re-arms
 *   AR13 — MARKET_STRESS_RESUMED event payload correctness
 *   AR14 — Event NOT fired on loss-halt or operator resume
 *   AR15 — stressEmittedForDate reset after auto-resume allows re-halt to emit fresh event
 *   AR16 — Leg-scoped resume: breadth halt + BTC still shocked → breadth leg resumes
 *   AR17 — MARKET_STRESS_AUTO_RESUME_ENABLED=false → M23 inert (pre-M23 behavior)
 *   AR18 — persistHalt writes correct halt_reason suffix per classified leg
 *   AR19 — Backtest replay parity: collapse → recovery → 3 clean ticks → entry admitted
 *   AR20 — Restart resets counter: stressClearCount starts at 0 after restore
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    FlowTypeEnum,
    IMarketStressResumedEvent,
    OrderIntentActionEnum,
    PositionSideEnum,
    RejectReasonEnum,
} from '@bot/shared';

import { MARKET_STRESS_RESUMED_EVENT, RISK_HALT_TRIGGERED_EVENT } from '../../../alert/const/alertEvents';
import { Money } from '../../../common/utils/money';
import { MARKET_STRESS_MAX_DAILY_REHALT, MARKET_STRESS_RESUME_CLEAR_TICKS } from '../../const/riskConsts';
import { IRiskGateContext, IRiskStateDay, IOrderIntent } from '../../interface';
import { BacktestRiskStateAdapter } from '../../../backtest/adapter/BacktestRiskStateAdapter';
import { BacktestBook } from '../../../backtest/state/BacktestBook';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── fixture constants ────────────────────────────────────────────────────────

const DATE = '2026-06-05';
const NOW_MS = new Date(`${DATE}T03:00:00.000Z`).getTime();
const NEXT_DATE = '2026-06-06';
const NEXT_DATE_NOW_MS = new Date(`${NEXT_DATE}T03:00:00.000Z`).getTime();

// Breadth values for scenario construction
const BREADTH_COLLAPSE = 8; // |8-50|=42 >= 40 → engage AND globally stressed (|42| > 30)
const BREADTH_CLEAN = 45; // |45-50|=5 <= 30 → inner band → clean tick
const BREADTH_HYSTERESIS_GAP_LOW = 11; // below engage threshold but |11-50|=39 > 30 → NOT clean
const BREADTH_HYSTERESIS_GAP_HIGH = 81; // |81-50|=31 > 30 → NOT clean
const BREADTH_INNER_BAND_LOWER = 20; // |20-50|=30, NOT > 30 → clean (exact boundary)
const BREADTH_INNER_BAND_UPPER = 80; // |80-50|=30, NOT > 30 → clean (exact boundary)
const BREADTH_GAP_LOWER = 15; // |15-50|=35 > 30 → NOT clean
const BREADTH_GAP_UPPER = 85; // |85-50|=35 > 30 → NOT clean
const BTC_SHOCK = 2.0; // >= STRESS_BTC_5M_SHOCK_PCT=1.5 → btc_shock leg active

// ─── snapshot factories ───────────────────────────────────────────────────────

function buildCalmSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 0.5,
        vwap_deviation_sigma: 0.2,
        volume_ratio: 1.0,
        volume_20bar_avg: '1000000',
        atr_14: '200',
        adx_14: 20,
        adx_di_plus: 15,
        adx_di_minus: 10,
        rsi_14: 50,
        bollinger_upper: '51000',
        bollinger_lower: '49000',
        bollinger_pct_b: 0.5,
        btc_5m_move_pct: 0.0,
        btc_1m_move_pct: 0.0,
        eth_5m_move_pct: 0.0,
        market_breadth_5m_up_pct: BREADTH_CLEAN,
        same_bar_trigger_count: 0,
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.2,
        open_interest: '1000000',
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1,
        bid_ask_spread_pct: 0.01,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: '50000000',
        book_depth_50bps_usdt: '999999999',
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 80,
        position_slot: 'A',
        active_positions_count: 0,
        regime_label: 'trending_up',
        entry_candle_open_time: NOW_MS,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session',
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };
}

function buildStressedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_COLLAPSE, ...overrides });
}

function buildParams(): Record<string, unknown> {
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
        candle_interval: '5m',
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 100, // very high to prevent consecutive-loss halt
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 100,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildLimits() {
    return {
        dailyLossLimitUsdt: new Money(9999),
        weeklyLossLimitUsdt: new Money(99999),
        maxExposurePerCoinUsdt: new Money(250),
        maxSameDirectionExposureUsdt: new Money(600),
        cooldownAfterLossMs: 0,
    };
}

function buildIntent(): IOrderIntent {
    const entryPrice = new Money('50000');

    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId: 'BTCUSDT:1700000000000',
        tradeSide: PositionSideEnum.LONG,
        signalScore: 80,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8,
        entryPrice,
        referencePrice: entryPrice,
        midAtTrigger: entryPrice,
        maintenanceMarginRate: new Money('0.005'),
        proposedExit: {
            takeProfitPrice: new Money('52000'),
            stopLossPrice: new Money('49000'),
            stopType: 'atr' as any,
            timeStopAtMs: NOW_MS + 30 * 60_000,
            tpRebaseEligible: false,
            atrDistance: null,
        },
        openPosition: null,
        sizing: {
            qty: new Money('0.001'),
            notional: new Money('50'),
            leverage: new Money('3'),
            riskPerTradeUsdt: new Money('5'),
            effectiveRiskUsdt: new Money('5'),
        },
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

/**
 * Builds a context where the day-row already records a halt. The in-memory
 * state (riskState.getDay) is what the gate reads; upsertDay/clearHaltForDate
 * mutate the local store if provided.
 */
function buildContext(
    overrides: {
        snapshot?: Record<string, unknown>;
        isHalted?: boolean;
        haltReason?: string | null;
        utcDateString?: string;
        nowMs?: number;
        riskStateOverrides?: {
            getDay?: jest.Mock;
            upsertDay?: jest.Mock;
            upsertHaltForDay?: jest.Mock;
            clearHaltForDate?: jest.Mock;
            sumRealizedPnlBetween?: jest.Mock;
        };
    } = {},
): IRiskGateContext {
    const utcDateString = overrides.utcDateString ?? DATE;
    const nowMs = overrides.nowMs ?? NOW_MS;
    const isHalted = overrides.isHalted ?? false;
    const haltReason = overrides.haltReason ?? null;
    const snapshot = overrides.snapshot ?? buildCalmSnapshot();

    const dayRow: IRiskStateDay = {
        date: utcDateString,
        realizedPnlDay: new Money(0),
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted,
        haltReason,
    };

    return {
        nowMs,
        utcDateString,
        snapshot: snapshot as any,
        params: buildParams() as any,
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildLimits(),
        modelDivergenceDetected: false,
        riskState: {
            getDay: jest.fn().mockResolvedValue(dayRow),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money(0)),
            upsertDay: jest.fn().mockResolvedValue(undefined),
            upsertHaltForDay: jest.fn().mockResolvedValue(undefined),
            clearHaltForDate: jest.fn().mockResolvedValue(undefined),
            ...overrides.riskStateOverrides,
        },
        openPositions: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
            findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
            countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
        },
        instruments: {
            findConstraints: jest.fn().mockResolvedValue({
                symbol: 'BTCUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.01'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        },
    };
}

/**
 * Builds a RiskGateService with auto-resume ENABLED (paper-mode default).
 */
function buildGate(autoResumeEnabled = true): { gate: RiskGateService; events: jest.Mock } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) } as any;
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) } as any;
    const emitMock = jest.fn();
    const events = { emit: emitMock } as any;
    const appConfig = { marketStressAutoResumeEnabled: autoResumeEnabled, paperRelaxMarketStress: false } as any;

    const gate = new RiskGateService(ledger, slotManager, stress, positions, riskState, events, appConfig);
    gate.markRecoveryComplete();

    return { gate, events: emitMock };
}

// ─── AR1: Happy path — 3 clean ticks → auto-resume ───────────────────────────

describe('RiskGateService M23 auto-resume — AR1: breadth halt + 3 clean ticks → auto-resume', () => {
    it('3 consecutive clean ticks after a breadth halt → clearHaltForDate called and 3rd tick does not return GLOBAL_HALT', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Ticks 1 and 2: still halted (counter at 1 then 2, needs 3)
        for (let tick = 1; tick <= 2; tick++) {
            const ctx = buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            });
            const result = await gate.evaluate(intent, ctx);

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }

        // Tick 3: clearHaltForDate is called → should resume
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);
        const ctx3 = buildContext({
            snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
            isHalted: true,
            haltReason: 'market_stress:breadth',
            riskStateOverrides: { clearHaltForDate: clearHaltMock },
        });
        const result3 = await gate.evaluate(intent, ctx3);

        // On tick 3 the gate auto-resumes: clearHaltForDate was called
        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
        // After resume, the same tick falls through to the fresh isStressed() check.
        // With calm breadth the new stress check passes → entry is admitted (APPROVED)
        // or rejected for a non-halt reason. It must NOT be GLOBAL_HALT.
        expect(result3.rejectReason).not.toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR2: stress tick mid-streak resets counter ───────────────────────────────

describe('RiskGateService M23 auto-resume — AR2: stress tick mid-streak resets counter to 0', () => {
    it('2 clean ticks + 1 stress tick (breadth=8%) → counter resets; still halted', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // 2 clean ticks
        for (let tick = 0; tick < 2; tick++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        // 1 stress tick → counter resets to 0
        const stressCtx = buildContext({
            snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_COLLAPSE }),
            isHalted: true,
            haltReason: 'market_stress:breadth',
        });
        const stressResult = await gate.evaluate(intent, stressCtx);

        expect(stressResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR3: reset + fresh 3-tick streak ────────────────────────────────────────

describe('RiskGateService M23 auto-resume — AR3: reset counter + fresh 3 clean ticks → resumes (total 6 ticks)', () => {
    it('2 clean + 1 stress + 3 clean ticks → resumes on the 3rd clean tick after reset', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // 2 clean ticks (counter = 2)
        for (let i = 0; i < 2; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        // 1 stress tick (counter resets to 0)
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_COLLAPSE }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            }),
        );

        // 2 more clean ticks (counter = 2; still halted)
        for (let i = 0; i < 2; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }

        // 3rd clean tick after reset → should resume
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);
        const resumeCtx = buildContext({
            snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
            isHalted: true,
            haltReason: 'market_stress:breadth',
            riskStateOverrides: { clearHaltForDate: clearHaltMock },
        });
        await gate.evaluate(intent, resumeCtx);

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });
});

// ─── AR4: NaN snapshot resets counter ────────────────────────────────────────

describe('RiskGateService M23 auto-resume — AR4: NaN snapshot resets counter (fail-closed)', () => {
    it('1 clean tick + NaN breadth snapshot → counter resets to 0; still halted', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // 1 clean tick
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            }),
        );

        // NaN tick → isGlobalStressed returns true → counter resets
        const nanCtx = buildContext({
            snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: NaN }),
            isHalted: true,
            haltReason: 'market_stress:breadth',
        });
        const nanResult = await gate.evaluate(intent, nanCtx);

        expect(nanResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR5: hysteresis — gap zone breadth does NOT advance counter ─────────────

describe('RiskGateService M23 auto-resume — AR5/AR6/AR7/AR8: hysteresis boundary', () => {
    it('breadth=11% (|11-50|=39 > 30, in gap zone) does NOT advance counter — still halted after 3 such ticks', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_HYSTERESIS_GAP_LOW }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });

    it('breadth=15% (|15-50|=35 > 30, in gap zone) does NOT advance counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_GAP_LOWER }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });

    it('breadth=19% (|19-50|=31 > 30) does NOT advance counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: 19 }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });

    it('breadth=20% (|20-50|=30, NOT > 30, exactly at inner band boundary) DOES advance counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        // 3 ticks at exactly 20% → should reach MARKET_STRESS_RESUME_CLEAR_TICKS and resume
        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_INNER_BAND_LOWER }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        // Final tick: should resume
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_INNER_BAND_LOWER }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });

    it('breadth=80% (|80-50|=30, NOT > 30, exactly at upper inner band boundary) DOES advance counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_INNER_BAND_UPPER }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_INNER_BAND_UPPER }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });

    it('breadth=81% (|81-50|=31 > 30) does NOT advance counter — still halted after 3 such ticks', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_HYSTERESIS_GAP_HIGH }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });

    it('breadth=85% (|85-50|=35 > 30, upper gap zone) does NOT advance counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_GAP_UPPER }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });
});

// ─── AR9: non-breadth halt stays full-day locked ──────────────────────────────

describe('RiskGateService M23 auto-resume — AR9: non-breadth stress halts stay full-day locked', () => {
    // same_bar removed: M28 made it resume-eligible (tested separately in M28 spec)
    const NON_BREADTH_HALT_REASONS = [
        'market_stress:btc_shock',
        'market_stress:eth_shock',
        'market_stress:oi',
        'market_stress:funding',
        'market_stress:spread',
        'market_stress:multi',
        'market_stress:invalid',
    ];

    it.each(NON_BREADTH_HALT_REASONS)('halt_reason="%s" + 10 clean ticks → still GLOBAL_HALT (full-day lock)', async (haltReason) => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 10; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason,
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR10: legacy bare reason stays locked ────────────────────────────────────

describe('RiskGateService M23 auto-resume — AR10: legacy bare "market_stress" stays full-day locked', () => {
    it('halt_reason="market_stress" (bare, no suffix) + 3 clean ticks → GLOBAL_HALT (unknown suffix → no auto-resume)', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 3; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress',
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR11: loss-based halts never auto-resume ─────────────────────────────────

describe('RiskGateService M23 auto-resume — AR11: loss-based halts never auto-resume', () => {
    const LOSS_HALT_REASONS = ['consecutive_loss_halt', 'daily_loss_limit', 'weekly_loss_limit', 'model_divergence_halt'];

    it.each(LOSS_HALT_REASONS)('halt_reason="%s" → GLOBAL_HALT regardless of clean ticks', async (haltReason) => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 5; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason,
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR12: per-day re-halt cap ────────────────────────────────────────────────

describe('RiskGateService M23 auto-resume — AR12: per-day re-halt cap', () => {
    /**
     * The cap check fires on the MARKET_STRESS stressReHaltCount (incremented by persistHalt).
     * We simulate multiple halt→resume→re-halt cycles within the same UTC day.
     *
     * Because the stressReHaltCount is private and advances in persistHalt (called when
     * isStressed() returns true), we drive the gate through actual stress engage ticks
     * to advance the counter, then observe the cap taking effect.
     */
    it('first breadth halt (initial, re-halt count=0) → auto-resume still possible', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Advance the internal re-halt counter: trigger a halt via the stress engage path
        // (not the already-halted path) by driving a stressed snapshot through the not-halted state.
        // First: drive stress engage to bump stressReHaltCount to 1
        const stressEngageCtx = buildContext({
            snapshot: buildStressedSnapshot(),
            isHalted: false,
            haltReason: null,
        });
        await gate.evaluate(intent, stressEngageCtx); // stressReHaltCount = 1

        // Now in the same day, with the row reporting halted:
        // stressReHaltCount=1 which is < MARKET_STRESS_MAX_DAILY_REHALT=3 → auto-resume eligible
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        // Auto-resume should have fired
        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });

    it('4th breadth halt (stressReHaltCount >= cap=3) → GLOBAL_HALT for rest of day', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Drive stressReHaltCount to MARKET_STRESS_MAX_DAILY_REHALT (3) by triggering
        // 3 stress engages (each calls persistHalt which increments the counter).
        for (let i = 0; i < MARKET_STRESS_MAX_DAILY_REHALT; i++) {
            // Each of these goes through the not-halted path → persistHalt → reHaltCount++
            const engageCtx = buildContext({
                snapshot: buildStressedSnapshot(),
                isHalted: false,
                haltReason: null,
            });
            await gate.evaluate(intent, engageCtx);
        }

        // Now stressReHaltCount === MARKET_STRESS_MAX_DAILY_REHALT (3).
        // The resume branch should see stressReHaltCount >= cap → return GLOBAL_HALT.
        const result = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            }),
        );

        expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });

    it('UTC day rollover resets re-halt cap; auto-resume re-arms on next day', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Hit the cap on the first day
        for (let i = 0; i < MARKET_STRESS_MAX_DAILY_REHALT; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildStressedSnapshot(),
                    isHalted: false,
                    haltReason: null,
                    utcDateString: DATE,
                    nowMs: NOW_MS,
                }),
            );
        }

        // Cap reached on DATE → GLOBAL_HALT
        const capResult = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                utcDateString: DATE,
            }),
        );

        expect(capResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);

        // Next UTC day: the rollover path resets stressReHaltCount to 0.
        // Drive 3 clean ticks on NEXT_DATE to confirm auto-resume re-armed.
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                    utcDateString: NEXT_DATE,
                    nowMs: NEXT_DATE_NOW_MS,
                }),
            );
        }

        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                utcDateString: NEXT_DATE,
                nowMs: NEXT_DATE_NOW_MS,
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        expect(clearHaltMock).toHaveBeenCalledWith(NEXT_DATE);
    });
});

// ─── AR13: MARKET_STRESS_RESUMED event payload ────────────────────────────────

describe('RiskGateService M23 auto-resume — AR13: MARKET_STRESS_RESUMED event payload', () => {
    it('auto-resume fires MARKET_STRESS_RESUMED with correct payload fields', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            }),
        );

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(1);

        const payload: IMarketStressResumedEvent = resumedCalls[0][1];

        expect(payload.triggerLeg).toBe('breadth');
        expect(payload.clearCount).toBe(MARKET_STRESS_RESUME_CLEAR_TICKS);
        expect(payload.breadthAtResume).toBe(BREADTH_CLEAN);
        expect(payload.utcDateString).toBe(DATE);
        expect(typeof payload.dailyReHaltCount).toBe('number');
        expect(typeof payload.nearReHaltCap).toBe('boolean');
    });

    it('nearReHaltCap is true when approaching the daily re-halt limit', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // Advance stressReHaltCount to MARKET_STRESS_MAX_DAILY_REHALT - 1
        for (let i = 0; i < MARKET_STRESS_MAX_DAILY_REHALT - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildStressedSnapshot(),
                    isHalted: false,
                    haltReason: null,
                }),
            );
        }

        // Now trigger auto-resume: stressReHaltCount = MARKET_STRESS_MAX_DAILY_REHALT - 1
        // nearReHaltCap = (reHaltCount + 1 >= cap) = (MARKET_STRESS_MAX_DAILY_REHALT - 1 + 1 >= MARKET_STRESS_MAX_DAILY_REHALT) = true
        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(1);

        const payload: IMarketStressResumedEvent = resumedCalls[0][1];

        expect(payload.nearReHaltCap).toBe(true);
    });
});

// ─── AR14: event NOT fired on loss-halt or wrong-path ─────────────────────────

describe('RiskGateService M23 auto-resume — AR14: MARKET_STRESS_RESUMED does NOT fire on loss-halt', () => {
    it('consecutive_loss_halt stays locked → MARKET_STRESS_RESUMED event never emitted', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 5; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'consecutive_loss_halt',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(0);
    });

    it('non-breadth stress halt → MARKET_STRESS_RESUMED event never emitted', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        for (let i = 0; i < 10; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:btc_shock',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(0);
    });
});

// ─── AR15: stressEmittedForDate reset after auto-resume ──────────────────────

describe('RiskGateService M23 auto-resume — AR15: stressEmittedForDate reset after auto-resume allows fresh re-halt event', () => {
    it('after auto-resume, a same-day fresh breadth collapse fires a fresh RISK_HALT_TRIGGERED event', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // Step 1: complete auto-resume (3 clean ticks from a breadth halt)
        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        // Step 2: after resume, a fresh stress engage on a not-halted day should emit RISK_HALT_TRIGGERED
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildStressedSnapshot(),
                isHalted: false, // day was cleared by auto-resume
                haltReason: null,
            }),
        );

        const haltEvents = events.mock.calls.filter(([event]: [string]) => event === RISK_HALT_TRIGGERED_EVENT);

        expect(haltEvents.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── AR16: leg-scoped resume — breadth halt + BTC still shocked → resumes ────

describe('RiskGateService M23 auto-resume — AR16: leg-scoped resume: breadth halt resumes even if BTC still shocked', () => {
    it('halt_reason="market_stress:breadth" + BTC 5m=2% still shocked + breadth=45% clean → auto-resumes after 3 ticks', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        // BTC is still shocked (2.0 >= 1.5) but breadth is clean (45%).
        // isGlobalStressed() checks breadth ONLY (not BTC), so BTC shock is irrelevant for resume.
        const snapshotWithCleanBreadthButShockedBtc = buildCalmSnapshot({
            market_breadth_5m_up_pct: BREADTH_CLEAN,
            btc_5m_move_pct: BTC_SHOCK, // still shocked — irrelevant to resume predicate
        });

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: snapshotWithCleanBreadthButShockedBtc,
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        await gate.evaluate(
            intent,
            buildContext({
                snapshot: snapshotWithCleanBreadthButShockedBtc,
                isHalted: true,
                haltReason: 'market_stress:breadth',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        // Breadth halt should auto-resume regardless of BTC shock state
        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });

    it('halt_reason="market_stress:multi" (breadth AND BTC shock both engaged) + 3 clean ticks → GLOBAL_HALT (no auto-resume)', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        // Multi-leg halt is full-day locked; clean breadth cannot auto-resume it
        for (let i = 0; i < 3; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:multi',
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── AR17: auto-resume flag disabled → M23 inert ─────────────────────────────

describe('RiskGateService M23 auto-resume — AR17: MARKET_STRESS_AUTO_RESUME_ENABLED=false → M23 inert', () => {
    it('with flag off: breadth halt + 10 clean ticks → still GLOBAL_HALT (pre-M23 behavior)', async () => {
        const { gate } = buildGate(false); // auto-resume disabled
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 10; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });

    it('with flag off: MARKET_STRESS_RESUMED event is never emitted', async () => {
        const { gate, events } = buildGate(false);
        const intent = buildIntent();

        for (let i = 0; i < 10; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(0);
    });
});

// ─── AR18: persistHalt writes correct halt_reason suffix ─────────────────────

describe('RiskGateService M23 auto-resume — AR18: persistHalt writes market_stress:<leg> suffix', () => {
    it('breadth-only stressed snapshot → upsertHaltForDay called with haltReason="market_stress:breadth"', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const upsertHaltMock = jest.fn().mockResolvedValue(undefined);

        const ctx = buildContext({
            snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_COLLAPSE }),
            isHalted: false,
            haltReason: null,
            riskStateOverrides: { upsertHaltForDay: upsertHaltMock },
        });

        await gate.evaluate(intent, ctx);

        // M45 D3a: persistHalt routes through the column-scoped upsertHaltForDay(date, isHalted, haltReason).
        const haltCalls = upsertHaltMock.mock.calls.filter(([, isHalted]: [string, boolean]) => isHalted === true);

        expect(haltCalls).toHaveLength(1);
        expect(haltCalls[0][2]).toBe('market_stress:breadth');
    });

    it('BTC shock sole-engage → upsertHaltForDay called with haltReason="market_stress:btc_shock"', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const upsertHaltMock = jest.fn().mockResolvedValue(undefined);

        // BTC shock only (breadth is neutral, no other legs)
        const ctx = buildContext({
            snapshot: buildCalmSnapshot({ btc_5m_move_pct: BTC_SHOCK }),
            isHalted: false,
            haltReason: null,
            riskStateOverrides: { upsertHaltForDay: upsertHaltMock },
        });

        await gate.evaluate(intent, ctx);

        const haltCalls = upsertHaltMock.mock.calls.filter(([, isHalted]: [string, boolean]) => isHalted === true);

        expect(haltCalls).toHaveLength(1);
        expect(haltCalls[0][2]).toBe('market_stress:btc_shock');
    });

    it('breadth + BTC shock both engage → upsertHaltForDay called with haltReason="market_stress:multi"', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        const upsertHaltMock = jest.fn().mockResolvedValue(undefined);

        const ctx = buildContext({
            snapshot: buildCalmSnapshot({
                market_breadth_5m_up_pct: BREADTH_COLLAPSE,
                btc_5m_move_pct: BTC_SHOCK,
            }),
            isHalted: false,
            haltReason: null,
            riskStateOverrides: { upsertHaltForDay: upsertHaltMock },
        });

        await gate.evaluate(intent, ctx);

        const haltCalls = upsertHaltMock.mock.calls.filter(([, isHalted]: [string, boolean]) => isHalted === true);

        expect(haltCalls).toHaveLength(1);
        expect(haltCalls[0][2]).toBe('market_stress:multi');
    });
});

// ─── AR19: backtest replay parity (review M4) ─────────────────────────────────

describe('RiskGateService M23 auto-resume — AR19: backtest replay parity (non-mocked replay through real BacktestRiskStateAdapter)', () => {
    it('ordered snapshots: breadth collapse → 3 clean ticks → resume tick → entry admitted; deterministic across two runs', async () => {
        async function runReplay(): Promise<{
            haltTick: RejectReasonEnum | null;
            cleanTick1: RejectReasonEnum | null;
            cleanTick2: RejectReasonEnum | null;
            resumeTick: RejectReasonEnum | null;
            postResumeTick: RejectReasonEnum | null;
        }> {
            const { gate } = buildGate();
            const intent = buildIntent();

            // Use the real BacktestRiskStateAdapter backed by BacktestBook
            const book = new BacktestBook();
            const riskStateAdapter = new BacktestRiskStateAdapter(book);

            function buildBacktestContext(snapshotOverrides: Record<string, unknown>, nowMsOffset = 0): IRiskGateContext {
                const nowMs = NOW_MS + nowMsOffset;
                const utcDateString = new Date(nowMs).toISOString().slice(0, 10);

                return {
                    nowMs,
                    utcDateString,
                    snapshot: buildCalmSnapshot(snapshotOverrides) as any,
                    params: buildParams() as any,
                    strategyVersionId: 1,
                    belowUniverseFloor: false,
                    limits: buildLimits(),
                    modelDivergenceDetected: false,
                    riskState: riskStateAdapter,
                    openPositions: {
                        findOpen: jest.fn().mockResolvedValue([]),
                        findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
                        findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
                        countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
                    },
                    instruments: {
                        findConstraints: jest.fn().mockResolvedValue({
                            symbol: 'BTCUSDT',
                            stepSize: new Money('0.001'),
                            tickSize: new Money('0.01'),
                            minNotional: new Money('5'),
                            maintenanceMarginRate: new Money('0.005'),
                        }),
                    },
                };
            }

            // Tick 0: breadth collapse → stress engage → halt persisted to BacktestBook
            const tick0 = await gate.evaluate(intent, buildBacktestContext({ market_breadth_5m_up_pct: BREADTH_COLLAPSE }, 0));
            const haltTick = tick0.rejectReason;

            // Ticks 1, 2: clean ticks (counter advancing toward 3)
            const tick1 = await gate.evaluate(intent, buildBacktestContext({ market_breadth_5m_up_pct: BREADTH_CLEAN }, 5 * 60_000));
            const tick2 = await gate.evaluate(intent, buildBacktestContext({ market_breadth_5m_up_pct: BREADTH_CLEAN }, 10 * 60_000));

            // Tick 3: resume tick — counter reaches MARKET_STRESS_RESUME_CLEAR_TICKS
            const tick3 = await gate.evaluate(intent, buildBacktestContext({ market_breadth_5m_up_pct: BREADTH_CLEAN }, 15 * 60_000));

            // Tick 4: post-resume, not halted, clean breadth → should be admitted (or rejected for non-halt reason)
            const tick4 = await gate.evaluate(intent, buildBacktestContext({ market_breadth_5m_up_pct: BREADTH_CLEAN }, 20 * 60_000));

            return {
                haltTick: haltTick,
                cleanTick1: tick1.rejectReason,
                cleanTick2: tick2.rejectReason,
                resumeTick: tick3.rejectReason,
                postResumeTick: tick4.rejectReason,
            };
        }

        // Run the replay twice — the decisions must be identical (determinism)
        const run1 = await runReplay();
        const run2 = await runReplay();

        // Halt tick returns MARKET_STRESS (the engage reason, since halt was just written)
        expect(run1.haltTick).toBe(RejectReasonEnum.MARKET_STRESS);

        // Clean ticks 1 and 2: counter at 1 and 2 → still halted
        expect(run1.cleanTick1).toBe(RejectReasonEnum.GLOBAL_HALT);
        expect(run1.cleanTick2).toBe(RejectReasonEnum.GLOBAL_HALT);

        // Resume tick: counter reaches 3 → resumes. The same tick then runs the fresh
        // isStressed() check; with clean breadth and calm snapshot, the gate should either
        // approve the entry or reject for a non-halt reason (never GLOBAL_HALT).
        expect(run1.resumeTick).not.toBe(RejectReasonEnum.GLOBAL_HALT);

        // Post-resume tick: admitted or rejected for a non-halt reason
        expect(run1.postResumeTick).not.toBe(RejectReasonEnum.GLOBAL_HALT);

        // Determinism: same decisions across two runs
        expect(run1).toEqual(run2);
    });
});

// ─── AR20: restart resets counter ────────────────────────────────────────────

describe('RiskGateService M23 auto-resume — AR20: restart resets stressClearCount to 0', () => {
    it('a freshly constructed gate (simulating a restart) requires a full 3-tick confirmation even after a prior breadth halt is restored', async () => {
        // Simulate a restart: create a NEW gate instance (stressClearCount=0 by construction).
        // The restored halt is reflected in the day-row via context.isHalted=true, haltReason=...
        // The gate must not resume without a full MARKET_STRESS_RESUME_CLEAR_TICKS streak.
        const { gate } = buildGate();
        const intent = buildIntent();

        // Only 2 clean ticks (less than MARKET_STRESS_RESUME_CLEAR_TICKS=3)
        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            // Still locked; not resumed yet
            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }

        // Exactly 3 ticks needed (fresh counter starts at 0)
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        // Counter starts at 0 post-restart, so exactly MARKET_STRESS_RESUME_CLEAR_TICKS ticks are needed
        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });
});

// ─── M23 constants integrity ──────────────────────────────────────────────────

describe('M23 riskConsts — constant values match specification', () => {
    it('MARKET_STRESS_RESUME_CLEAR_TICKS is 3', () => {
        expect(MARKET_STRESS_RESUME_CLEAR_TICKS).toBe(3);
    });

    it('MARKET_STRESS_MAX_DAILY_REHALT is 3', () => {
        expect(MARKET_STRESS_MAX_DAILY_REHALT).toBe(3);
    });
});
