/**
 * Risk-gate test fixtures. All factories produce valid, independent value objects.
 * Tests override only the fields under test — see F.I.R.S.T. / Clean Code §Tests.
 */

import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, OrderIntentActionEnum, PositionSideEnum, PositionSlotEnum } from '@bot/shared';
import { StopTypeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import {
    COOLDOWN_AFTER_LOSS_MS,
    DAILY_LOSS_LIMIT_USDT,
    DEFAULT_MAINTENANCE_MARGIN_RATE,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../../src/risk/const';
import { ReservationStateEnum } from '../../../src/risk/enum';
import { IExposureReservation, IInstrumentConstraints, IIntentSizing, IOrderIntent, IRiskGateContext, IRiskLimits } from '../../../src/risk/interface';
import { IClosedPositionView, IOpenPositionView } from '../../../src/risk/interface/IOpenPositionsPort';
import { IRiskStateDay } from '../../../src/risk/interface/IRiskStatePort';
import { IProposedExit } from '../../../src/strategy/interface';
import { buildParams, buildSnapshot } from '../../strategy/support/fixtures';

// ─── IProposedExit ────────────────────────────────────────────────────────────

export function buildProposedExit(overrides: Partial<IProposedExit> = {}): IProposedExit {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000; // bar close
    return {
        takeProfitPrice: new Money('29000'),
        // Stop ABOVE entry (30000): correct for the default SHORT side. A SHORT's protective
        // stop must sit above entry so it triggers before the position reaches liquidation.
        stopLossPrice: new Money('30500'),
        stopType: StopTypeEnum.ATR,
        timeStopAtMs: NOW_MS + 30 * 60_000, // 30 min from now (within 60 min limit)
        ...overrides,
    };
}

// ─── IIntentSizing ────────────────────────────────────────────────────────────

export function buildSizing(overrides: Partial<IIntentSizing> = {}): IIntentSizing {
    return {
        qty: new Money('0.01'),
        notional: new Money('100'),
        leverage: new Money('1'),
        riskPerTradeUsdt: new Money('10'),
        ...overrides,
    };
}

// ─── IInstrumentConstraints ───────────────────────────────────────────────────

export function buildInstrument(overrides: Partial<IInstrumentConstraints> = {}): IInstrumentConstraints {
    return {
        symbol: 'BTCUSDT',
        stepSize: new Money('0.001'),
        tickSize: new Money('0.1'),
        minNotional: new Money('5'),
        maintenanceMarginRate: new Money(DEFAULT_MAINTENANCE_MARGIN_RATE),
        ...overrides,
    };
}

// ─── IOrderIntent ─────────────────────────────────────────────────────────────

export function buildOrderIntent(overrides: Partial<IOrderIntent> = {}): IOrderIntent {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId: 'BTCUSDT:1716307200000',
        tradeSide: PositionSideEnum.SHORT,
        signalScore: 72,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8, // above default min of 0.7
        entryPrice: new Money('30000'),
        midAtTrigger: new Money('30000'),
        maintenanceMarginRate: new Money(DEFAULT_MAINTENANCE_MARGIN_RATE),
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        openPosition: null,
        sizing: buildSizing(),
        flowType: FlowTypeEnum.TREND_INITIATION,
        ...overrides,
    };
}

// ─── IRiskStateDay ────────────────────────────────────────────────────────────

export function buildRiskStateDay(overrides: Partial<IRiskStateDay> = {}): IRiskStateDay {
    return {
        date: '2024-05-21',
        realizedPnlDay: new Money('0'),
        openExposure: new Money('0'),
        tradesCount: 0,
        isHalted: false,
        haltReason: null,
        ...overrides,
    };
}

// ─── IOpenPositionView ────────────────────────────────────────────────────────

export function buildOpenPositionView(overrides: Partial<IOpenPositionView> = {}): IOpenPositionView {
    return {
        symbol: 'BTCUSDT',
        slot: PositionSlotEnum.A,
        side: PositionSideEnum.SHORT,
        notional: new Money('100'),
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        ...overrides,
    };
}

// ─── IClosedPositionView ──────────────────────────────────────────────────────

export function buildClosedPositionView(overrides: Partial<IClosedPositionView> = {}): IClosedPositionView {
    return {
        symbol: 'BTCUSDT',
        realizedPnl: new Money('-10'),
        closedAtMs: 1_716_307_200_000,
        ...overrides,
    };
}

// ─── IExposureReservation ─────────────────────────────────────────────────────

export function buildReservation(overrides: Partial<IExposureReservation> = {}): IExposureReservation {
    return {
        reservationId: 'test-event:A',
        symbol: 'BTCUSDT',
        slot: PositionSlotEnum.A,
        tradeSide: PositionSideEnum.SHORT,
        notional: new Money('100'),
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        createdAtMs: 1_716_307_200_000,
        expiresAtMs: 1_716_307_200_000 + 60_000,
        state: ReservationStateEnum.PENDING,
        ...overrides,
    };
}

// ─── Port fakes ───────────────────────────────────────────────────────────────

export function buildRiskStatePort(
    overrides: {
        day?: IRiskStateDay | null;
        weeklyPnl?: string;
    } = {},
) {
    const day = overrides.day !== undefined ? overrides.day : buildRiskStateDay();
    const weeklyPnl = new Money(overrides.weeklyPnl ?? '0');

    return {
        getDay: jest.fn().mockResolvedValue(day),
        sumRealizedPnlBetween: jest.fn().mockResolvedValue(weeklyPnl),
        upsertDay: jest.fn().mockResolvedValue(undefined),
        clearHaltForDate: jest.fn().mockResolvedValue(undefined),
    };
}

export function buildOpenPositionsPort(
    overrides: {
        open?: IOpenPositionView[];
        closed?: IClosedPositionView[];
        lastClose?: IClosedPositionView | null;
        countForSymbol?: number;
    } = {},
) {
    return {
        findOpen: jest.fn().mockResolvedValue(overrides.open ?? []),
        findClosedOnUtcDay: jest.fn().mockResolvedValue(overrides.closed ?? []),
        findLastCloseForSymbol: jest.fn().mockResolvedValue(overrides.lastClose ?? null),
        countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(overrides.countForSymbol ?? 0),
    };
}

export function buildInstrumentPort(constraints: IInstrumentConstraints | null = buildInstrument()) {
    return {
        findConstraints: jest.fn().mockResolvedValue(constraints),
    };
}

// ─── IRiskLimits ──────────────────────────────────────────────────────────────

export function buildRiskLimits(overrides: Partial<IRiskLimits> = {}): IRiskLimits {
    return {
        dailyLossLimitUsdt: new Money(DAILY_LOSS_LIMIT_USDT),
        weeklyLossLimitUsdt: new Money(WEEKLY_LOSS_LIMIT_USDT),
        maxExposurePerCoinUsdt: new Money(MAX_EXPOSURE_PER_COIN_USDT),
        maxSameDirectionExposureUsdt: new Money(MAX_SAME_DIRECTION_EXPOSURE_USDT),
        cooldownAfterLossMs: COOLDOWN_AFTER_LOSS_MS,
        ...overrides,
    };
}

// ─── IRiskGateContext ─────────────────────────────────────────────────────────

export function buildGateContext(overrides: Partial<IRiskGateContext> = {}): IRiskGateContext {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return {
        nowMs: NOW_MS,
        utcDateString: '2024-05-21',
        snapshot: buildSnapshot({
            bid_ask_spread_pct: 0.05, // well below tier-1 ceiling of 0.15%
            open_interest: '5000000000.00',
            open_interest_change_5m_pct: -1.0,
            same_bar_trigger_count: 1,
            market_breadth_5m_up_pct: 55.0,
            btc_1m_move_pct: -0.2,
            eth_5m_move_pct: -0.4,
            funding_rate: 0.0001,
            funding_rate_annualized: 0.0365,
            book_depth_10bps_usdt: '20000000.00',
            vwap_deviation_pct: -1.0, // negative → price below VWAP
        }),
        params: buildParams({
            idiosyncrasy_min_score: 0.7,
            max_trades_per_symbol_per_day: 10,
            max_trades_per_bar_universe: 3,
            funding_rate_suppress_threshold: 0.001,
            time_stop_minutes: 60,
            stress_btc_1m_shock_pct: 1.0,
            stress_eth_1m_shock_pct: 1.5,
            stress_breadth_pct: 80.0,
            stress_same_bar_trigger_count: 5,
            require_oi_available: false,
            oi_rising_skip: false,
        }),
        strategyVersionId: 1,
        belowUniverseFloor: false,
        limits: buildRiskLimits(),
        riskState: buildRiskStatePort(),
        openPositions: buildOpenPositionsPort(),
        instruments: buildInstrumentPort(),
        modelDivergenceDetected: false,
        ...overrides,
    };
}
