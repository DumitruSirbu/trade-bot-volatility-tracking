/**
 * RiskGateService — M28 same_bar auto-resume + per-transition dedup (ADR 0004 §6e)
 *
 * Surfaces under test (all exercised through the public `evaluate()` API):
 *
 *   SB1  — same_bar halt + 1 clean tick (count < 12) → still GLOBAL_HALT (1 < SAME_BAR_RESUME_CLEAR_TICKS=2)
 *   SB2  — same_bar halt + 2 clean ticks (exact boundary) → auto-resumes
 *   SB3  — non-clean tick mid-window (count >= 12) resets counter; needs 2 more clean ticks
 *   SB4  — MARKET_STRESS_RESUMED payload: triggerLeg='same_bar', clearCount=2
 *
 *   BR1  — breadth halt + 2 clean ticks → still GLOBAL_HALT (breadth still needs 3)
 *   BR2  — breadth halt + 3 clean ticks → auto-resumes (M23 unchanged)
 *   BR3  — clean same_bar tick does NOT advance a breadth halt's resume counter (cross-contamination)
 *
 *   FL1  — multi/invalid/bare and all loss-based halt reasons + 10 clean ticks → GLOBAL_HALT
 *
 *   RC1  — 3rd re-halt in one day (any mix of breadth/same_bar) → full-day lock (shared cap)
 *
 *   FO1  — MARKET_STRESS_AUTO_RESUME_ENABLED=false + same_bar halt + 10 clean ticks → GLOBAL_HALT
 *
 *   DD1  — breadth resume in day T, then same_bar halt + 2 clean ticks → second RESUMED event fires (triggerLeg='same_bar')
 *   DD2  — same_bar resume, then same_bar re-halt, then 2 more clean same_bar ticks → third RESUMED event fires
 *   DD3  — same-tick duplicate: resuming on the same gate call does NOT emit duplicate events
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

import { MARKET_STRESS_RESUMED_EVENT } from '../../../alert/const/alertEvents';
import { Money } from '../../../common/utils/money';
import {
    MARKET_STRESS_RESUME_CLEAR_TICKS,
    SAME_BAR_RESUME_CLEAR_TICKS,
    STRESS_SAME_BAR_HALT_COUNT,
    STRESS_SAME_BAR_RESUME_COUNT,
} from '../../const/riskConsts';
import { IRiskGateContext, IRiskStateDay, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── fixture constants ────────────────────────────────────────────────────────

const DATE = '2026-06-09';
const NOW_MS = new Date(`${DATE}T03:00:00.000Z`).getTime();

// Breadth values — mirrors RiskGateService.m23.spec.ts vocabulary
const BREADTH_CLEAN = 45; // |45-50|=5 <= 30 → inner band → clean breadth tick
const BREADTH_COLLAPSE = 8; // |8-50|=42 >= 40 → breadth engage

// same_bar_trigger_count values
const SAME_BAR_ENGAGE = STRESS_SAME_BAR_HALT_COUNT; // = 20
const SAME_BAR_CLEAN = STRESS_SAME_BAR_RESUME_COUNT - 1; // = 11 → clean tick
const SAME_BAR_STRESSED = STRESS_SAME_BAR_RESUME_COUNT; // = 12 → still stressed (in hysteresis)

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
        same_bar_trigger_count: SAME_BAR_CLEAN, // clean same_bar by default
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

function buildSameBarStressedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_ENGAGE, ...overrides });
}

function buildBreadthStressedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        stress_same_bar_trigger_count: 5, // param value intentionally below engine const=20
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
        midAtTrigger: entryPrice,
        maintenanceMarginRate: new Money('0.005'),
        proposedExit: {
            takeProfitPrice: new Money('52000'),
            stopLossPrice: new Money('49000'),
            stopType: 'atr' as any,
            timeStopAtMs: NOW_MS + 30 * 60_000,
        },
        openPosition: null,
        sizing: {
            qty: new Money('0.001'),
            notional: new Money('50'),
            leverage: new Money('3'),
            riskPerTradeUsdt: new Money('5'),
        },
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

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

// ─── SB1: same_bar halt + 1 clean tick → still GLOBAL_HALT ───────────────────

describe('RiskGateService M28 — SB1: same_bar halt + 1 clean tick → still GLOBAL_HALT (1 < SAME_BAR_RESUME_CLEAR_TICKS=2)', () => {
    it('1 clean same_bar tick is insufficient to resume a market_stress:same_bar halt', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // 1 clean tick (same_bar_trigger_count < 12): counter=1, still needs 2
        const result = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── SB2: same_bar halt + 2 clean ticks → auto-resumes (exact boundary) ──────

describe('RiskGateService M28 — SB2: same_bar halt + 2 clean ticks (SAME_BAR_RESUME_CLEAR_TICKS=2) → auto-resumes', () => {
    it('exactly 2 consecutive clean same_bar ticks trigger auto-resume', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Tick 1: clean → counter=1, still halted
        const tick1 = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        expect(tick1.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);

        // Tick 2: clean → counter=2 = SAME_BAR_RESUME_CLEAR_TICKS → auto-resume
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);
        const tick2 = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
        // After resume the same tick falls through the fresh isStressed check.
        // With calm same_bar and calm snapshot the gate must NOT return GLOBAL_HALT.
        expect(tick2.rejectReason).not.toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── SB3: non-clean tick mid-window resets counter ───────────────────────────

describe('RiskGateService M28 — SB3: non-clean tick mid-window resets counter; needs 2 more clean ticks', () => {
    it('1 clean + 1 stressed (count >= 12) + 2 clean → resumes on tick 4; without the reset it would have resumed on tick 2', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Tick 1: clean → counter=1
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        // Tick 2: stressed (count >= 12 → isSameBarStillStressed=true) → counter resets to 0
        const stressedResult = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_STRESSED }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        expect(stressedResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);

        // Tick 3: clean → counter=1 (fresh start after reset)
        const tick3 = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        expect(tick3.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);

        // Tick 4: clean → counter=2 = SAME_BAR_RESUME_CLEAR_TICKS → auto-resume
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
                riskStateOverrides: { clearHaltForDate: clearHaltMock },
            }),
        );

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });
});

// ─── SB4: MARKET_STRESS_RESUMED event payload for same_bar ───────────────────

describe('RiskGateService M28 — SB4: MARKET_STRESS_RESUMED event has triggerLeg="same_bar" and clearCount=SAME_BAR_RESUME_CLEAR_TICKS=2', () => {
    it('auto-resume fires MARKET_STRESS_RESUMED with triggerLeg=same_bar and clearCount=2', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // Drive SAME_BAR_RESUME_CLEAR_TICKS (= 2) clean ticks
        for (let i = 0; i < SAME_BAR_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({ same_bar_trigger_count: SAME_BAR_CLEAN }),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(1);

        const payload: IMarketStressResumedEvent = resumedCalls[0][1];

        expect(payload.triggerLeg).toBe('same_bar');
        expect(payload.clearCount).toBe(SAME_BAR_RESUME_CLEAR_TICKS);
        expect(payload.utcDateString).toBe(DATE);
        expect(typeof payload.dailyReHaltCount).toBe('number');
        expect(typeof payload.nearReHaltCap).toBe('boolean');
    });
});

// ─── BR1: breadth halt + 2 clean ticks → still GLOBAL_HALT (needs 3) ─────────

describe('RiskGateService M28 — BR1: breadth halt path unchanged — 2 clean breadth ticks still not enough', () => {
    it('breadth halt + 2 clean ticks → still GLOBAL_HALT (MARKET_STRESS_RESUME_CLEAR_TICKS=3 not met)', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < MARKET_STRESS_RESUME_CLEAR_TICKS - 1; i++) {
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
});

// ─── BR2: breadth halt + 3 clean ticks → auto-resumes (unchanged from M23) ───

describe('RiskGateService M28 — BR2: breadth halt + 3 clean breadth ticks → auto-resumes (M23 behavior preserved)', () => {
    it('3 consecutive clean breadth ticks resume a market_stress:breadth halt', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
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

        expect(clearHaltMock).toHaveBeenCalledWith(DATE);
    });
});

// ─── BR3: clean same_bar tick does NOT advance a breadth halt's counter ────────

describe('RiskGateService M28 — BR3: same_bar clean tick does NOT advance breadth resume counter (cross-contamination prevention)', () => {
    it('3 ticks with clean same_bar but still-stressed breadth (in gap zone) do NOT advance breadth counter', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Snapshot: breadth in the gap zone (|19-50|=31 > 30 → NOT a clean breadth tick),
        // but same_bar is clean (count=11). The same_bar clean state must NOT
        // count as a clean tick for the breadth resume path.
        for (let i = 0; i < 3; i++) {
            const result = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({
                        market_breadth_5m_up_pct: 19, // |19-50|=31 > 30 → not clean breadth
                        same_bar_trigger_count: SAME_BAR_CLEAN, // clean same_bar
                    }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );

            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        }
    });

    it('2 ticks with clean same_bar and stressed breadth do NOT resume a breadth halt after 2 ticks (breadth needs 3)', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 2; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot({
                        market_breadth_5m_up_pct: BREADTH_COLLAPSE, // breadth still stressed
                        same_bar_trigger_count: SAME_BAR_CLEAN, // same_bar is clean — irrelevant
                    }),
                    isHalted: true,
                    haltReason: 'market_stress:breadth',
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── FL1: full-day-lock legs unchanged ────────────────────────────────────────

describe('RiskGateService M28 — FL1: full-day-lock halt reasons + 10 clean ticks → still GLOBAL_HALT', () => {
    const FULL_DAY_LOCK_REASONS = [
        'market_stress:multi',
        'market_stress:btc_shock',
        'market_stress:eth_shock',
        'market_stress:oi',
        'market_stress:funding',
        'market_stress:spread',
        'market_stress:invalid',
        'market_stress', // bare legacy (no suffix)
        'consecutive_loss_halt',
        'daily_loss_limit',
        'weekly_loss_limit',
        'model_divergence_halt',
    ];

    it.each(FULL_DAY_LOCK_REASONS)('halt_reason="%s" + 10 clean ticks → still GLOBAL_HALT', async (haltReason) => {
        const { gate } = buildGate();
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 10; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason,
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });
});

// ─── RC1: per-day re-halt cap — shared between breadth and same_bar ───────────

describe('RiskGateService M28 — RC1: 3rd market_stress re-halt (any mix of breadth/same_bar) → full-day lock', () => {
    // The shared per-day cap (MARKET_STRESS_MAX_DAILY_REHALT) counts stress ENGAGES, not resumes.
    // stressReHaltCount advances ONLY when isStressed() engages on a not-yet-halted day (the
    // `!state.today.isHalted` guard in firstFailingHaltCheck). Auto-resume clears the in-memory day
    // and resets the clean-tick counter, but it does NOT reset stressReHaltCount — so each fresh
    // engage→resume→engage cycle drives the counter one closer to the cap. These tests run REAL
    // cycles (mirroring RiskGateService.m23.spec.ts AR12) rather than back-to-back engages, so the
    // counter genuinely reaches the cap before we assert the day-lock holds.

    // Drives one full engage→(clean ticks)→resume cycle on the given leg, advancing stressReHaltCount
    // by exactly one. The engage runs on a not-halted day; the resume runs `cleanTicks` clean ticks on
    // the halted day until clearHaltForDate fires.
    async function runEngageResumeCycle(gate: RiskGateService, intent: IOrderIntent, leg: 'breadth' | 'same_bar', cleanTicks: number): Promise<void> {
        const engageSnapshot = leg === 'breadth' ? buildBreadthStressedSnapshot() : buildSameBarStressedSnapshot();

        await gate.evaluate(intent, buildContext({ snapshot: engageSnapshot, isHalted: false, haltReason: null }));

        for (let tick = 0; tick < cleanTicks; tick++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: `market_stress:${leg}`,
                }),
            );
        }
    }

    it('breadth+same_bar mix — 3 full engage→resume→engage cycles reach the cap → 4th re-halt stays full-day locked', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Cycle 1: breadth engage → 3 clean breadth ticks → resume (stressReHaltCount=1)
        await runEngageResumeCycle(gate, intent, 'breadth', MARKET_STRESS_RESUME_CLEAR_TICKS);

        // Cycle 2: same_bar engage → 2 clean same_bar ticks → resume (stressReHaltCount=2)
        await runEngageResumeCycle(gate, intent, 'same_bar', SAME_BAR_RESUME_CLEAR_TICKS);

        // Cycle 3: breadth engage → at this engage stressReHaltCount=3 = MARKET_STRESS_MAX_DAILY_REHALT.
        await gate.evaluate(intent, buildContext({ snapshot: buildBreadthStressedSnapshot(), isHalted: false, haltReason: null }));

        // Cap reached. Any clean tick on a still-halted day must NOT auto-resume — for EITHER leg.
        const sameBarResult = await gate.evaluate(
            intent,
            buildContext({ snapshot: buildCalmSnapshot(), isHalted: true, haltReason: 'market_stress:same_bar' }),
        );

        expect(sameBarResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);

        const breadthResult = await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot({ market_breadth_5m_up_pct: BREADTH_CLEAN }),
                isHalted: true,
                haltReason: 'market_stress:breadth',
            }),
        );

        expect(breadthResult.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });

    it('pure same_bar — 3 full engage→resume→engage cycles reach the cap → next clean ticks stay full-day locked', async () => {
        const { gate } = buildGate();
        const intent = buildIntent();

        // Cycles 1 and 2: same_bar engage → 2 clean ticks → resume (stressReHaltCount=1, then 2)
        await runEngageResumeCycle(gate, intent, 'same_bar', SAME_BAR_RESUME_CLEAR_TICKS);
        await runEngageResumeCycle(gate, intent, 'same_bar', SAME_BAR_RESUME_CLEAR_TICKS);

        // Cycle 3 engage: stressReHaltCount=3 = MARKET_STRESS_MAX_DAILY_REHALT.
        await gate.evaluate(intent, buildContext({ snapshot: buildSameBarStressedSnapshot(), isHalted: false, haltReason: null }));

        // Cap reached. Even SAME_BAR_RESUME_CLEAR_TICKS clean same_bar ticks cannot resume now.
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;
        const clearHaltMock = jest.fn().mockResolvedValue(undefined);

        for (let tick = 0; tick < SAME_BAR_RESUME_CLEAR_TICKS + 1; tick++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                    riskStateOverrides: { clearHaltForDate: clearHaltMock },
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        expect(clearHaltMock).not.toHaveBeenCalled();
    });
});

// ─── FO1: flag off → same_bar halt never auto-resumes ─────────────────────────

describe('RiskGateService M28 — FO1: MARKET_STRESS_AUTO_RESUME_ENABLED=false → same_bar halt never resumes', () => {
    it('with flag off: same_bar halt + 10 clean ticks → still GLOBAL_HALT', async () => {
        const { gate } = buildGate(false); // auto-resume disabled
        const intent = buildIntent();
        let lastResult: Awaited<ReturnType<RiskGateService['evaluate']>> | null = null;

        for (let i = 0; i < 10; i++) {
            lastResult = await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        expect(lastResult?.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
    });

    it('with flag off: MARKET_STRESS_RESUMED event is never emitted for same_bar', async () => {
        const { gate, events } = buildGate(false);
        const intent = buildIntent();

        for (let i = 0; i < 10; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(resumedCalls).toHaveLength(0);
    });
});

// ─── DD1: per-transition dedup — breadth resume then same_bar resume same day ──

describe('RiskGateService M28 — DD1: per-transition dedup — breadth resume in day T, then same_bar halt + 2 clean → second RESUMED event fires', () => {
    it('second MARKET_STRESS_RESUMED event fires with triggerLeg="same_bar" after breadth already resumed', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // Step 1: breadth halt → MARKET_STRESS_RESUME_CLEAR_TICKS (3) clean ticks → breadth resumes
        await gate.evaluate(intent, buildContext({ snapshot: buildBreadthStressedSnapshot(), isHalted: false, haltReason: null }));

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

        const breadthResumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(breadthResumedCalls).toHaveLength(1);
        expect(breadthResumedCalls[0][1].triggerLeg).toBe('breadth');

        // Step 2: same_bar halt + SAME_BAR_RESUME_CLEAR_TICKS (2) clean ticks → same_bar resumes
        await gate.evaluate(intent, buildContext({ snapshot: buildSameBarStressedSnapshot(), isHalted: false, haltReason: null }));

        for (let i = 0; i < SAME_BAR_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        const allResumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        // Second RESUMED event must have fired (per-transition dedup, not date-only dedup)
        expect(allResumedCalls).toHaveLength(2);
        expect(allResumedCalls[1][1].triggerLeg).toBe('same_bar');
    });
});

// ─── DD2: per-transition dedup — same_bar re-halt fires third event ───────────

describe('RiskGateService M28 — DD2: same_bar resume → same_bar re-halt → 2 more clean ticks → third RESUMED event fires', () => {
    it('a same_bar re-halt and re-resume within the same day each fire distinct RESUMED events', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // First same_bar cycle: engage → 2 clean ticks → first resume
        await gate.evaluate(intent, buildContext({ snapshot: buildSameBarStressedSnapshot(), isHalted: false, haltReason: null }));

        for (let i = 0; i < SAME_BAR_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        const firstResumed = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);
        expect(firstResumed).toHaveLength(1);

        // Second same_bar cycle: re-engage → 2 clean ticks → second resume
        await gate.evaluate(intent, buildContext({ snapshot: buildSameBarStressedSnapshot(), isHalted: false, haltReason: null }));

        for (let i = 0; i < SAME_BAR_RESUME_CLEAR_TICKS; i++) {
            await gate.evaluate(
                intent,
                buildContext({
                    snapshot: buildCalmSnapshot(),
                    isHalted: true,
                    haltReason: 'market_stress:same_bar',
                }),
            );
        }

        const afterSecondResume = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        expect(afterSecondResume).toHaveLength(2);
        // Both have the same_bar leg
        expect(afterSecondResume[1][1].triggerLeg).toBe('same_bar');
    });
});

// ─── DD3: same-tick duplicate — no double RESUMED event ──────────────────────

describe('RiskGateService M28 — DD3: same-tick duplicate suppressed — no double RESUMED event on a single evaluate call', () => {
    it('a single evaluate call that triggers resume emits MARKET_STRESS_RESUMED exactly once', async () => {
        const { gate, events } = buildGate();
        const intent = buildIntent();

        // Drive counter to SAME_BAR_RESUME_CLEAR_TICKS - 1 (= 1)
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot(),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        // This single evaluate call is the resume-triggering tick
        await gate.evaluate(
            intent,
            buildContext({
                snapshot: buildCalmSnapshot(),
                isHalted: true,
                haltReason: 'market_stress:same_bar',
            }),
        );

        const resumedCalls = events.mock.calls.filter(([event]: [string]) => event === MARKET_STRESS_RESUMED_EVENT);

        // Exactly one event fired — no duplication within a single evaluate
        expect(resumedCalls).toHaveLength(1);
    });
});

// ─── M28 constants integrity ──────────────────────────────────────────────────

describe('M28 riskConsts — constant values match specification', () => {
    it('SAME_BAR_RESUME_CLEAR_TICKS is 2', () => {
        expect(SAME_BAR_RESUME_CLEAR_TICKS).toBe(2);
    });

    it('SAME_BAR_RESUME_CLEAR_TICKS is less than MARKET_STRESS_RESUME_CLEAR_TICKS (same_bar converges faster)', () => {
        expect(SAME_BAR_RESUME_CLEAR_TICKS).toBeLessThan(MARKET_STRESS_RESUME_CLEAR_TICKS);
    });

    it('STRESS_SAME_BAR_HALT_COUNT is 20', () => {
        expect(STRESS_SAME_BAR_HALT_COUNT).toBe(20);
    });

    it('STRESS_SAME_BAR_RESUME_COUNT is 12', () => {
        expect(STRESS_SAME_BAR_RESUME_COUNT).toBe(12);
    });
});
