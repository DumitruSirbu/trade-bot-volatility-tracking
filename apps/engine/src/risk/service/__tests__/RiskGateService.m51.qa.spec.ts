/**
 * RiskGateService — M51 adversarial QA (D1 time-stop ceiling + D2 paper liquidity relax).
 *
 * Goes beyond the paired implementer coverage (MomentumOrchestratorService.spec.ts M51 D1 block,
 * RiskGateService.spec.ts M51 D1 block, RiskGateService.m51.spec.ts D2 block) to probe:
 *
 *   QA-D1a — a NaN `rebalance_interval_ms` (corrupted strategy_versions.params) propagates to a
 *            NaN ceiling AND a NaN intent timeStopAtMs. Documents whether checkTimeStop fails
 *            CLOSED (reject) or fails OPEN (silently approves) on that NaN pair.
 *   QA-D1b — a zero rebalance interval collapses the ceiling to 0 and the intent's timeStopAtMs to
 *            exactly nowMs; the pre-existing lower-bound guard (`timeStopAtMs <= nowMs`) must still
 *            reject.
 *   QA-D1c — a negative rebalance interval drives both intent and ceiling negative; must still
 *            reject via the lower-bound guard.
 *   QA-D1+D2 — end-to-end: a thin-but-relaxed-liquidity symbol (tier1, depth $2,600, PAPER +
 *              flag-on) that ALSO carries the widened (2×) time-stop must clear BOTH checks
 *              together in one gate.evaluate() call, not just each in isolation.
 *   QA-D2a — sanity: depth exactly at the OLD live tier1 floor ($10,000) with the relax on still
 *            passes (the relaxed floor is strictly looser for tier1).
 *   QA-D2b — FINDING: the relax's single flat floor ($2,500) is looser than live tier1 ($10k) and
 *            byte-identical to live tier2 ($2,500), but STRICTER than live tier3 ($2,000) — a
 *            tier3 coin that would clear the LIVE floor can be REJECTED once the relax is turned
 *            on. This contradicts the design intent ("relaxed rule must be strictly looser, never
 *            accidentally stricter") for tier3 specifically.
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    ExchangeEnvironmentEnum,
    FlowTypeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    RejectReasonEnum,
    RiskOutcomeEnum,
} from '@bot/shared';

import { AppConfigService } from '../../../config/service/AppConfigService';
import { EnvironmentVariables } from '../../../config/EnvironmentVariables';
import { Money } from '../../../common/utils/money';
import { MS_PER_MINUTE } from '../../../common/const';
import { MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER } from '../../../strategy/const';
import { IRiskGateContext, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

const NOW_MS = 1_700_000_000_000;

// ─── real AppConfigService driven by a ConfigService stub (mirrors RiskGateService.m51.spec.ts) ──

function buildAppConfig(env: ExchangeEnvironmentEnum, relaxFlag: boolean): AppConfigService {
    const config: Partial<EnvironmentVariables> = {
        NODE_ENV: 'test' as any,
        EXCHANGE_ENV: env,
        PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
        PAPER_RELAX_MARKET_STRESS: false,
        PAPER_RELAX_PER_COIN_LIQUIDITY: relaxFlag,
        PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
    };
    const configService = { get: (key: string) => (config as Record<string, unknown>)[key] } as never;

    return new AppConfigService(configService);
}

function buildCalmSnapshot(bookDepth: string, spreadPct: number) {
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
        bid_ask_spread_pct: spreadPct,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: bookDepth,
        book_depth_50bps_usdt: '999999999',
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 80,
        position_slot: 'A' as any,
        active_positions_count: 0,
        regime_label: 'trending_up' as any,
        entry_candle_open_time: NOW_MS,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

function buildParams(timeStopMinutes: number) {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: timeStopMinutes,
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
        consecutive_loss_halt: 5,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 10,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
        min_rr: 1.5,
        entry_pct_floor: 0.3,
        atr_floor_multiplier: 0.3,
        max_tp_dist_factor: 5.0,
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

function buildIntent(timeStopAtMs: number, coinTier: CoinTierEnum = CoinTierEnum.TIER_1): IOrderIntent {
    const entryPrice = new Money('50000');
    const stopLossPrice = new Money('49000');

    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId: 'BTCUSDT:1700000000000',
        tradeSide: PositionSideEnum.LONG,
        signalScore: 80,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier,
        idiosyncrasyScore: 0.8,
        entryPrice,
        referencePrice: entryPrice,
        midAtTrigger: entryPrice,
        maintenanceMarginRate: new Money('0.005'),
        proposedExit: {
            takeProfitPrice: new Money('52000'),
            stopLossPrice,
            stopType: 'atr' as any,
            timeStopAtMs,
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

function buildContext(bookDepth: string, timeStopMinutes: number, spreadPct = 0.01): IRiskGateContext {
    const safeRiskStateDay = {
        date: '2023-11-14',
        realizedPnlDay: new Money(0),
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
    };

    return {
        nowMs: NOW_MS,
        utcDateString: '2023-11-14',
        snapshot: buildCalmSnapshot(bookDepth, spreadPct) as any,
        params: buildParams(timeStopMinutes),
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildLimits(),
        modelDivergenceDetected: false,
        riskState: {
            getDay: jest.fn().mockResolvedValue(safeRiskStateDay),
            sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money(0)),
            upsertDay: jest.fn().mockResolvedValue(undefined),
            upsertHaltForDay: jest.fn().mockResolvedValue(undefined),
            clearHaltForDate: jest.fn().mockResolvedValue(undefined),
        } as any,
        openPositions: {
            findOpen: jest.fn().mockResolvedValue([]),
            findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
            findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
            countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
        } as any,
        instruments: {
            findConstraints: jest.fn().mockResolvedValue({
                symbol: 'BTCUSDT',
                stepSize: new Money('0.001'),
                tickSize: new Money('0.01'),
                minNotional: new Money('5'),
                maintenanceMarginRate: new Money('0.005'),
            }),
        } as any,
    };
}

function buildGate(appConfig: AppConfigService): RiskGateService {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) } as any;
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { emit: jest.fn() } as any;

    const gate = new RiskGateService(ledger, slotManager, stress, positions, riskState, events, appConfig);
    gate.markRecoveryComplete();

    return gate;
}

// ─── QA-D1a: NaN rebalance interval — ceiling/intent-timeStop propagation ────

describe('RiskGateService M51 QA-D1a — NaN time-stop ceiling propagation (corrupted rebalance_interval_ms)', () => {
    it('a NaN ceiling paired with a NaN timeStopAtMs is REJECTED (fail-closed), not silently approved', async () => {
        // Mirrors what MomentumOrchestratorService would produce if params.rebalance_interval_ms
        // were NaN (e.g. a corrupted strategy_versions.params row): both
        // buildGateStrategyParams.time_stop_minutes AND the intent's timeStopAtMs derive from the
        // same NaN input, so BOTH sides of checkTimeStop's comparison become NaN.
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));
        const nanTimeStopMinutes = Math.ceil((NaN * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER) / MS_PER_MINUTE);
        const nanTimeStopAtMs = NOW_MS + NaN * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER;

        expect(Number.isNaN(nanTimeStopMinutes)).toBe(true);
        expect(Number.isNaN(nanTimeStopAtMs)).toBe(true);

        const result = await gate.evaluate(buildIntent(nanTimeStopAtMs), buildContext('999999', nanTimeStopMinutes));

        // EXPECTED (safe) behavior: a NaN time-stop input must fail closed, exactly like the
        // existing `!Number.isFinite(timeStopAtMs)` guard for a NaN timeStopAtMs alone.
        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
    });
});

// ─── QA-D1b/c: zero / negative rebalance interval — lower-bound guard still holds ─

describe('RiskGateService M51 QA-D1b — zero rebalance interval collapses to nowMs, lower-bound guard rejects', () => {
    it('ceiling=0 and timeStopAtMs=nowMs is REJECTED (timeStopAtMs <= nowMs)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));
        const zeroIntervalCeilingMinutes = Math.ceil((0 * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER) / MS_PER_MINUTE);
        const zeroIntervalTimeStopAtMs = NOW_MS + 0 * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER;

        const result = await gate.evaluate(buildIntent(zeroIntervalTimeStopAtMs), buildContext('999999', zeroIntervalCeilingMinutes));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
    });
});

describe('RiskGateService M51 QA-D1c — negative rebalance interval drives both sides negative, still rejects', () => {
    it('a negative interval yields timeStopAtMs < nowMs and is REJECTED', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));
        const negativeIntervalMs = -86_400_000;
        const ceilingMinutes = Math.ceil((negativeIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER) / MS_PER_MINUTE);
        const timeStopAtMs = NOW_MS + negativeIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER;

        const result = await gate.evaluate(buildIntent(timeStopAtMs), buildContext('999999', ceilingMinutes));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
    });
});

// ─── QA-D1+D2: end-to-end interaction — a thin-relaxed symbol ALSO needs the widened time-stop ──

describe('RiskGateService M51 QA-D1+D2 — combined: thin-but-relaxed liquidity symbol ALSO clears the widened time-stop', () => {
    it('PAPER + relax-on + depth $2,600 (tier1) + 48h timeStopAtMs against a 48h ceiling → APPROVED in one evaluate() call', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));
        const rebalanceIntervalMs = 86_400_000; // 24h default
        const ceilingMinutes = Math.ceil((rebalanceIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER) / MS_PER_MINUTE);
        const timeStopAtMs = NOW_MS + rebalanceIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER;

        const result = await gate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_1), buildContext('2600', ceilingMinutes));

        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('PAPER + relax-OFF + depth $2,600 (tier1) + 48h timeStopAtMs against a 48h ceiling → still REJECTED on liquidity (D1 alone is not enough)', async () => {
        // Isolates that D1 fixing the time-stop does NOT, by itself, unblock the thin leader —
        // confirms the two deliverables are independently necessary, not redundant.
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));
        const rebalanceIntervalMs = 86_400_000;
        const ceilingMinutes = Math.ceil((rebalanceIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER) / MS_PER_MINUTE);
        const timeStopAtMs = NOW_MS + rebalanceIntervalMs * MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER;

        const result = await gate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_1), buildContext('2600', ceilingMinutes));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── QA-D2a: sanity — relax must be strictly looser than the live tier1 floor ──

describe('RiskGateService M51 QA-D2a — sanity: relax admits depth exactly at the OLD live tier1 floor', () => {
    it('depth $10,000 (== old live tier1 floor) with relax ON (tier1) is NOT rejected for book depth', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));
        const timeStopMinutes = 60;
        const timeStopAtMs = NOW_MS + 30 * 60_000;

        const result = await gate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_1), buildContext('10000', timeStopMinutes));

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });
});

// ─── QA-D2b: FINDING — relax regresses tier3 (flat floor $2,500 > live tier3 floor $2,000) ──

describe('RiskGateService M51 QA-D2b — FINDING: relax is STRICTER than live for tier3, not strictly looser', () => {
    it('tier3 depth $2,200 clears the LIVE tier3 floor ($2,000) but rejects once the paper relax is enabled', async () => {
        const timeStopMinutes = 60;
        const timeStopAtMs = NOW_MS + 30 * 60_000;

        const liveOffGate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));
        const liveOffResult = await liveOffGate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_3), buildContext('2200', timeStopMinutes));

        // Baseline: $2,200 clears the LIVE tier3 floor ($2,000) — not too thin.
        expect(liveOffResult.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);

        const relaxOnGate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));
        const relaxOnResult = await relaxOnGate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_3), buildContext('2200', timeStopMinutes));

        // EXPECTED per the design intent ("relaxed rule must be strictly looser, never
        // accidentally stricter"): turning the relax ON should never newly reject a symbol that
        // passed under the live floor. ACTUAL: the relax's flat $2,500 floor is HIGHER than the
        // live tier3 floor ($2,000), so this symbol flips from admitted to COIN_BOOK_TOO_THIN.
        expect(relaxOnResult.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('tier2 depth is unaffected by the relax (relaxed $2,500 floor is byte-identical to the live tier2 floor)', async () => {
        const timeStopMinutes = 60;
        const timeStopAtMs = NOW_MS + 30 * 60_000;

        const relaxOnGate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));
        const atFloor = await relaxOnGate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_2), buildContext('2500', timeStopMinutes));
        const aboveFloor = await relaxOnGate.evaluate(buildIntent(timeStopAtMs, CoinTierEnum.TIER_2), buildContext('2501', timeStopMinutes));

        expect(atFloor.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        expect(aboveFloor.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});
