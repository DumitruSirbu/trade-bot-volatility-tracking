import { CoinTierEnum, CorrelationModeEnum, FlowTypeEnum, IMarketSnapshot, IStrategyParams, IVolatilityDetectedEvent, PositionSlotEnum } from '@bot/shared';

import { ACTIVE_POSITIONS_COUNT_DRY_RUN } from '../const';

// Pure mapper: builds the persisted market_snapshot from the trigger event + the
// orchestrator-stamped flow_type/signal_score. position_slot defaults to A and
// active_positions_count to the dry-run zero here; the risk gate overwrites position_slot
// with the real assigned slot before persistence (ADR 0004 §4). Extracted from
// StrategyService so the orchestrator stays small (conventions: function size).

export interface IMarketSnapshotInput {
    readonly event: IVolatilityDetectedEvent;
    readonly params: IStrategyParams;
    readonly flowType: FlowTypeEnum;
    readonly signalScore: number;
}

export function buildMarketSnapshot(input: IMarketSnapshotInput): IMarketSnapshot {
    const { event, flowType, signalScore } = input;

    return {
        vwap_session: event.vwapSession,
        vwap_20bar: event.vwap20bar,
        vwap_deviation_pct: event.vwapDeviationPct,
        vwap_deviation_sigma: event.vwapDeviationSigma,
        volume_ratio: event.volumeRatio,
        volume_20bar_avg: event.volume20barAvg,
        atr_14: event.atr14,
        adx_14: event.adx14,
        adx_di_plus: event.adxDiPlus,
        adx_di_minus: event.adxDiMinus,
        rsi_14: event.rsi14,
        bollinger_upper: event.bollingerUpper,
        bollinger_lower: event.bollingerLower,
        bollinger_pct_b: event.bollingerPctB,
        btc_5m_move_pct: event.btc5mMovePct,
        idiosyncrasy_score: event.idiosyncrasyScore,
        funding_rate: event.fundingRate,
        funding_rate_annualized: event.fundingRateAnnualized,
        bid_ask_spread_pct: event.bidAskSpreadPct,
        estimated_slippage_pct: resolveSlippagePct(input),
        coin_tier: event.coinTier,
        coin_volume_rank: event.coinVolumeRank,
        correlation_mode: resolveCorrelationMode(input),
        signal_score: signalScore,
        position_slot: PositionSlotEnum.A,
        active_positions_count: ACTIVE_POSITIONS_COUNT_DRY_RUN,
        regime_label: event.regimeLabel,
        entry_candle_open_time: event.entryCandleOpenTime,
        open_interest: event.openInterest,
        open_interest_change_5m_pct: event.openInterestChange5mPct,
        open_interest_change_15m_pct: event.openInterestChange15mPct,
        agg_trade_buy_volume_ratio: event.aggTradeBuyVolumeRatio,
        market_breadth_5m_up_pct: event.marketBreadth5mUpPct,
        same_bar_trigger_count: event.sameBarTriggerCount,
        book_depth_10bps_usdt: event.bookDepth10bpsUsdt,
        book_depth_50bps_usdt: event.bookDepth50bpsUsdt,
        vwap_anchor_type: event.vwapAnchorType,
        symbol_universe_age_hours: event.symbolUniverseAgeHours,
        btc_1m_move_pct: event.btc1mMovePct,
        eth_5m_move_pct: event.eth5mMovePct,
        flow_type: flowType,
    };
}

function resolveSlippagePct(input: IMarketSnapshotInput): number {
    const slippageByTier: Record<CoinTierEnum, number> = {
        [CoinTierEnum.TIER_1]: input.params.slippage_tier1_pct,
        [CoinTierEnum.TIER_2]: input.params.slippage_tier2_pct,
        [CoinTierEnum.TIER_3]: input.params.slippage_tier3_pct,
    };

    return slippageByTier[input.event.coinTier];
}

function resolveCorrelationMode(input: IMarketSnapshotInput): CorrelationModeEnum {
    if (Math.abs(input.event.btc5mMovePct) >= input.params.btc_correlated_move_threshold_pct) {
        return CorrelationModeEnum.CORRELATED;
    }

    return CorrelationModeEnum.IDIOSYNCRATIC;
}
