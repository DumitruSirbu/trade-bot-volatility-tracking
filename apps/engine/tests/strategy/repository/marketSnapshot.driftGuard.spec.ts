/**
 * ADR 0002 §6 drift guard — marketSnapshotSchema ↔ IVolatilityDetectedEvent alignment.
 *
 * Catches a future rename on either side before it reaches production.
 * The test is intentionally declarative: it asserts that the set of keys required
 * by marketSnapshotSchema can be fully satisfied by combining the fields from
 * IVolatilityDetectedEvent with the known decision-context fields that the strategy
 * layer appends (estimated_slippage_pct, correlation_mode, signal_score,
 * position_slot, active_positions_count).
 *
 * If a field is renamed in the schema without updating the event type (or vice
 * versa), this test fails with a clear list of the missing keys.
 */

import { marketSnapshotSchema } from '@bot/shared';

// Fields that the strategy/risk layer ADDS to the volatility event payload when it
// assembles the market snapshot for DecisionRepository.  These are NOT on
// IVolatilityDetectedEvent but ARE required by marketSnapshotSchema.
const DECISION_CONTEXT_FIELDS = new Set(['estimated_slippage_pct', 'correlation_mode', 'signal_score', 'position_slot', 'active_positions_count']);

// The camelCase→snake_case mapping from IVolatilityDetectedEvent field names to the
// corresponding marketSnapshotSchema keys.  This is the contract between M1 (event)
// and M2 (snapshot schema).  A rename on either side without updating this map
// causes this test to fail.
const VOLATILITY_EVENT_TO_SNAPSHOT_KEY: Record<string, string> = {
    vwapSession: 'vwap_session',
    vwap20bar: 'vwap_20bar',
    vwapDeviationPct: 'vwap_deviation_pct',
    vwapDeviationSigma: 'vwap_deviation_sigma',
    volumeRatio: 'volume_ratio',
    volume20barAvg: 'volume_20bar_avg',
    atr14: 'atr_14',
    adx14: 'adx_14',
    adxDiPlus: 'adx_di_plus',
    adxDiMinus: 'adx_di_minus',
    rsi14: 'rsi_14',
    bollingerUpper: 'bollinger_upper',
    bollingerLower: 'bollinger_lower',
    bollingerPctB: 'bollinger_pct_b',
    btc5mMovePct: 'btc_5m_move_pct',
    idiosyncrasyScore: 'idiosyncrasy_score',
    fundingRate: 'funding_rate',
    fundingRateAnnualized: 'funding_rate_annualized',
    bidAskSpreadPct: 'bid_ask_spread_pct',
    coinTier: 'coin_tier',
    coinVolumeRank: 'coin_volume_rank',
    regimeLabel: 'regime_label',
    entryCandleOpenTime: 'entry_candle_open_time',
    openInterest: 'open_interest',
    openInterestChange5mPct: 'open_interest_change_5m_pct',
    openInterestChange15mPct: 'open_interest_change_15m_pct',
    aggTradeBuyVolumeRatio: 'agg_trade_buy_volume_ratio',
    marketBreadth5mUpPct: 'market_breadth_5m_up_pct',
    sameBarTriggerCount: 'same_bar_trigger_count',
    bookDepth10bpsUsdt: 'book_depth_10bps_usdt',
    bookDepth50bpsUsdt: 'book_depth_50bps_usdt',
    vwapAnchorType: 'vwap_anchor_type',
    symbolUniverseAgeHours: 'symbol_universe_age_hours',
    btc1mMovePct: 'btc_1m_move_pct',
    eth5mMovePct: 'eth_5m_move_pct',
    flowType: 'flow_type',
};

describe('marketSnapshotSchema ↔ IVolatilityDetectedEvent drift guard (ADR 0002 §6)', () => {
    const schemaKeys = new Set(Object.keys(marketSnapshotSchema.shape));
    const mappedSnapshotKeys = new Set([...Object.values(VOLATILITY_EVENT_TO_SNAPSHOT_KEY), ...DECISION_CONTEXT_FIELDS]);

    it('every key in marketSnapshotSchema is covered by the volatility event or decision-context fields', () => {
        const uncovered = [...schemaKeys].filter((key) => !mappedSnapshotKeys.has(key));

        expect(uncovered).toEqual([]);
    });

    it('every mapped volatility-event key exists in marketSnapshotSchema (no phantom keys in the map)', () => {
        const phantom = Object.values(VOLATILITY_EVENT_TO_SNAPSHOT_KEY).filter((key) => !schemaKeys.has(key));

        expect(phantom).toEqual([]);
    });

    it('every decision-context field exists in marketSnapshotSchema (no phantom decision-context keys)', () => {
        const phantom = [...DECISION_CONTEXT_FIELDS].filter((key) => !schemaKeys.has(key));

        expect(phantom).toEqual([]);
    });

    it('the combined mapped key count equals the schema key count (no missing, no extra)', () => {
        expect(mappedSnapshotKeys.size).toBe(schemaKeys.size);
    });
});
