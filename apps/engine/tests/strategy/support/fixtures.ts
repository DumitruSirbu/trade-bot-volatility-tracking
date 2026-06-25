import {
    CoinTierEnum,
    CorrelationModeEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    IMarketSnapshot,
    IStrategyParams,
    IVolatilityDetectedEvent,
    PositionSlotEnum,
    RegimeLabelEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

// ─── IVolatilityDetectedEvent factory ────────────────────────────────────────
// Provides a complete, valid event that can be overridden per test.  All
// money values use decimal-as-string exactly as the wire format requires.
//
// Default fixture: ABOVE deviation (positive sigma), tier-1, RANGING regime,
// exhaustion confirmed (bollingerPctB=0.9 ≤ 1.0, volumeRatio=0.8 ≤ 1.0, OI
// falling), NOT idiosyncratic trap.  Pre-stamped with FORCED_EXHAUSTION flow.
export function buildEvent(overrides: Partial<IVolatilityDetectedEvent> = {}): IVolatilityDetectedEvent {
    return {
        symbol: 'BTCUSDT',
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: 1_716_307_200_000,
        eventId: 'BTCUSDT:1716307200000',

        // VWAP / deviation (price above VWAP → positive pct/sigma)
        vwapSession: '30000.00',
        vwap20bar: '29900.00',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 1.5,
        vwapDeviationSigma: 2.5,

        // volume — deceleration confirms exhaustion (volumeRatio ≤ 1.0)
        volumeRatio: 0.8,
        volume20barAvg: '1000000.00',

        // indicators
        atr14: '450.00',
        adx14: 25.0,
        adxDiPlus: 20.0,
        adxDiMinus: 15.0,
        rsi14: 60.0,
        bollingerUpper: '30400.00',
        bollingerLower: '28800.00',
        bollingerPctB: 0.9, // ≤ 1.0 → closed back inside band (exhaustion confirmed)

        // BTC reference / idiosyncrasy — NOT a trap (low idio)
        btc5mMovePct: -0.5,
        idiosyncrasyScore: 0.2,

        // universe / liquidity context
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 1,
        symbolUniverseAgeHours: 720,

        // funding
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.0365,
        openInterest: '5000000000.00',
        openInterestChange5mPct: -1.0, // OI falling → exhaustion confirmed, NOT idio trap
        openInterestChange15mPct: -1.5,
        aggTradeBuyVolumeRatio: 0.55,

        // order-book
        bidAskSpreadPct: 0.05,
        bookDepth10bpsUsdt: '20000000.00',
        bookDepth50bpsUsdt: '80000000.00',

        // breadth / stress / regime
        regimeLabel: RegimeLabelEnum.RANGING,
        marketBreadth5mUpPct: 55.0,
        sameBarTriggerCount: 1,
        btc1mMovePct: -0.2,
        eth5mMovePct: -0.4,

        flowType: FlowTypeEnum.FORCED_EXHAUSTION,

        ...overrides,
    };
}

// ─── IMarketSnapshot factory ──────────────────────────────────────────────────
// Mirrors the event fields that StrategyService.buildMarketSnapshot writes.
// signal_score is pre-set to a nominal value; tests that care should override it.
export function buildSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    return {
        vwap_session: '30000.00',
        vwap_20bar: '29900.00',
        vwap_deviation_pct: 1.5,
        vwap_deviation_sigma: 2.5,
        volume_ratio: 0.8,
        volume_20bar_avg: '1000000.00',
        atr_14: '450.00',
        adx_14: 25.0,
        adx_di_plus: 20.0,
        adx_di_minus: 15.0,
        rsi_14: 60.0,
        bollinger_upper: '30400.00',
        bollinger_lower: '28800.00',
        bollinger_pct_b: 0.9,
        btc_5m_move_pct: -0.5,
        idiosyncrasy_score: 0.2,
        funding_rate: 0.0001,
        funding_rate_annualized: 0.0365,
        bid_ask_spread_pct: 0.05,
        estimated_slippage_pct: 0.1,
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: CorrelationModeEnum.CORRELATED,
        signal_score: 65,
        position_slot: PositionSlotEnum.A,
        active_positions_count: 0,
        regime_label: RegimeLabelEnum.RANGING,
        entry_candle_open_time: 1_716_307_200_000,
        open_interest: '5000000000.00',
        open_interest_change_5m_pct: -1.0,
        open_interest_change_15m_pct: -1.5,
        agg_trade_buy_volume_ratio: 0.55,
        market_breadth_5m_up_pct: 55.0,
        same_bar_trigger_count: 1,
        book_depth_10bps_usdt: '20000000.00',
        book_depth_50bps_usdt: '80000000.00',
        vwap_anchor_type: VwapAnchorTypeEnum.SESSION,
        symbol_universe_age_hours: 720,
        btc_1m_move_pct: -0.2,
        eth_5m_move_pct: -0.4,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,

        ...overrides,
    };
}

// ─── IStrategyParams factory ──────────────────────────────────────────────────
// Mirrors the M2 seed canonical params so tests use realistic defaults.
export function buildParams(overrides: Partial<IStrategyParams> = {}): IStrategyParams {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 1.5,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.7,
        btc_correlated_move_threshold_pct: 0.3,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier1_max_abs_move_pct: 3.0,
        tier2_min_abs_move_pct: 0.8,
        tier2_max_abs_move_pct: 5.0,
        tier3_min_abs_move_pct: 1.2,
        tier3_max_abs_move_pct: 8.0,
        funding_rate_suppress_threshold: 0.001,
        candle_interval: '5m',
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 5,
        max_trades_per_symbol_per_day: 10,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 1.0,
        stress_eth_1m_shock_pct: 1.5,
        stress_breadth_pct: 80.0,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.3,
        structural_stop_hard_cap_pct: 2.0,
        min_rr: 1.5,
        entry_pct_floor: 0.3,
        atr_floor_multiplier: 0.3,
        max_tp_dist_factor: 5.0,

        ...overrides,
    };
}
