import { PositionSideEnum } from '@bot/shared';

import { MS_PER_SECOND } from '../../common/const';
import { Money, MoneyValue } from '../../common/utils/money';

// ADR 0013 §1 — pure metric updaters for the PositionInstrumentor accumulator.
// Each function takes the prior accumulator value + the latest sample and
// returns the new accumulator value. No I/O, no clock reads, no events: the
// instrumentor service composes these and owns the in-memory map + flush.
//
// Notation (ADR 0013 §1 intro):
//   excursion (signed pct from position's perspective):
//     LONG:  (markPrice - entry) / entry
//     SHORT: (entry - markPrice) / entry
//   Positive = favorable to the position; negative = adverse.
//
// All math is decimal.js via MoneyValue / Money. Percentages are stored as
// fractional decimals (e.g. `0.025` = 2.5%), matching the NUMERIC(18, 8)
// column scale on `positions.mae_pct` etc. (M2 schema). Reviewer rule from
// §6: no `Math.max` / `Math.min` on prices; decimal comparators only.

// Pure excursion computation. Caller passes the live mark price + immutable
// entry price + side. Returns a signed MoneyValue. Throws no errors —
// `entry.isZero()` is the only edge and returns zero excursion (no division;
// upstream prevents zero entry, but defensive zero-return keeps the helper
// total).
export function computeExcursionPct(side: PositionSideEnum, entryPrice: MoneyValue, markPrice: MoneyValue): MoneyValue {
    if (entryPrice.isZero()) {
        return new Money(0);
    }

    const numerator = side === PositionSideEnum.LONG ? markPrice.minus(entryPrice) : entryPrice.minus(markPrice);

    return numerator.dividedBy(entryPrice);
}

// ADR 0013 §1a — Max Adverse Excursion update. Decimal `min`: the new MAE is
// the smaller (more negative) of the prior MAE and the current excursion.
// Initial prior MAE is 0 (entry tick; no drawdown yet). Reviewer rule §1a:
// `mae_pct` is non-positive at all times; this function preserves that by
// only `min`-ing against current excursion when it is itself non-positive
// (a favorable excursion does not affect MAE).
export function updateMaePct(priorMae: MoneyValue | null, excursionPct: MoneyValue): MoneyValue {
    const floor = priorMae ?? new Money(0);

    if (excursionPct.greaterThanOrEqualTo(0)) {
        return floor; // favorable tick: MAE unchanged
    }

    return excursionPct.lessThan(floor) ? excursionPct : floor;
}

// ADR 0013 §1b — Max Favorable Excursion update. Decimal `max`: the new MFE
// is the larger (more positive) of the prior MFE and the current excursion.
// Initial prior MFE is 0. Reviewer rule §1b: `mfe_pct >= 0` at all times;
// the function only `max`-es when the excursion is itself non-negative.
export function updateMfePct(priorMfe: MoneyValue | null, excursionPct: MoneyValue): MoneyValue {
    const ceiling = priorMfe ?? new Money(0);

    if (excursionPct.lessThanOrEqualTo(0)) {
        return ceiling; // adverse tick: MFE unchanged
    }

    return excursionPct.greaterThan(ceiling) ? excursionPct : ceiling;
}

// ADR 0013 §1c — first-time-only time-to-reversion. Returns the elapsed
// seconds from `openedAtMs` to `nowMs` IFF the reversion condition is true
// AND `priorSecs` is null (never seen). Otherwise returns `priorSecs`
// unchanged (the metric is first-cross-only — never re-updated).
//
// Reversion condition is direction-symmetric per §1c "Locked":
//   LONG entry  → reversion when markPrice.gte(vwapAtEntry)
//   SHORT entry → reversion when markPrice.lte(vwapAtEntry)
//
// Caller passes the strategy's entry-time VWAP (`positions.vwap_at_entry`,
// immutable). If `vwapAtEntry` is null (instrument lacked VWAP at open), no
// reversion is ever recorded — function returns `priorSecs` unchanged.
export function updateTimeToReversionSecs(
    priorSecs: number | null,
    side: PositionSideEnum,
    vwapAtEntry: MoneyValue | null,
    markPrice: MoneyValue,
    openedAtMs: number,
    nowMs: number,
): number | null {
    if (priorSecs !== null) {
        return priorSecs;
    }

    if (vwapAtEntry === null) {
        return null;
    }

    const reverted = side === PositionSideEnum.LONG ? markPrice.greaterThanOrEqualTo(vwapAtEntry) : markPrice.lessThanOrEqualTo(vwapAtEntry);

    if (!reverted) {
        return null;
    }

    return Math.max(0, Math.floor((nowMs - openedAtMs) / MS_PER_SECOND));
}

// ADR 0013 §1d — stop-gap percentage on stop-loss exit. Side-aware: positive
// when the fill was worse than the SL level (extra slippage past the stop).
//
//   LONG  SL hit:  fillPrice < stopLossPrice ⇒ gap = (stopLossPrice - fillPrice) / stopLossPrice  (positive when worse)
//   SHORT SL hit:  fillPrice > stopLossPrice ⇒ gap = (fillPrice - stopLossPrice) / stopLossPrice  (positive when worse)
//
// Returns null if SL price is null/zero (defensive — should not happen on a
// real STOP_LOSS exit but the M2 column is nullable). Caller writes only when
// exit_reason === STOP_LOSS per §1d reviewer rule; this helper performs the
// math, not the gating.
export function computeStopGapPct(side: PositionSideEnum, stopLossPrice: MoneyValue | null, fillPrice: MoneyValue): MoneyValue | null {
    if (stopLossPrice === null || stopLossPrice.isZero()) {
        return null;
    }

    const slippage = side === PositionSideEnum.LONG ? stopLossPrice.minus(fillPrice) : fillPrice.minus(stopLossPrice);

    return slippage.dividedBy(stopLossPrice);
}

// ADR 0013 §1f — max divergence between mark and last. Always non-negative.
// `markPrice.isZero()` → returns the prior value (defensive; would divide
// by zero).
//
// NOTE: the shared `IPriceUpdateEvent` (M1) currently carries only a single
// `price` field, NOT a mark/last split (ADR 0008's mark-price reference vs.
// last-price). The instrumentor wires this helper but persists null until
// `bot-shared-maintainer` lands the split on the shared event. Surfaced as a
// W6 contract gap; see service-level doc.
export function updateMarkVsLastMaxDivergencePct(priorDivergence: MoneyValue | null, markPrice: MoneyValue, lastPrice: MoneyValue): MoneyValue {
    const ceiling = priorDivergence ?? new Money(0);

    if (markPrice.isZero()) {
        return ceiling;
    }

    const divergence = markPrice.minus(lastPrice).abs().dividedBy(markPrice);

    return divergence.greaterThan(ceiling) ? divergence : ceiling;
}

// ADR 0013 §1g — closest the position got to liquidation. Decimal `min` of
// signed distances (signed positive when mark is on the safe side of
// liquidation; negative is theoretically impossible without close).
//
//   LONG  distance: (markPrice - liquidationPrice) / markPrice  (positive while mark > liq)
//   SHORT distance: (liquidationPrice - markPrice) / markPrice  (positive while liq > mark)
//
// Returns the prior value unchanged when `liquidationPrice` is null
// (Binance has not surfaced one yet — typical for the first tick post-open;
// the value lands on the next reconciliation refresh). `markPrice.isZero()`
// returns prior (defensive).
export function updateMinLiquidationDistancePct(
    priorMinDistance: MoneyValue | null,
    side: PositionSideEnum,
    liquidationPrice: MoneyValue | null,
    markPrice: MoneyValue,
): MoneyValue | null {
    if (liquidationPrice === null || markPrice.isZero()) {
        return priorMinDistance;
    }

    const numerator = side === PositionSideEnum.LONG ? markPrice.minus(liquidationPrice) : liquidationPrice.minus(markPrice);
    const distance = numerator.dividedBy(markPrice);

    if (priorMinDistance === null) {
        return distance;
    }

    return distance.lessThan(priorMinDistance) ? distance : priorMinDistance;
}
