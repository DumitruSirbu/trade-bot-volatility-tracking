/**
 * RiskGateService — M36 paper-soak consecutive-loss-halt relaxation
 *
 * Surfaces under test (all exercised through `checkLossWindows` via the public
 * `evaluate()` API driven by a context with 2 closed losses):
 *
 *   CL1 — Relax ON  — 2 closed losses today → returns null (no halt)
 *   CL2 — Relax ON  — persistHalt is NOT called (no consecutive_loss_halt row written)
 *   CL3 — Relax ON  — daily PnL <= -DAILY_LOSS_LIMIT_USDT → still DAILY_LOSS_LIMIT
 *   CL4 — Relax ON  — 7-day PnL <= -WEEKLY_LOSS_LIMIT_USDT → still WEEKLY_LOSS_LIMIT
 *   CL5 — Relax OFF (live env) — 2-loss streak → CONSECUTIVE_LOSS_HALT (regression)
 *   CL6 — Relax OFF (paper, flag unset) — 2-loss streak → CONSECUTIVE_LOSS_HALT (regression)
 *
 * Test structure: BUILD → OPERATE → CHECK
 * No real DB, no real exchange. All positions/state supplied as jest.fn() mocks.
 */

import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { IRiskGateContext, IRiskStateDay, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── fixture constants ────────────────────────────────────────────────────────

const DATE = '2026-07-08';
const NOW_MS = new Date(`${DATE}T04:00:00.000Z`).getTime();

// Two closed positions with negative PnL — enough to trip CONSECUTIVE_LOSS_HALT_COUNT=2
const TWO_CLOSED_LOSSES = [
    { realizedPnl: new Money('-10'), closedAtMs: NOW_MS - 7_200_000 },
    { realizedPnl: new Money('-15'), closedAtMs: NOW_MS - 3_600_000 },
];

// ─── snapshot / params / limits factories ────────────────────────────────────

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
        market_breadth_5m_up_pct: 50,
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
        regime_label: 'ranging',
        entry_candle_open_time: NOW_MS,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session',
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };
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
        consecutive_loss_halt: 100,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildLimitsWithinBounds() {
    return {
        dailyLossLimitUsdt: new Money(9999),
        weeklyLossLimitUsdt: new Money(99999),
        maxExposurePerCoinUsdt: new Money(9999),
        maxSameDirectionExposureUsdt: new Money(99999),
        cooldownAfterLossMs: 0,
    };
}

// ─── context factory ──────────────────────────────────────────────────────────

interface IContextOverrides {
    realizedPnlDay?: MoneyValue;
    weeklyPnl?: MoneyValue;
    closedPositions?: Array<{ realizedPnl: MoneyValue; closedAtMs: number }>;
    upsertDayMock?: jest.Mock;
}

function buildContext(overrides: IContextOverrides = {}): IRiskGateContext {
    const {
        realizedPnlDay = new Money(0),
        weeklyPnl = new Money(0),
        closedPositions = TWO_CLOSED_LOSSES,
        upsertDayMock = jest.fn().mockResolvedValue(undefined),
    } = overrides;

    const dayRow: IRiskStateDay = {
        date: DATE,
        realizedPnlDay,
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
    };

    return {
        nowMs: NOW_MS,
        utcDateString: DATE,
        snapshot: buildCalmSnapshot() as any,
        params: buildParams() as any,
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildLimitsWithinBounds(),
        modelDivergenceDetected: false,
        riskState: {
            getDay: jest.fn().mockResolvedValue(dayRow),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(weeklyPnl),
            upsertDay: upsertDayMock,
            upsertHaltForDay: jest.fn().mockResolvedValue(undefined),
            clearHaltForDate: jest.fn().mockResolvedValue(undefined),
        },
        openPositions: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue(closedPositions),
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

// ─── intent factory ───────────────────────────────────────────────────────────

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

// ─── gate factory ─────────────────────────────────────────────────────────────

function buildGate(paperRelaxConsecutiveLossHalt: boolean): { gate: RiskGateService } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) } as any;
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { emit: jest.fn() } as any;
    const appConfig = {
        marketStressAutoResumeEnabled: false,
        paperRelaxMarketStress: false,
        paperRelaxConsecutiveLossHalt,
    } as any;

    const gate = new RiskGateService(ledger, slotManager, stress, positions, riskState, events, appConfig);
    gate.markRecoveryComplete();

    return { gate };
}

// ─── CL1: Relax ON — 2 closed losses → no halt ───────────────────────────────

describe('RiskGateService M36 — CL1: relax ON, 2 closed losses today → no CONSECUTIVE_LOSS_HALT', () => {
    it('paper env + relax=true + 2 closed losses → evaluate does NOT return CONSECUTIVE_LOSS_HALT', async () => {
        // BUILD
        const { gate } = buildGate(true);
        const context = buildContext({ closedPositions: TWO_CLOSED_LOSSES });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).not.toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });
});

// ─── CL2: Relax ON — persistHalt NOT called ──────────────────────────────────

describe('RiskGateService M36 — CL2: relax ON → persistHalt (upsertDay) not called for consecutive-loss streak', () => {
    it('paper env + relax=true + 2 losses → riskState.upsertDay is NOT called with a halt reason', async () => {
        // BUILD
        const { gate } = buildGate(true);
        const upsertDayMock = jest.fn().mockResolvedValue(undefined);
        const context = buildContext({ closedPositions: TWO_CLOSED_LOSSES, upsertDayMock });
        const intent = buildIntent();

        // OPERATE
        await gate.evaluate(intent, context);

        // CHECK — upsertDay may be called for non-halt purposes, but must not carry isHalted=true
        const haltCalls = upsertDayMock.mock.calls.filter(([dayArg]) => dayArg?.isHalted === true);
        expect(haltCalls).toHaveLength(0);
    });
});

// ─── CL3: Relax ON — daily loss limit still fires ────────────────────────────

describe('RiskGateService M36 — CL3: relax ON but daily loss limit still fires', () => {
    it('paper env + relax=true + realizedPnlDay <= -DAILY_LOSS_LIMIT → DAILY_LOSS_LIMIT', async () => {
        // BUILD — daily PnL exactly at the limit threshold (-9999 against a limit of 9999)
        const { gate } = buildGate(true);
        const context = buildContext({
            realizedPnlDay: new Money('-9999'),
            closedPositions: TWO_CLOSED_LOSSES,
        });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).toBe(RejectReasonEnum.DAILY_LOSS_LIMIT);
    });

    it('paper env + relax=true + realizedPnlDay below -DAILY_LOSS_LIMIT → DAILY_LOSS_LIMIT', async () => {
        // BUILD — PnL well below the daily limit
        const { gate } = buildGate(true);
        const context = buildContext({
            realizedPnlDay: new Money('-10000'),
            closedPositions: TWO_CLOSED_LOSSES,
        });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).toBe(RejectReasonEnum.DAILY_LOSS_LIMIT);
    });
});

// ─── CL4: Relax ON — weekly loss limit still fires ───────────────────────────

describe('RiskGateService M36 — CL4: relax ON but 7-day loss limit still fires', () => {
    it('paper env + relax=true + weekly PnL <= -WEEKLY_LOSS_LIMIT → WEEKLY_LOSS_LIMIT', async () => {
        // BUILD — weekly PnL exactly at the limit (-99999 against limit of 99999)
        const { gate } = buildGate(true);
        const context = buildContext({
            weeklyPnl: new Money('-99999'),
            closedPositions: TWO_CLOSED_LOSSES,
        });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).toBe(RejectReasonEnum.WEEKLY_LOSS_LIMIT);
    });
});

// ─── CL5: Relax OFF (live env) — streak halts ────────────────────────────────

describe('RiskGateService M36 — CL5: relax OFF in live env — 2-loss streak still halts (regression)', () => {
    it('live env + relax=false + 2 closed losses → CONSECUTIVE_LOSS_HALT', async () => {
        // BUILD — relax is false (live env gate: flag is neutralized at config level, not gate level)
        const { gate } = buildGate(false);
        const context = buildContext({ closedPositions: TWO_CLOSED_LOSSES });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });
});

// ─── CL6: Relax OFF (paper, flag unset) — streak halts ──────────────────────

describe('RiskGateService M36 — CL6: relax OFF in paper env (flag unset) — streak still halts (regression)', () => {
    it('paper env + relax=false (flag not set) + 2 losses → CONSECUTIVE_LOSS_HALT', async () => {
        // BUILD — same as live: flag resolves to false, relax is not active
        const { gate } = buildGate(false);
        const context = buildContext({ closedPositions: TWO_CLOSED_LOSSES });
        const intent = buildIntent();

        // OPERATE
        const result = await gate.evaluate(intent, context);

        // CHECK
        expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
    });
});
