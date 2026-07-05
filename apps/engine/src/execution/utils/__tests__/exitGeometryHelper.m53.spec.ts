/**
 * exitGeometryHelper — M53 D1 arm/guard decoupling, adversarial (docs/plans/M53-xmom-tp-arm-headroom.md
 * "Testing strategy" item 3).
 *
 * The guard (`isRrInsufficient` inside `evaluateFillGeometry`) is UNCHANGED by M53 — these tests
 * pin the slippage offset `s` (fraction of stop distance D) rather than asserting a bare R:R
 * number, per the plan's explicit instruction: "a test written as 'a fill at R:R 1.6' is unanchored
 * and can't be asserted... fix `s` and derive both outcomes."
 *
 * Fixture geometry shared by every case here:
 *   entryPrice E = 50000, atr14 = 1000, xmom_atr_stop_multiplier = 2 → stopDistance D = 2000
 *   stopLossPrice SL = E - D = 48000 (frozen, unaffected by the arm)
 *   takeProfitPrice TP = E + arm·D (frozen at signal, M53 D1 arm site)
 *   fill F = E + s·D (a long filled above signal price by fraction s of D)
 *   realized R:R at fill = (arm - s) / (1 + s)  — the exact formula the plan pins.
 *
 * Case map:
 *   G1 — arm=1.5, s=0.10 → R:R 1.2727... < 1.5 → REJECTED (force_closed) — arm sits exactly on the
 *        historical floor, so ordinary slippage tips it under (the M53 problem statement, unfixed here).
 *   G2 — arm=1.8, s=0.10 → R:R 1.5454... >= 1.5 → ACCEPTED — headroom clears the SAME fill.
 *   G3 — arm=1.8, s=0.90 (chase fill) → R:R 0.4736... < 1.5 → REJECTED — headroom does not admit a
 *        degenerate fill; the guard still bites when slippage itself is large.
 *   G4 — guard floor independence: geometryParams.min_rr is read from xmom_min_rr (1.5) in every case
 *        above regardless of the arm value fed into takeProfitPrice — the two seams never merge.
 */

import { PositionSideEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { IProposedExit } from '../../../strategy/interface';
import { evaluateFillDrift } from '../exitGeometryHelper';

const ENTRY_PRICE = new Money('50000');
const ATR_14 = '1000';
const STOP_DISTANCE = new Money('2000'); // atr14 × xmom_atr_stop_multiplier(2)
const STOP_LOSS_PRICE = ENTRY_PRICE.minus(STOP_DISTANCE); // 48000
const MIN_RR = 1.5; // xmom_min_rr — the unchanged guard floor
const GEOMETRY_PARAMS = { min_rr: MIN_RR, atr_floor_multiplier: 1, entry_pct_floor: 0.3 };

function buildFrozenExit(armRr: number): IProposedExit {
    return {
        takeProfitPrice: ENTRY_PRICE.plus(STOP_DISTANCE.times(armRr)),
        stopLossPrice: STOP_LOSS_PRICE,
        stopType: 'atr' as any,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: false, // momentum TP is frozen at signal — never rebased (M53 scope boundary)
        atrDistance: STOP_DISTANCE,
    };
}

function fillAtSlippageOffset(s: number): MoneyValue {
    return ENTRY_PRICE.plus(STOP_DISTANCE.times(s));
}

function evaluateAtArmAndSlippage(armRr: number, s: number) {
    return evaluateFillDrift({
        clampedExit: buildFrozenExit(armRr),
        avgFillPrice: fillAtSlippageOffset(s),
        side: PositionSideEnum.LONG,
        geometryParams: GEOMETRY_PARAMS,
        referencePrice: ENTRY_PRICE,
        entrySnapshot: { atr_14: ATR_14 } as any,
    });
}

describe('exitGeometryHelper — M53 G1: arm=1.5, s=0.10 → realized R:R 1.2727 < 1.5 → force_closed', () => {
    it('rejects the fill with degenerate_geometry_at_fill at the pinned slippage offset', () => {
        const result = evaluateAtArmAndSlippage(1.5, 0.1);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('degenerate_geometry_at_fill');
    });

    it('the realized R:R at this fill is exactly (1.5-0.10)/1.10 (arithmetic sanity, not the guard)', () => {
        const fill = fillAtSlippageOffset(0.1);
        const slDist = fill.minus(STOP_LOSS_PRICE);
        const tpDist = buildFrozenExit(1.5).takeProfitPrice.minus(fill) as MoneyValue;
        const ratio = tpDist.dividedBy(slDist).toNumber();

        expect(ratio).toBeCloseTo((1.5 - 0.1) / 1.1, 6);
        expect(ratio).toBeLessThan(MIN_RR);
    });
});

describe('exitGeometryHelper — M53 G2: arm=1.8, s=0.10 → realized R:R 1.5454 >= 1.5 → fills (headroom clears it)', () => {
    it('accepts the SAME slippage offset once the arm is widened to 1.8', () => {
        const result = evaluateAtArmAndSlippage(1.8, 0.1);

        expect(result.shouldReject).toBe(false);
    });

    it('the realized R:R at this fill is exactly (1.8-0.10)/1.10 and clears the unchanged floor', () => {
        const fill = fillAtSlippageOffset(0.1);
        const slDist = fill.minus(STOP_LOSS_PRICE);
        const tpDist = buildFrozenExit(1.8).takeProfitPrice.minus(fill) as MoneyValue;
        const ratio = tpDist.dividedBy(slDist).toNumber();

        expect(ratio).toBeCloseTo((1.8 - 0.1) / 1.1, 6);
        expect(ratio).toBeGreaterThanOrEqual(MIN_RR);
    });
});

describe('exitGeometryHelper — M53 G3: arm=1.8, s=0.90 (chase fill) → realized R:R 0.4736 < 1.5 → still rejected', () => {
    it('headroom does not admit a degenerate fill at large slippage', () => {
        const result = evaluateAtArmAndSlippage(1.8, 0.9);

        expect(result.shouldReject).toBe(true);
        expect(result.reason).toBe('degenerate_geometry_at_fill');
    });

    it('the realized R:R at this chase fill is exactly (1.8-0.90)/1.90', () => {
        const fill = fillAtSlippageOffset(0.9);
        const slDist = fill.minus(STOP_LOSS_PRICE);
        const tpDist = buildFrozenExit(1.8).takeProfitPrice.minus(fill) as MoneyValue;
        const ratio = tpDist.dividedBy(slDist).toNumber();

        expect(ratio).toBeCloseTo((1.8 - 0.9) / 1.9, 6);
        expect(ratio).toBeLessThan(MIN_RR);
    });
});

describe('exitGeometryHelper — M53 G4: the guard floor never reads the arm — xmom_min_rr stays independent', () => {
    it('rejects arm=1.5,s=0.10 and accepts arm=1.8,s=0.10 against the IDENTICAL geometryParams.min_rr=1.5', () => {
        const rejected = evaluateAtArmAndSlippage(1.5, 0.1);
        const accepted = evaluateAtArmAndSlippage(1.8, 0.1);

        expect(GEOMETRY_PARAMS.min_rr).toBe(MIN_RR);
        expect(rejected.shouldReject).toBe(true);
        expect(accepted.shouldReject).toBe(false);
    });
});
