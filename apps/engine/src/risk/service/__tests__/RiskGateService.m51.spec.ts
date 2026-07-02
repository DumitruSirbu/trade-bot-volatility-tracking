/**
 * RiskGateService — M51 paper-only per-coin liquidity relax (ADR 0042 §9).
 *
 * Exercises the relax END-TO-END through a REAL AppConfigService (not a hand-mocked
 * boolean) so the two-condition gate (EXCHANGE_ENV=paper AND
 * PAPER_RELAX_PER_COIN_LIQUIDITY=true) is proven at the gate decision, including the
 * security-critical anti-coverage case that the relax is UNREACHABLE on a LIVE env.
 *
 * All pre-liquidity checks are satisfied by the base fixture so only spread/depth vary.
 *
 *   M51-1 — flag OFF (paper) → thin tier1 leader ($2,600) still COIN_BOOK_TOO_THIN
 *   M51-2 — flag ON + paper  → thin tier1 leader ($2,600) passes; ($2,400) still fails
 *   M51-3 — anti-coverage: flag ON + LIVE → live $10k floor applied ($2,600 rejects)
 *   M51-4 — spread boundary (flag ON + paper): 0.29 passes / 0.30 passes / 0.31 rejects
 *   M51-5 — depth boundary  (flag ON + paper): $2,500 rejects / $2,501 passes
 *   M51-6 — live consts byte-for-byte unchanged
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
import { COIN_DEPTH_FLOOR_10BPS_USDT, TIER_SPREAD_CEILING_PCT } from '../../const/riskConsts';
import { IRiskGateContext, IOrderIntent } from '../../interface';
import { ReservationLedger } from '../ReservationLedger';
import { RiskGateService } from '../RiskGateService';
import { SlotManager } from '../SlotManager';
import { StressHaltEvaluator } from '../StressHaltEvaluator';

// ─── real AppConfigService driven by a ConfigService stub ────────────────────

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

// ─── fixtures (calm snapshot; only spread/depth vary per test) ───────────────

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
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.45,
        idiosyncrasy_score: 0.8,
        vwap_anchor_type: 'session' as any,
        symbol_universe_age_hours: 100,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

function buildParams() {
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

function buildIntent(): IOrderIntent {
    const entryPrice = new Money('50000');
    const stopLossPrice = new Money('49000');

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
            stopLossPrice,
            stopType: 'atr' as any,
            timeStopAtMs: 1_700_000_000_000 + 30 * 60_000,
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

function buildContext(bookDepth: string, spreadPct = 0.01): IRiskGateContext {
    const safeRiskStateDay = {
        date: '2023-11-14',
        realizedPnlDay: new Money(0),
        openExposure: new Money(0),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
    };

    return {
        nowMs: 1_700_000_000_000,
        utcDateString: '2023-11-14',
        snapshot: buildCalmSnapshot(bookDepth, spreadPct) as any,
        params: buildParams(),
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

// ─── M51-1: flag OFF → current soak behaviour unchanged ──────────────────────

describe('RiskGateService M51-1 — flag OFF: thin tier1 leader still COIN_BOOK_TOO_THIN', () => {
    it('EXCHANGE_ENV=paper + flag=false → depth $2,600 (tier1) rejects on the live $10k floor', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, false));

        const result = await gate.evaluate(buildIntent(), buildContext('2600'));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── M51-2: flag ON + paper → thin leader clears; still-thin fails ───────────

describe('RiskGateService M51-2 — flag ON + paper: relaxed floor admits the thin leader', () => {
    it('depth $2,600 (tier1) is NOT rejected for book depth (relaxed > $2,500 floor)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2600'));

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
    });

    it('depth $2,400 (tier1) still rejects COIN_BOOK_TOO_THIN (below the relaxed $2,500 floor)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2400'));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── M51-3: SECURITY-CRITICAL anti-coverage — relax NEVER reaches LIVE ───────

describe('RiskGateService M51-3 — anti-coverage: flag ON but LIVE env applies the live $10k floor', () => {
    it('EXCHANGE_ENV=live + flag=true → depth $2,600 (tier1) STILL rejects COIN_BOOK_TOO_THIN (relax unreachable)', async () => {
        // The two-condition gate resolves paperRelaxPerCoinLiquidity=false on a LIVE env, so the
        // gate reads the live tier1 floor ($10k). $2,600 < $10,000 → still too thin. This proves
        // the relaxed floor ($2,500) is NOT used off paper.
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.LIVE, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2600'));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('EXCHANGE_ENV=testnet + flag=true → depth $2,600 (tier1) STILL rejects COIN_BOOK_TOO_THIN', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.TESTNET, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2600'));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── M51-4: spread ceiling boundary (flag ON + paper) ────────────────────────

describe('RiskGateService M51-4 — flag ON + paper: relaxed spread ceiling boundary (<= 0.30%)', () => {
    // Deep book ($5,000 > relaxed $2,500 floor) so depth passes and ONLY spread is under test.
    it('spread 0.29% passes the spread guard', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('5000', 0.29));

        expect(result.rejectReason).not.toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
    });

    it('spread exactly 0.30% passes the spread guard (<= convention: 0.30 is admitted)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('5000', 0.3));

        expect(result.rejectReason).not.toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
    });

    it('spread 0.31% rejects SPREAD_TOO_WIDE (strict > ceiling)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('5000', 0.31));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
    });
});

// ─── M51-5: depth floor boundary (flag ON + paper) ───────────────────────────

describe('RiskGateService M51-5 — flag ON + paper: relaxed depth floor boundary (> $2,500)', () => {
    it('depth exactly $2,500 rejects COIN_BOOK_TOO_THIN (depth <= floor convention)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2500'));

        expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
        expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });

    it('depth $2,501 passes the depth guard (just above the relaxed floor)', async () => {
        const gate = buildGate(buildAppConfig(ExchangeEnvironmentEnum.PAPER, true));

        const result = await gate.evaluate(buildIntent(), buildContext('2501'));

        expect(result.rejectReason).not.toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
    });
});

// ─── M51-6: live consts byte-for-byte unchanged ──────────────────────────────

describe('RiskGateService M51-6 — live per-coin liquidity consts are NOT mutated by the relax', () => {
    it('COIN_DEPTH_FLOOR_10BPS_USDT retains its exact live tier values', () => {
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1]).toBe(10_000);
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2]).toBe(2_500);
        expect(COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3]).toBe(2_000);
    });

    it('TIER_SPREAD_CEILING_PCT retains its exact live tier values', () => {
        expect(TIER_SPREAD_CEILING_PCT[CoinTierEnum.TIER_1]).toBe(0.15);
        expect(TIER_SPREAD_CEILING_PCT[CoinTierEnum.TIER_2]).toBe(0.3);
        expect(TIER_SPREAD_CEILING_PCT[CoinTierEnum.TIER_3]).toBe(0.5);
    });
});
