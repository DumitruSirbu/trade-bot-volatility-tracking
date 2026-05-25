/**
 * M2 Adversarial — Surface 5: Zod-validated market_snapshot write under schema drift.
 *
 * ADR 0002 §market_snapshot Zod contract:
 *   "a decision write that violates the snapshot contract never lands as silently
 *    corrupt JSONB."
 *
 * The M2 spec says the schema warns-not-throws on validation failure. This suite
 * adversarially confirms the WARN path is taken in every failure case, the row is
 * rejected at the Zod layer (safeParse returns false), and the schema's .strict()
 * modifier rejects unknown extra fields without crashing the process.
 *
 * Adversarial categories:
 *   - Missing required field (one at a time for the most safety-critical fields).
 *   - Unknown extra field after .strict() — must be rejected, not silently ignored.
 *   - JS number in a decimal-string field — must fail parse, not silently coerce.
 *   - null in a required field — must fail parse.
 *   - Stale/future enum value in flow_type — must fail parse.
 *   - Empty snapshot object {} — must fail parse.
 *   - Boundary: minimum passing snapshot has ALL required fields.
 */

import { marketSnapshotSchema, CoinTierEnum, RegimeLabelEnum, VwapAnchorTypeEnum, FlowTypeEnum, PositionSlotEnum, CorrelationModeEnum } from '@bot/shared';

// Build a complete, valid snapshot for use as the base in each adversarial test.
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
        correlation_mode: CorrelationModeEnum.CORRELATED,
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
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
    };
}

// ---------------------------------------------------------------------------
// Surface 5a — Missing required fields (safety-critical subset).
// ADR 0002 §market_snapshot Zod contract: "missing fields cause a logged
// warning, not a crash" — i.e. safeParse must return { success: false }.
// ---------------------------------------------------------------------------
describe('marketSnapshotSchema — adversarial missing safety-critical fields (ADR 0002 §market_snapshot Zod contract)', () => {
    const safetyFields = [
        'vwap_session',
        'atr_14',
        'signal_score',
        'flow_type',
        'entry_candle_open_time',
        'coin_tier',
        'position_slot',
        'open_interest',
    ] as const;

    for (const field of safetyFields) {
        it(`safeParse returns { success: false } when '${field}' is missing — warn path is taken, not throw`, () => {
            const snapshot = buildValidSnapshot();
            delete snapshot[field];

            // The DecisionRepository validateMarketSnapshot uses safeParse.
            // A crash here would mean the validator throws instead of returning false.
            let result: ReturnType<typeof marketSnapshotSchema.safeParse> | undefined;

            expect(() => {
                result = marketSnapshotSchema.safeParse(snapshot);
            }).not.toThrow();

            expect(result!.success).toBe(false);
        });
    }

    it('safeParse on a completely empty object returns { success: false } without throwing', () => {
        let result: ReturnType<typeof marketSnapshotSchema.safeParse> | undefined;

        expect(() => {
            result = marketSnapshotSchema.safeParse({});
        }).not.toThrow();

        expect(result!.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Surface 5b — Unknown extra field after .strict().
// ADR 0002 §market_snapshot Zod contract: the schema is .strict(), so unknown
// keys must cause a validation failure, not be silently stripped.
// ---------------------------------------------------------------------------
describe('marketSnapshotSchema — adversarial unknown extra fields under .strict() (ADR 0002 §market_snapshot Zod contract)', () => {
    it('rejects a snapshot with an unknown extra field — .strict() does not silently strip it', () => {
        const snapshot = buildValidSnapshot();
        snapshot['undocumented_field'] = 'future_value';

        const result = marketSnapshotSchema.safeParse(snapshot);

        // If this passes, it means .strict() was removed or weakened to .passthrough().
        expect(result.success).toBe(false);
    });

    it('rejects when a future schema field is added without updating the Zod schema', () => {
        // Simulate schema drift: a new field added to the event payload
        // but not yet in marketSnapshotSchema.
        const snapshot = buildValidSnapshot();
        snapshot['new_m7_field'] = 42;
        snapshot['another_new_field'] = 'drift';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);

        if (!result.success) {
            // .strict() adds an "unrecognized_keys" issue type.
            const hasUnrecognizedKeysIssue = result.error.issues.some((issue) => issue.code === 'unrecognized_keys');

            expect(hasUnrecognizedKeysIssue).toBe(true);
        }
    });

    it('the error issues contain the unrecognized key name when .strict() triggers', () => {
        const snapshot = buildValidSnapshot();
        snapshot['phantom_key'] = true;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);

        if (!result.success) {
            const keyIssue = result.error.issues.find((issue) => issue.code === 'unrecognized_keys');

            expect(keyIssue).toBeDefined();

            if (keyIssue && 'keys' in keyIssue) {
                expect((keyIssue as { keys: string[] }).keys).toContain('phantom_key');
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Surface 5c — JS number in a decimal-string field.
// ADR 0002 §market_snapshot Zod contract + ADR 0002 §money-as-decimal:
// a JS number must not silently coerce into the decimal string schema.
// ---------------------------------------------------------------------------
describe('marketSnapshotSchema — adversarial JS number in decimal-string fields (ADR 0002 §money-as-decimal)', () => {
    it('rejects a JS number for vwap_session (expected decimal string)', () => {
        const snapshot = buildValidSnapshot();
        snapshot['vwap_session'] = 29500.123456789;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a JS number for open_interest (expected decimal string)', () => {
        const snapshot = buildValidSnapshot();
        snapshot['open_interest'] = 5_000_000_000;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a JS number for book_depth_10bps_usdt (expected decimal string)', () => {
        const snapshot = buildValidSnapshot();
        snapshot['book_depth_10bps_usdt'] = 2_000_000;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects null for a required decimal-string field (vwap_20bar)', () => {
        const snapshot = buildValidSnapshot();
        snapshot['vwap_20bar'] = null;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Surface 5d — Stale or future enum values in flow_type / coin_tier.
// ADR 0002 §market_snapshot Zod contract: enum fields must reject unknown
// values, even ones that "look" like a valid enum variant from a future schema.
// ---------------------------------------------------------------------------
describe('marketSnapshotSchema — adversarial stale/future enum values (ADR 0002 §market_snapshot Zod contract)', () => {
    it('rejects a future unknown flow_type string ("btc_liquidation_cascade")', () => {
        const snapshot = buildValidSnapshot();
        snapshot['flow_type'] = 'btc_liquidation_cascade';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a stale flow_type string that was renamed in an enum migration', () => {
        // Simulates a rename: an old enum variant that no longer exists.
        const snapshot = buildValidSnapshot();
        snapshot['flow_type'] = 'forced_liquidation'; // hypothetical old name

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects null in flow_type — required enum field must not be null', () => {
        const snapshot = buildValidSnapshot();
        snapshot['flow_type'] = null;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects a future coin_tier value not in CoinTierEnum', () => {
        const snapshot = buildValidSnapshot();
        snapshot['coin_tier'] = 'tier_4';

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });

    it('rejects undefined for coin_tier — required enum field', () => {
        const snapshot = buildValidSnapshot();
        snapshot['coin_tier'] = undefined;

        const result = marketSnapshotSchema.safeParse(snapshot);

        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Surface 5e — Confirm the valid baseline still passes (regression backbone).
// ADR 0002 §market_snapshot Zod contract.
// ---------------------------------------------------------------------------
describe('marketSnapshotSchema — adversarial baseline regression (ADR 0002 §market_snapshot Zod contract)', () => {
    it('a snapshot with ALL required fields and no extras passes safeParse', () => {
        const result = marketSnapshotSchema.safeParse(buildValidSnapshot());

        expect(result.success).toBe(true);
    });

    it('all valid FlowTypeEnum values pass safeParse independently', () => {
        for (const flowType of Object.values(FlowTypeEnum)) {
            const snapshot = buildValidSnapshot();
            snapshot['flow_type'] = flowType;

            const result = marketSnapshotSchema.safeParse(snapshot);

            expect(result.success).toBe(true);
        }
    });

    it('all valid CoinTierEnum values pass safeParse independently', () => {
        for (const tier of Object.values(CoinTierEnum)) {
            const snapshot = buildValidSnapshot();
            snapshot['coin_tier'] = tier;

            const result = marketSnapshotSchema.safeParse(snapshot);

            expect(result.success).toBe(true);
        }
    });
});
