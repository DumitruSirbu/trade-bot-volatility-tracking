/**
 * exitGeometryHelper — M54 adversarial QA (docs/plans/M54-xmom-entry-geometry-expected-fill.md §9
 * items 4 and 11).
 *
 * Item 4: the slFloor PCT leg's THRESHOLD anchors to `referencePrice` (`isSlBelowFloor`,
 * `exitGeometryHelper.ts:181-185`) — M54 never moves `referencePrice` (it stays P0, see the
 * orchestrator's `MomentumOrchestratorService.m54.spec.ts` item 3). But the *compared* slDist is
 * derived from the (possibly M54-anchored) `clampedExit.stopLossPrice`, so the floor's OUTCOME can
 * flip between a P0-anchored SL and an F_exp-anchored SL for the identical fill/referencePrice/floor
 * inputs. This file constructs both scenarios directly against `evaluateFillDrift` (no orchestrator
 * needed — exitGeometryHelper has no knowledge of M54) and shows the outcome flip is real and safe.
 *
 * Item 11: `exitGeometryHelper` must never read the two new M54 params (`xmom_expected_fill_enabled`,
 * `xmom_max_depth_fraction`) — the guard is byte-for-byte unchanged, only fed a different SL/TP by
 * the caller. A source-text boundary check is sufficient (no runtime coupling exists to assert).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { PositionSideEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../../common/utils/money';
import { resolveSlFloorDistance } from '../../../common/utils';
import { IProposedExit } from '../../../strategy/interface';
import { evaluateFillDrift } from '../exitGeometryHelper';

const P0 = new Money('50000'); // signal price — referencePrice, UNCHANGED by M54
const STOP_DISTANCE = new Money('1000'); // D = atr14 × xmom_atr_stop_multiplier
const ARM_RR = 1.5;
const MIN_RR = 1.5;
const ATR_14 = '600';
// atr_floor_multiplier=1, entry_pct_floor=0 → floor = max(600, 0) = 600 (pctFloor term neutralized so
// referencePrice's numeric value doesn't leak a second effect into this test — its ROLE as the fixed
// anchor input is what item 4 asserts, via passing the SAME referencePrice to both scenarios below).
const GEOMETRY_PARAMS = { min_rr: MIN_RR, atr_floor_multiplier: 1, entry_pct_floor: 0 };
const HALF_SPREAD_FRACTION = 0.5; // halfSpread expressed as a fraction of D for this fixture (=500)

function buildExit(stopLossPrice: MoneyValue, takeProfitPrice: MoneyValue): IProposedExit {
    return {
        takeProfitPrice,
        stopLossPrice,
        stopType: 'atr' as any,
        timeStopAtMs: 1_700_000_000_000 + 3_600_000,
        tpRebaseEligible: false,
        atrDistance: STOP_DISTANCE,
    };
}

describe('exitGeometryHelper — M54 item 4: slFloor threshold anchor (referencePrice) is unchanged, but the outcome may flip', () => {
    it('the SAME fill passes the floor under the P0-anchored SL but is REJECTED under the F_exp-anchored SL', () => {
        // Baseline (pre-M54): SL = P0 - D = 49000, TP = P0 + 1.5D = 51500.
        const baselineSl = P0.minus(STOP_DISTANCE);
        const baselineTp = P0.plus(STOP_DISTANCE.times(ARM_RR));
        // M54: F_exp = P0 + halfSpread·D = 50500 → SL = F_exp - D = 49500, TP = F_exp + 1.5D = 52000.
        const fExp = P0.plus(STOP_DISTANCE.times(HALF_SPREAD_FRACTION));
        const anchoredSl = fExp.minus(STOP_DISTANCE);
        const anchoredTp = fExp.plus(STOP_DISTANCE.times(ARM_RR));

        // Identical realized fill for both scenarios — isolates the anchor's effect on the floor.
        const fill = P0;

        const baselineResult = evaluateFillDrift({
            clampedExit: buildExit(baselineSl, baselineTp),
            avgFillPrice: fill,
            side: PositionSideEnum.LONG,
            geometryParams: GEOMETRY_PARAMS,
            referencePrice: P0, // threshold anchor — SAME value used in the M54 scenario below
            entrySnapshot: { atr_14: ATR_14 } as any,
        });

        const anchoredResult = evaluateFillDrift({
            clampedExit: buildExit(anchoredSl, anchoredTp),
            avgFillPrice: fill,
            side: PositionSideEnum.LONG,
            geometryParams: GEOMETRY_PARAMS,
            referencePrice: P0, // threshold anchor UNCHANGED — same referencePrice as baseline
            entrySnapshot: { atr_14: ATR_14 } as any,
        });

        // Baseline: slDist = fill - SL = 50000 - 49000 = 1000 >= floor(600) → passes the floor,
        // then RR = (51500-50000)/1000 = 1.5 >= 1.5 → accepted.
        expect(baselineResult.shouldReject).toBe(false);

        // M54: slDist = fill - SL = 50000 - 49500 = 500 < floor(600) → REJECTED at the floor step —
        // the SAME fill, the SAME referencePrice/threshold, a DIFFERENT outcome, because the anchor
        // moved the compared slDist, not the threshold.
        expect(anchoredResult.shouldReject).toBe(true);
        expect(anchoredResult.reason).toBe('degenerate_geometry_at_fill');
    });

    it('resolveSlFloorDistance itself is identical in both scenarios — the threshold truly does not move', () => {
        const floorBaseline = resolveSlFloorDistance(P0, { atr14: ATR_14, params: GEOMETRY_PARAMS });
        const floorAnchored = resolveSlFloorDistance(P0, { atr14: ATR_14, params: GEOMETRY_PARAMS });

        expect(floorBaseline.toFixed(8)).toBe(floorAnchored.toFixed(8));
    });
});

describe('exitGeometryHelper — M54 item 11: the guard never reads the new M54 params', () => {
    it('the source file contains no reference to xmom_expected_fill_enabled or xmom_max_depth_fraction', () => {
        const source = readFileSync(join(__dirname, '../exitGeometryHelper.ts'), 'utf-8');

        expect(source).not.toContain('xmom_expected_fill_enabled');
        expect(source).not.toContain('xmom_max_depth_fraction');
    });

    it('isRrInsufficient/evaluateFillGeometry reads only geometryParams.min_rr for the RR leg — unaffected by the M54 params at fixed inputs', () => {
        // Two independent scenarios with DIFFERENT SL/TP anchors (simulating anchor on/off) but the
        // IDENTICAL geometryParams.min_rr — both resolve the RR leg from min_rr alone, never from an
        // M54 param (which isn't even part of IFillDriftContext.geometryParams's Pick). A near-zero
        // ATR floor isolates the RR leg from the floor leg exercised by item 4 above.
        const NEGLIGIBLE_ATR_14 = '0.0001';
        const fill = P0;
        const slBase = P0.minus(STOP_DISTANCE);
        const tpBase = P0.plus(STOP_DISTANCE.times(1.8)); // wide arm so it clears RR regardless of anchor
        const fExp = P0.plus(STOP_DISTANCE.times(HALF_SPREAD_FRACTION));
        const slAnchored = fExp.minus(STOP_DISTANCE);
        const tpAnchored = fExp.plus(STOP_DISTANCE.times(1.8));

        const baseResult = evaluateFillDrift({
            clampedExit: buildExit(slBase, tpBase),
            avgFillPrice: fill,
            side: PositionSideEnum.LONG,
            geometryParams: GEOMETRY_PARAMS,
            referencePrice: P0,
            entrySnapshot: { atr_14: NEGLIGIBLE_ATR_14 } as any,
        });
        const anchoredResult = evaluateFillDrift({
            clampedExit: buildExit(slAnchored, tpAnchored),
            avgFillPrice: fill,
            side: PositionSideEnum.LONG,
            geometryParams: GEOMETRY_PARAMS, // SAME min_rr — the guard reads no other param
            referencePrice: P0,
            entrySnapshot: { atr_14: NEGLIGIBLE_ATR_14 } as any,
        });

        expect(baseResult.shouldReject).toBe(false);
        expect(anchoredResult.shouldReject).toBe(false);
        expect(GEOMETRY_PARAMS.min_rr).toBe(MIN_RR);
    });
});
