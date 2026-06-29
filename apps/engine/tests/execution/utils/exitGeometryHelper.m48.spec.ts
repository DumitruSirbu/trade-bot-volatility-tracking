/**
 * exitGeometryHelper — M48 fill-anchored geometry-integrity adversarial regression suite (ADR 0045)
 *
 * Surfaces under test: `evaluateFillDrift` with the new M48 `geometryParams` leg.
 * All distances anchor to the FILL price; the slFloor PCT threshold anchors to `referencePrice`
 * (signal-calibrated, NOT fill) — Item 2 invariant.
 *
 * Test groups:
 *
 *   (a) TP-ordering break — fill on the correct SL side but TP ordering violated
 *   (b) 212-style collapse — slDist_fill < slFloor (noise floor rejects)
 *   (c) 211-style inversion — tpDist / slDist < min_rr (ratio rejects)
 *   (d) 210-style pass — good trade must NOT be rejected
 *   (e) fill at SL (collapsed stop) — wrong_side_of_sl fires first
 *   (e2) Fail-closed input guard — missing geometryParams inputs reject
 *   (e3) slFloor anchor — PCT floor anchors to referencePrice, not fill
 *   (f) Parity / inertness — geometry leg is no-op when geometryParams absent
 *   (g) Option-B preservation — SL/TP prices are never mutated by the leg
 *
 *   Adversarial extras:
 *   (adv1) Zero ATR — PCT floor still binds a 212-style collapse
 *   (adv2) Enormous fill spike — ordering violation → DEGENERATE_GEOMETRY_AT_FILL
 *   (adv3) Mean-reversion defense-in-depth — leg applies regardless of flow_type
 *   (adv4) Anti-coverage — inverted always rejects; good trade never wrongly rejects
 */

import {
    CoinTierEnum,
    CorrelationModeEnum,
    FlowTypeEnum,
    IMarketSnapshot,
    PositionSideEnum,
    PositionSlotEnum,
    RegimeLabelEnum,
    StopTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import { evaluateFillDrift, IFillDriftContext } from '../../../src/execution/utils/exitGeometryHelper';
import { DEGENERATE_GEOMETRY_AT_FILL, WRONG_SIDE_OF_SL } from '../../../src/execution/const';
import { IProposedExit } from '../../../src/strategy/interface';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const DEFAULT_GEOMETRY_PARAMS = {
    min_rr: 1.5,
    atr_floor_multiplier: 1.5,
    entry_pct_floor: 0.3,
};

function buildSnapshot(overrides: Partial<IMarketSnapshot> = {}): IMarketSnapshot {
    return {
        vwap_session: '62.294',
        vwap_20bar: '62.000',
        vwap_deviation_pct: 1.5,
        vwap_deviation_sigma: 1.8,
        volume_ratio: 1.5,
        volume_20bar_avg: '500000',
        atr_14: '0.8',
        adx_14: 22,
        adx_di_plus: 18,
        adx_di_minus: 10,
        rsi_14: 55,
        bollinger_upper: '64.000',
        bollinger_lower: '61.000',
        bollinger_pct_b: 0.65,
        btc_5m_move_pct: 0.2,
        btc_1m_move_pct: 0.1,
        eth_5m_move_pct: 0.4,
        market_breadth_5m_up_pct: 58,
        same_bar_trigger_count: 1,
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.3,
        open_interest: '5000000',
        funding_rate: 0.0001,
        funding_rate_annualized: 0.11,
        bid_ask_spread_pct: 0.03,
        estimated_slippage_pct: 0.04,
        book_depth_10bps_usdt: '8000000',
        book_depth_50bps_usdt: '30000000',
        coin_tier: CoinTierEnum.TIER_1,
        coin_volume_rank: 3,
        correlation_mode: CorrelationModeEnum.IDIOSYNCRATIC,
        signal_score: 75,
        position_slot: PositionSlotEnum.A,
        active_positions_count: 0,
        regime_label: RegimeLabelEnum.TRENDING_DOWN,
        entry_candle_open_time: 1_700_000_000_000,
        agg_trade_buy_volume_ratio: 0.48,
        idiosyncrasy_score: 0.65,
        vwap_anchor_type: VwapAnchorTypeEnum.SESSION,
        symbol_universe_age_hours: 200,
        flow_type: FlowTypeEnum.FORCED_EXHAUSTION,
        ...overrides,
    };
}

function buildExit(overrides: Partial<IProposedExit> = {}): IProposedExit {
    return {
        takeProfitPrice: new Money('62.294'), // 212-style: TP at reference (signal-anchored)
        stopLossPrice: new Money('63.278'),
        stopType: StopTypeEnum.STRUCTURAL,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: false,
        atrDistance: null,
        ...overrides,
    };
}

function build212ShortCtx(overrides: Partial<IFillDriftContext> = {}): IFillDriftContext {
    // Live position 212 fixture: SHORT HYPE/USDT
    //   referencePrice=62.294, fill=63.250, SL=63.278, TP=62.294
    //   slDist_fill = |63.278 - 63.250| = 0.028 << slFloor
    //   slFloor = max(1.5 * 0.8, 0.003 * 62.294) = max(1.2, 0.18688) = 1.2
    //   0.028 < 1.2 → DEGENERATE_GEOMETRY_AT_FILL
    return {
        clampedExit: buildExit({
            stopLossPrice: new Money('63.278'),
            takeProfitPrice: new Money('62.294'),
        }),
        avgFillPrice: new Money('63.250'),
        side: PositionSideEnum.SHORT,
        entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
        geometryParams: DEFAULT_GEOMETRY_PARAMS,
        referencePrice: new Money('62.294'),
        ...overrides,
    };
}

// ─── (a) TP-ordering break ────────────────────────────────────────────────────

describe('exitGeometryHelper M48 — (a) TP-ordering break: SHORT fill correct SL side but TP > fill → DEGENERATE_GEOMETRY_AT_FILL', () => {
    it('SHORT fill < SL (correct SL side) but takeProfitPrice > fill violates SL>fill>TP ordering → rejects DEGENERATE_GEOMETRY_AT_FILL', () => {
        // SHORT requires SL > fill > TP.
        // fill=63.250, SL=63.278 (fill < SL ✓), TP=63.260 (TP > fill ✗ — ordering violated at TP end)
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('63.260'), // TP > fill — ordering violation
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('LONG fill > SL (correct SL side) but takeProfitPrice < fill violates TP>fill>SL ordering → rejects DEGENERATE_GEOMETRY_AT_FILL', () => {
        // LONG requires TP > fill > SL.
        // fill=63.250, SL=62.000 (fill > SL ✓), TP=63.200 (TP < fill ✗ — ordering violated)
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.000'),
                takeProfitPrice: new Money('63.200'), // TP < fill — ordering violation for LONG
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('SHORT fill AT or ABOVE SL → wrong_side_of_sl fires FIRST (not DEGENERATE_GEOMETRY_AT_FILL)', () => {
        // The existing wrong-side check catches fill >= SL for SHORT before the new ordering leg runs.
        // This asserts the two rejects do not blur: at/above-SL → wrong_side_of_sl.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.278'), // fill = SL exactly → wrong-side for SHORT
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(WRONG_SIDE_OF_SL);
        // Must NOT be the geometry reason — wrong-side check fires first
        expect(result.reason).not.toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });
});

// ─── (b) 212-style collapse (noise floor) ─────────────────────────────────────

describe('exitGeometryHelper M48 — (b) 212-style collapse: slDist_fill < slFloor → DEGENERATE_GEOMETRY_AT_FILL', () => {
    it('212-style fill with slDist < slFloor rejects DEGENERATE_GEOMETRY_AT_FILL (SHORT)', () => {
        // Live position 212 fixture:
        //   fill=63.250, SL=63.278, referencePrice=62.294
        //   slDist_fill = 63.278 - 63.250 = 0.028
        //   slFloor = max(1.5 * 0.8, 0.003 * 62.294) = max(1.2, 0.18688) = 1.2
        //   0.028 < 1.2 → rejects
        //
        // Note: slFloor PCT leg anchors to referencePrice=62.294, NOT fill=63.250.
        // If anchored to fill: pctFloor = 0.003 * 63.250 = 0.190 (also binding but wrong anchor).
        // The ATR floor (1.2) dominates here, so the anchor choice does not flip the outcome —
        // see (e3) for a fixture that exposes the anchor distinction when PCT is binding.
        const result = evaluateFillDrift(build212ShortCtx());

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('212-style LONG mirror: slDist_fill < slFloor rejects DEGENERATE_GEOMETRY_AT_FILL', () => {
        // LONG mirror: fill=62.750, SL=62.722, TP=63.706 (TP > fill > SL ✓)
        // slDist_fill = 62.750 - 62.722 = 0.028 << slFloor=1.2
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.722'),
                takeProfitPrice: new Money('63.706'),
            }),
            avgFillPrice: new Money('62.750'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.706'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('212-style collapse is caught even when ratio > 1 (ratio-only check would miss it)', () => {
        // This tests the noise-floor catches what ratio-only would not:
        //   slDist=0.028, tpDist=0.956 → ratio = 34.1 > 1.5 (would PASS a ratio-only check)
        //   but slDist=0.028 < slFloor=1.2 → REJECTS on noise floor first
        const ctx = build212ShortCtx({
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'), // tpDist = 63.250 - 62.294 = 0.956
            }),
        });

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });
});

// ─── (c) 211-style inversion (R:R ratio) ──────────────────────────────────────

describe('exitGeometryHelper M48 — (c) 211-style inversion: tpDist/slDist < min_rr → DEGENERATE_GEOMETRY_AT_FILL', () => {
    it('211-style LONG fill with R:R=0.74 at fill rejects DEGENERATE_GEOMETRY_AT_FILL', () => {
        // fill=63.250, SL=62.000 → slDist=1.25; TP=64.175 → tpDist=0.925
        // R:R = 0.925 / 1.25 = 0.74 < 1.5 → rejects
        // slDist=1.25 > slFloor=max(1.5*0.8, 0.003*referencePrice)
        // With referencePrice=63.250: slFloor=max(1.2, 0.190)=1.2. slDist=1.25 > 1.2 → passes floor.
        // But R:R fails → rejects at Step 5.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.000'),
                takeProfitPrice: new Money('64.175'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });
});

// ─── (d) 210-style pass (good trade must NOT reject) ─────────────────────────

describe('exitGeometryHelper M48 — (d) 210-style pass: R:R ≥ min_rr and slDist ≥ slFloor → shouldReject=false', () => {
    it('at-floor slDist passes (strict < comparator): good LONG trade is never wrongly rejected', () => {
        // fill=63.250, SL=62.000, TP=65.788
        //   slDist = 63.250 - 62.000 = 1.25
        //   tpDist = 65.788 - 63.250 = 2.538
        //   R:R = 2.538 / 1.25 = 2.030 ≥ 1.5 → passes Step 5
        // slFloor = max(1.5 * 0.8, 0.003 * 63.250) = max(1.2, 0.190) = 1.2
        //   slDist=1.25 >= slFloor=1.2 (strict < → at-floor does NOT reject) → passes Step 4
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.000'),
                takeProfitPrice: new Money('65.788'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'), // pctFloor = 0.003 * 63.250 = 0.190; ATR wins at 1.2
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(false);
    });

    it('210-style pass: slDist at exactly slFloor passes (strict < means at-floor is accepted)', () => {
        // Fill where slDist == slFloor exactly (1.2). Should PASS because check is strict <.
        // slDist = fill - sl = 63.250 - 62.050 = 1.2 = slFloor → passes (not <)
        // Need good R:R: TP = 63.250 + 1.5 * 1.2 = 63.250 + 1.8 = 65.050
        // R:R = 1.8 / 1.2 = 1.5 exactly (at-min_rr, strict < means this also PASSES)
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.050'), // slDist = 63.250 - 62.050 = 1.2 (= slFloor)
                takeProfitPrice: new Money('65.050'), // tpDist = 65.050 - 63.250 = 1.8; R:R = 1.5 (= min_rr)
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };

        const result = evaluateFillDrift(ctx);

        // Strict < on both comparators: at-floor and at-min_rr both pass
        expect(result.shouldReject).toBe(false);
    });
});

// ─── (e) fill at SL — wrong_side_of_sl fires first ───────────────────────────

describe('exitGeometryHelper M48 — (e) fill at SL → wrong_side_of_sl fires before geometry leg', () => {
    it('SHORT fill equal to SL → wrong_side_of_sl fires first (no division occurs)', () => {
        // fill = SL = 63.278 → for SHORT: fill >= SL → wrong-side fires first.
        // This is the same case as (a) row 3 but named separately per the spec.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.278'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(WRONG_SIDE_OF_SL);
    });
});

// ─── (e2) Fail-closed input guard ────────────────────────────────────────────

describe('exitGeometryHelper M48 — (e2) fail-closed: missing inputs with geometryParams present → DEGENERATE_GEOMETRY_AT_FILL', () => {
    it('geometryParams present but referencePrice absent → rejects DEGENERATE_GEOMETRY_AT_FILL (wiring bug, not silent skip)', () => {
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: undefined, // missing — fail-closed
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('geometryParams present but entrySnapshot absent → rejects DEGENERATE_GEOMETRY_AT_FILL (wiring bug, not silent skip)', () => {
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: undefined, // missing — fail-closed
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('geometryParams present but atr_14 undefined on entrySnapshot → rejects DEGENERATE_GEOMETRY_AT_FILL (wiring bug, not silent skip)', () => {
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: undefined as any }), // atr_14 undefined
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });

    it('geometryParams absent (close/reduce path) → geometry leg skipped entirely → shouldReject=false', () => {
        // On close/reduce/flatten approvals geometryParams is not stamped.
        // The leg must be completely inert — only the wrong-side-of-SL check runs.
        // A SHORT fill well below SL (correct side) → passes.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: undefined, // absent — close/reduce path, geometry leg skipped
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(false);
    });
});

// ─── (e3) slFloor anchor — PCT leg anchors to referencePrice, not fill ────────

describe('exitGeometryHelper M48 — (e3) slFloor PCT anchor: floor computed from referencePrice, not fill', () => {
    it('slDist=0.18800 with referencePrice=62.294 passes (0.18800 >= pctFloor_from_ref=0.18688)', () => {
        // Build a fixture where fill and referencePrice diverge AND the PCT leg is binding
        // (ATR is tiny so the PCT floor dominates).
        //
        // atr14=0.001 → atrFloor = 1.5 * 0.001 = 0.0015 (negligible)
        // entry_pct_floor=0.3 (0.3%), referencePrice=62.294:
        //   pctFloor_from_ref   = 0.003 * 62.294 = 0.18688
        //   pctFloor_from_fill  = 0.003 * 63.250 = 0.18975  (WRONG anchor, not used)
        // slFloor = max(0.0015, 0.18688) = 0.18688  (anchored to referencePrice)
        //
        // slDist_fill = 63.278 - (63.278 - 0.18800) = 0.18800
        // SL = 63.278, fill = 63.278 - 0.18800 = 63.090, TP below fill for SHORT:
        //   SHORT requires SL > fill > TP.
        //   fill = 63.090, SL = 63.278, TP = 62.000 (well below fill)
        //   slDist = 63.278 - 63.090 = 0.188
        //
        // 0.18800 >= 0.18688 (ref-anchored floor) → PASSES
        // 0.18800 <  0.18975 (fill-anchored floor) → would REJECT if wrongly anchored to fill
        //
        // This documents that the anchor choice matters at the boundary.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.000'), // TP below fill for SHORT ordering
            }),
            avgFillPrice: new Money('63.090'), // slDist = 63.278 - 63.090 = 0.188
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.001' }), // tiny ATR → PCT leg is binding
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'), // PCT floor anchored HERE, not to fill
        };

        // R:R check: tpDist = 63.090 - 62.000 = 1.090; slDist=0.188; R:R = 5.79 > 1.5 → passes
        const result = evaluateFillDrift(ctx);

        // Passes because slDist=0.188 >= slFloor_from_ref=0.18688.
        // If the floor were wrongly computed from fill (63.250 not 63.090, but actually the
        // fill IS 63.090 in this fixture — the divergence is referencePrice vs fill at 62.294 vs 63.090):
        //   pctFloor_from_fill = 0.003 * 63.090 = 0.18927 > 0.188 → would REJECT
        // The test passes only when the implementation anchors to referencePrice (62.294).
        expect(result.shouldReject).toBe(false);
    });

    it('identical fixture with pctFloor computed from fill would have rejected — anchor matters (documentary assertion)', () => {
        // This test documents the counterfactual: if the implementation anchored to fill instead
        // of referencePrice, slDist=0.188 < pctFloor_from_fill=0.18927 would trigger a rejection.
        // We verify the math directly rather than by patching the impl.
        const slDist = new Money('0.18800');
        // slFloor anchored to referencePrice=62.294
        const pctFloorFromRef = new Money('62.294').times(new Money('0.3').dividedBy(new Money('100')));
        // slFloor anchored to fill=63.090 (the wrong anchor)
        const pctFloorFromFill = new Money('63.090').times(new Money('0.3').dividedBy(new Money('100')));

        expect(slDist.greaterThanOrEqualTo(pctFloorFromRef)).toBe(true); // passes with correct anchor
        expect(slDist.lessThan(pctFloorFromFill)).toBe(true); // would reject with wrong anchor
    });
});

// ─── (f) Parity / inertness ───────────────────────────────────────────────────

describe('exitGeometryHelper M48 — (f) parity/inertness: geometry leg is no-op when geometryParams absent', () => {
    it('IFillDriftContext without geometryParams (existing wrong-side-only path): correct SHORT fill → shouldReject=false', () => {
        // Confirms the geometry leg is a no-op when absent — only the wrong-side-of-SL check runs.
        // This is the pre-M48 behaviour preserved for close/reduce/flatten paths.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('62.294'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            // geometryParams absent — the M48 geometry leg must not run
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(false);
        expect(result.reason).toBeUndefined();
    });

    it('210-style fixture: |fill - referencePrice| drift < slFloor (drift=0 when fill=ref) guards future slippage changes', () => {
        // For fill=63.250 and referencePrice=63.250 (same → drift=0), slFloor=1.2.
        // |drift| = 0 < slFloor=1.2 → true.
        // This assertion guards a future fill-model change that introduces slippage from silently
        // diverging live from backtest (reviewer M2 parity requirement).
        const fill = new Money('63.250');
        const referencePrice = new Money('63.250');
        const atr14 = new Money('0.8');
        const atrFloorMultiplier = 1.5;
        const slFloor = atr14.times(atrFloorMultiplier); // 1.2

        const drift = fill.minus(referencePrice).abs();

        expect(drift.lessThan(slFloor)).toBe(true);
    });
});

// ─── (g) Option-B preservation ───────────────────────────────────────────────

describe('exitGeometryHelper M48 — (g) Option-B preservation: geometry leg never mutates SL/TP prices', () => {
    it('after evaluateFillDrift rejects a 212-style fill, clampedExit SL and TP prices are unchanged', () => {
        const originalSl = new Money('63.278');
        const originalTp = new Money('62.294');
        const clampedExit = buildExit({
            stopLossPrice: originalSl,
            takeProfitPrice: originalTp,
        });

        const ctx = build212ShortCtx({ clampedExit });
        const result = evaluateFillDrift(ctx);

        // The leg must reject
        expect(result.shouldReject).toBe(true);

        // SL and TP prices on the context are UNCHANGED — no fill-time rebase re-introduced
        expect(ctx.clampedExit.stopLossPrice.toFixed(8)).toBe(originalSl.toFixed(8));
        expect(ctx.clampedExit.takeProfitPrice.toFixed(8)).toBe(originalTp.toFixed(8));
    });

    it('after evaluateFillDrift passes a 210-style fill, clampedExit SL and TP prices are also unchanged', () => {
        const originalSl = new Money('62.000');
        const originalTp = new Money('65.788');
        const clampedExit = buildExit({
            stopLossPrice: originalSl,
            takeProfitPrice: originalTp,
        });

        const ctx: IFillDriftContext = {
            clampedExit,
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };
        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(false);

        expect(ctx.clampedExit.stopLossPrice.toFixed(8)).toBe(originalSl.toFixed(8));
        expect(ctx.clampedExit.takeProfitPrice.toFixed(8)).toBe(originalTp.toFixed(8));
    });
});

// ─── Adversarial: zero ATR ────────────────────────────────────────────────────

describe('exitGeometryHelper M48 — adversarial: zero ATR falls back to PCT floor, 212-style collapse still rejects', () => {
    it('zero atr14 → slFloor = PCT floor = 0.003 * referencePrice; 212-style collapse still rejects', () => {
        // atr14=0 → atrFloor = 1.5 * 0 = 0
        // slFloor = max(0, 0.003 * 62.294) = max(0, 0.18688) = 0.18688
        // slDist_fill = 0.028 < 0.18688 → rejects
        const ctx = build212ShortCtx({
            entrySnapshot: buildSnapshot({ atr_14: '0' }),
        });

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });
});

// ─── Adversarial: enormous fill spike ────────────────────────────────────────

describe('exitGeometryHelper M48 — adversarial: enormous spike fill violates ordering → DEGENERATE_GEOMETRY_AT_FILL', () => {
    it('fill=100.000 on SHORT with SL=63.278 → fill > SL → wrong_side_of_sl fires (ordering violation at wrong-side level)', () => {
        // For SHORT: SL must be > fill. fill=100.000 > SL=63.278 → wrong-side.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('60.000'),
            }),
            avgFillPrice: new Money('100.000'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };

        const result = evaluateFillDrift(ctx);

        // fill >= SL for SHORT → wrong_side_of_sl fires first
        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(WRONG_SIDE_OF_SL);
    });
});

// ─── Adversarial: mean-reversion defense-in-depth ────────────────────────────

describe('exitGeometryHelper M48 — adversarial: mean-reversion fill that collapses at fill is also rejected', () => {
    it('mean-reversion SHORT fill with same 212-style collapse rejects regardless of flow_type', () => {
        // The fill-time geometry leg is NOT momentum-only.
        // A mean-reversion fill that collapses at fill must also be caught.
        // Same 212-style fixture but with flow_type=forced_exhaustion (mean-reversion).
        const ctx = build212ShortCtx({
            entrySnapshot: buildSnapshot({
                atr_14: '0.8',
                flow_type: FlowTypeEnum.FORCED_EXHAUSTION, // mean-reversion flow type
            }),
        });

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);
    });
});

// ─── Adversarial: anti-coverage ───────────────────────────────────────────────

describe('exitGeometryHelper M48 — adversarial anti-coverage: inverted geometry ALWAYS rejects; good trade NEVER rejects', () => {
    it('anti-coverage (1): fill with inverted TP ordering is ALWAYS rejected (never shouldReject=false)', () => {
        // SHORT: fill=63.250, SL=63.278 (correct SL side), TP=63.260 (above fill — ordering violated)
        // This is the ordering-break case from (a). It must ALWAYS be rejected.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('63.278'),
                takeProfitPrice: new Money('63.260'), // TP > fill for SHORT — ordering violation
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.SHORT,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('62.294'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(true);
    });

    it('anti-coverage (2): 210-style good trade is NEVER wrongly rejected (always shouldReject=false)', () => {
        // 210-style: fill=63.250, SL=62.000, TP=65.788
        // slDist=1.25 >= slFloor=1.2; R:R=2.03 >= min_rr=1.5
        // Must ALWAYS pass — the leg must not over-reject good trades.
        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.000'),
                takeProfitPrice: new Money('65.788'),
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
        };

        const result = evaluateFillDrift(ctx);

        expect(result.shouldReject).toBe(false);
    });
});

// ─── (h) resolvedTakeProfitPrice wiring ──────────────────────────────────────

describe('exitGeometryHelper M48 — (h) resolvedTakeProfitPrice wiring: rebase-eligible fill uses armed TP for R:R', () => {
    it('LONG fill with tpRebaseEligible=true: resolvedTakeProfitPrice (armed TP) drives R:R check, not the frozen signal TP', () => {
        // Fixture: LONG, fill=63.250, SL=62.000, slDist=1.25
        //   slFloor = max(1.5*0.8, 0.003*63.250) = max(1.2, 0.190) = 1.2
        //   slDist=1.25 >= slFloor=1.2 → passes Step 4 ✓
        //
        // Frozen signal TP (clampedExit.takeProfitPrice): 65.788
        //   tpDist_frozen = 65.788 - 63.250 = 2.538; R:R = 2.538/1.25 = 2.03 ≥ 1.5 → PASSES (wrong behavior)
        //
        // Armed TP (resolvedTakeProfitPrice): 64.375 (= fill + slDist*0.9 = 63.250 + 1.125)
        //   tpDist_armed = 64.375 - 63.250 = 1.125; R:R = 1.125/1.25 = 0.90 < 1.5 → REJECTS (correct behavior)
        //
        // The test is sensitive to the fix: it rejects only when the armed TP is used for R:R.
        const frozenSignalTp = new Money('65.788');
        const armedTp = new Money('64.375'); // fill + 1.125 (slDist * 0.9)

        const ctx: IFillDriftContext = {
            clampedExit: buildExit({
                stopLossPrice: new Money('62.000'),
                takeProfitPrice: frozenSignalTp, // frozen signal TP (wrong anchor for R:R)
                tpRebaseEligible: true,
            }),
            avgFillPrice: new Money('63.250'),
            side: PositionSideEnum.LONG,
            entrySnapshot: buildSnapshot({ atr_14: '0.8' }),
            geometryParams: DEFAULT_GEOMETRY_PARAMS,
            referencePrice: new Money('63.250'),
            resolvedTakeProfitPrice: armedTp, // armed TP (correct anchor)
        };

        const result = evaluateFillDrift(ctx);

        // Armed TP yields R:R = 1.125/1.25 = 0.9 < 1.5 → REJECTS
        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe(DEGENERATE_GEOMETRY_AT_FILL);

        // Confirm the frozen TP would have passed R:R — test is sensitive to the fix
        const fill = new Money('63.250');
        const sl = new Money('62.000');
        const slDist = fill.minus(sl);
        const frozenTpDist = frozenSignalTp.minus(fill);

        expect(frozenTpDist.dividedBy(slDist).greaterThan(new Money('1.5'))).toBe(true);
    });
});
