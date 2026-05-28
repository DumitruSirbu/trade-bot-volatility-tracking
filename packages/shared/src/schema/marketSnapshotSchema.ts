import { z } from 'zod';
import { CoinTierEnum, RegimeLabelEnum, VwapAnchorTypeEnum, FlowTypeEnum, PositionSlotEnum, CorrelationModeEnum } from '../enum/index.js';

const DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

export const marketSnapshotSchema = z
    .object({
        vwap_session: z.string().regex(DECIMAL_REGEX),
        vwap_20bar: z.string().regex(DECIMAL_REGEX),
        vwap_deviation_pct: z.number(),
        vwap_deviation_sigma: z.number(),
        volume_ratio: z.number(),
        volume_20bar_avg: z.string().regex(DECIMAL_REGEX),
        atr_14: z.string().regex(DECIMAL_REGEX),
        adx_14: z.number(),
        adx_di_plus: z.number(),
        adx_di_minus: z.number(),
        rsi_14: z.number(),
        bollinger_upper: z.string().regex(DECIMAL_REGEX),
        bollinger_lower: z.string().regex(DECIMAL_REGEX),
        bollinger_pct_b: z.number(),
        btc_5m_move_pct: z.number(),
        idiosyncrasy_score: z.number(),
        funding_rate: z.number(),
        funding_rate_annualized: z.number(),
        bid_ask_spread_pct: z.number(),
        estimated_slippage_pct: z.number(),
        coin_tier: z.nativeEnum(CoinTierEnum),
        coin_volume_rank: z.number(),
        correlation_mode: z.nativeEnum(CorrelationModeEnum),
        signal_score: z.number(),
        position_slot: z.nativeEnum(PositionSlotEnum),
        active_positions_count: z.number(),
        regime_label: z.nativeEnum(RegimeLabelEnum),
        entry_candle_open_time: z.number(),
        open_interest: z.string().regex(DECIMAL_REGEX),
        open_interest_change_5m_pct: z.number(),
        open_interest_change_15m_pct: z.number(),
        agg_trade_buy_volume_ratio: z.number(),
        market_breadth_5m_up_pct: z.number(),
        same_bar_trigger_count: z.number(),
        book_depth_10bps_usdt: z.string().regex(DECIMAL_REGEX),
        book_depth_50bps_usdt: z.string().regex(DECIMAL_REGEX),
        vwap_anchor_type: z.nativeEnum(VwapAnchorTypeEnum),
        symbol_universe_age_hours: z.number(),
        btc_1m_move_pct: z.number(),
        eth_5m_move_pct: z.number(),
        flow_type: z.nativeEnum(FlowTypeEnum),
    })
    .strict();

export type IMarketSnapshot = z.infer<typeof marketSnapshotSchema>;
