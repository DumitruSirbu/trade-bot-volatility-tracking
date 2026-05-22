import { marketSnapshotSchema, CoinTierEnum, RegimeLabelEnum, VwapAnchorTypeEnum, FlowTypeEnum, PositionSlotEnum } from '@bot/shared';

// A complete, valid market snapshot matching every field in the Zod schema.
function buildValidSnapshot(): Record<string, unknown> {
    return {
        vwap_session: '29500.123456789012345678',
        vwap_20bar: '29450.0',
        vwap_deviation_pct: -1.23,
        vwap_deviation_sigma: -2.1,
        volume_ratio: 2.5,
        volume_20bar_avg: '1234567.89',
        atr_14: '450.25',
        adx_14: 28.5,
        adx_di_plus: 18.2,
        adx_di_minus: 22.1,
        rsi_14: 42.0,
        bollinger_upper: '30200.0',
        bollinger_lower: '28800.0',
        bollinger_pct_b: 0.35,
        btc_5m_move_pct: -0.8,
        idiosyncrasy_score: 0.72,
        funding_rate: 0.0001,
        funding_rate_annualized: 0.1095,
        bid_ask_spread_pct: 0.02,
        estimated_slippage_pct: 0.15,
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 1,
        correlation_mode: 'correlated',
        signal_score: 0.85,
        position_slot: PositionSlotEnum.A,
        active_positions_count: 1,
        regime_label: RegimeLabelEnum.RANGING,
        entry_candle_open_time: 1716307200000,
        open_interest: '5000000000.0',
        open_interest_change_5m_pct: 0.5,
        open_interest_change_15m_pct: 1.2,
        agg_trade_buy_volume_ratio: 0.55,
        market_breadth_5m_up_pct: 62.0,
        same_bar_trigger_count: 1,
        book_depth_10bps_usdt: '2000000.0',
        book_depth_50bps_usdt: '8000000.0',
        vwap_anchor_type: VwapAnchorTypeEnum.SESSION,
        symbol_universe_age_hours: 240.0,
        btc_1m_move_pct: -0.3,
        eth_5m_move_pct: -0.9,
        flow_type: FlowTypeEnum.UNCLASSIFIED,
    };
}

describe('marketSnapshotSchema — valid snapshot', () => {
    it('safeParses a complete valid snapshot successfully', () => {
        const result = marketSnapshotSchema.safeParse(buildValidSnapshot());

        expect(result.success).toBe(true);
    });
});

describe('marketSnapshotSchema — missing required fields', () => {
    it('fails safeParse when a required field is absent, without throwing', () => {
        const snapshot = buildValidSnapshot();
        delete snapshot['vwap_session'];

        // The DecisionRepository validateMarketSnapshot hook calls safeParse and
        // logs a WARN on failure — it must never throw. Verify the parse itself
        // does not throw and produces an error result.
        let result: ReturnType<typeof marketSnapshotSchema.safeParse> | undefined;

        expect(() => {
            result = marketSnapshotSchema.safeParse(snapshot);
        }).not.toThrow();

        expect(result!.success).toBe(false);
    });

    it('reports the missing field path in the error issues', () => {
        const snapshot = buildValidSnapshot();
        delete snapshot['atr_14'];

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);

        if (!result.success) {
            const paths = result.error.issues.map((issue) => issue.path.join('.'));

            expect(paths).toContain('atr_14');
        }
    });

    it('fails when multiple required fields are absent', () => {
        const snapshot = buildValidSnapshot();
        delete snapshot['vwap_20bar'];
        delete snapshot['adx_14'];

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);

        if (!result.success) {
            const paths = result.error.issues.map((issue) => issue.path.join('.'));

            expect(paths).toContain('vwap_20bar');
            expect(paths).toContain('adx_14');
        }
    });
});

describe('marketSnapshotSchema — decimal-string field validation', () => {
    it('rejects a non-decimal string for vwap_session', () => {
        const snapshot = buildValidSnapshot();
        snapshot['vwap_session'] = 'not-a-number';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a JS number for a decimal-string field (vwap_20bar)', () => {
        // The schema expects a string matching the decimal regex, not a JS number.
        const snapshot = buildValidSnapshot();
        snapshot['vwap_20bar'] = 29450.0;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a decimal string in exponential notation for open_interest', () => {
        // The DECIMAL_REGEX in the schema does not permit "e" notation.
        const snapshot = buildValidSnapshot();
        snapshot['open_interest'] = '5e9';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('accepts a negative decimal string for atr_14 boundary', () => {
        // Negative decimals are syntactically valid; the schema does not constrain sign.
        const snapshot = buildValidSnapshot();
        snapshot['atr_14'] = '-1.5';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(true);
    });
});

describe('marketSnapshotSchema — enum field validation', () => {
    it('rejects an out-of-enum value for coin_tier', () => {
        const snapshot = buildValidSnapshot();
        snapshot['coin_tier'] = 'tier9';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects an out-of-enum value for regime_label', () => {
        const snapshot = buildValidSnapshot();
        snapshot['regime_label'] = 'bull_market';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects an out-of-enum value for flow_type', () => {
        const snapshot = buildValidSnapshot();
        snapshot['flow_type'] = 'unknown_flow';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects an out-of-enum value for vwap_anchor_type', () => {
        const snapshot = buildValidSnapshot();
        snapshot['vwap_anchor_type'] = 'open_of_day';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects an out-of-enum value for position_slot', () => {
        const snapshot = buildValidSnapshot();
        snapshot['position_slot'] = 'D';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('accepts all valid CoinTierEnum values', () => {
        for (const tier of Object.values(CoinTierEnum)) {
            const snapshot = buildValidSnapshot();
            snapshot['coin_tier'] = tier;

            const result = marketSnapshotSchema.safeParse(snapshot);

            expect(result.success).toBe(true);
        }
    });

    it('accepts all valid FlowTypeEnum values', () => {
        for (const flowType of Object.values(FlowTypeEnum)) {
            const snapshot = buildValidSnapshot();
            snapshot['flow_type'] = flowType;

            const result = marketSnapshotSchema.safeParse(snapshot);

            expect(result.success).toBe(true);
        }
    });
});
