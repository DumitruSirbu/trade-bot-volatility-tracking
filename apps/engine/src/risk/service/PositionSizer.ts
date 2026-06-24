import { PositionSideEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { Money, MoneyValue } from '../../common/utils/money';
import { FUNDING_ANNUALIZED_SUPPRESS_PCT, FUNDING_SIZE_CUT_FACTOR, MAX_LEVERAGE, RISK_PER_TRADE_PCT } from '../const';
import { IInstrumentConstraints, IIntentSizing } from '../interface';

const MAX_LEVERAGE_DEC = new Money(MAX_LEVERAGE);
const FUNDING_CUT = new Money(FUNDING_SIZE_CUT_FACTOR);

export interface ISizingInput {
    readonly allocatedCapital: MoneyValue;
    readonly atr14: MoneyValue;
    readonly atrStopMultiplier: number;
    readonly entryPrice: MoneyValue;
    readonly stopLossPrice: MoneyValue;
    readonly tradeSide: PositionSideEnum;
    readonly fundingRate: number; // periodic rate (ratio)
    readonly fundingRateAnnualized: number; // pct
    readonly fundingRateSuppressThreshold: number; // params.funding_rate_suppress_threshold (abs periodic rate)
    readonly maxExposurePerCoinUsdt: MoneyValue; // operator per-coin hard ceiling (ADR 0004 §8)
    readonly instrument: IInstrumentConstraints;
}

export type SizingResult =
    | { readonly kind: 'sized'; readonly sizing: IIntentSizing }
    | { readonly kind: 'below_min_notional' }
    | { readonly kind: 'invalid_inputs' }
    | { readonly kind: 'funding_suppressed' };

// Pure decimal sizing (ADR 0004 §8). All arithmetic in decimal.js — never float. Computes an
// ATR-based notional, applies the funding adjustment, clamps to <= MAX_LEVERAGE AND to the
// operator per-coin hard ceiling (maxExposurePerCoinUsdt — the sizer shrinks the 1%-risk target
// to fit it, never grows it), step-rounds the qty DOWN, and enforces the instrument min-notional.
// effectiveRiskUsdt is the post-ceiling-clamp, pre-step-rounding realized dollar risk: it equals
// riskPerTradeUsdt when no ceiling binds and drops below it when the cap shrinks the order. It is
// a slight overestimate of the true fill risk (step-rounding further reduces qty), but is
// conservative (never understates risk). No I/O, no clock — every input is passed in so a
// backtest reproduces live sizing byte-for-byte.
@Injectable()
export class PositionSizer {
    size(input: ISizingInput): SizingResult {
        if (!this.areInputsValid(input)) {
            return { kind: 'invalid_inputs' };
        }

        if (this.isFundingSuppressed(input.fundingRateAnnualized)) {
            return { kind: 'funding_suppressed' };
        }

        const riskPerTradeUsdt = input.allocatedCapital.times(RISK_PER_TRADE_PCT);
        const stopDistance = input.entryPrice.minus(input.stopLossPrice).abs();

        const baseNotional = riskPerTradeUsdt.dividedBy(stopDistance).times(input.entryPrice);
        const fundedNotional = this.applyFundingCut(baseNotional, input);
        const clampedNotional = this.clampToCeilings(fundedNotional, input.allocatedCapital, input.maxExposurePerCoinUsdt);

        const rawQty = clampedNotional.dividedBy(input.entryPrice);
        const qty = this.roundDownToStep(rawQty, input.instrument.stepSize);
        const notional = qty.times(input.entryPrice);

        if (notional.lessThan(input.instrument.minNotional)) {
            return { kind: 'below_min_notional' };
        }

        const leverage = notional.dividedBy(input.allocatedCapital);
        const effectiveRiskUsdt = clampedNotional.dividedBy(input.entryPrice).times(stopDistance);

        return {
            kind: 'sized',
            sizing: {
                qty,
                notional,
                leverage,
                riskPerTradeUsdt,
                effectiveRiskUsdt,
            },
        };
    }

    // Fail-closed input validation (ADR 0004 §8 safety): a NaN/Infinity funding/atr or a
    // non-positive entry/atr/capital must NOT silently produce a sized order. JS comparisons
    // against NaN are all false, so an unguarded NaN would slip past every downstream check.
    private areInputsValid(input: ISizingInput): boolean {
        const finiteScalars = [input.atrStopMultiplier, input.fundingRate, input.fundingRateAnnualized, input.fundingRateSuppressThreshold].every((value) =>
            Number.isFinite(value),
        );
        const positiveDecimals = input.entryPrice.isFinite() && input.entryPrice.isPositive() && input.atr14.isFinite() && input.atr14.isPositive();
        const validCapital = input.allocatedCapital.isFinite() && input.allocatedCapital.isPositive();

        return finiteScalars && positiveDecimals && validCapital && input.atrStopMultiplier > 0 && this.isStopDistanceValid(input);
    }

    // Zero-denominator guard for the stop-distance divisor (M45 D1). The stop distance is
    // |entryPrice - stopLossPrice|; sizing divides riskPerTradeUsdt by it. decimal.js does NOT
    // throw on division by zero — x/0 yields Infinity and 0/0 yields NaN, both of which would
    // slip past the downstream min-notional comparison. So the guard MUST be an explicit
    // pre-division check: reject a non-finite stopLossPrice, and reject a stop distance that is
    // non-finite or smaller than one tick (the degenerate stop≈entry case). The minimum observed
    // live stop distance is ~8.6 bps of entry — orders of magnitude above one tick — so a tick
    // floor rejects only genuinely degenerate inputs, never a legitimate trade.
    private isStopDistanceValid(input: ISizingInput): boolean {
        if (!input.stopLossPrice.isFinite()) {
            return false;
        }

        const stopDistance = input.entryPrice.minus(input.stopLossPrice).abs();

        return stopDistance.isFinite() && stopDistance.greaterThanOrEqualTo(input.instrument.tickSize);
    }

    private isFundingSuppressed(fundingRateAnnualized: number): boolean {
        return Math.abs(fundingRateAnnualized) > FUNDING_ANNUALIZED_SUPPRESS_PCT;
    }

    // Halve notional ONLY when funding is UNFAVOURABLE (positive funding + long, negative +
    // short) AND abs(funding_rate) is at/over the suppress threshold (ADR 0004 §8 / brief
    // line 28). Normal small funding in the unfavourable direction does NOT cut size.
    private applyFundingCut(notional: MoneyValue, input: ISizingInput): MoneyValue {
        if (this.isFundingCutWarranted(input)) {
            return notional.times(FUNDING_CUT);
        }

        return notional;
    }

    private isFundingCutWarranted(input: ISizingInput): boolean {
        const overThreshold = Math.abs(input.fundingRate) >= input.fundingRateSuppressThreshold;

        return overThreshold && this.isFundingUnfavourable(input.fundingRate, input.tradeSide);
    }

    private isFundingUnfavourable(fundingRate: number, side: PositionSideEnum): boolean {
        if (side === PositionSideEnum.LONG) {
            return fundingRate > 0;
        }

        return fundingRate < 0;
    }

    // Shrink-never-grow ceilings (ADR 0004 §8). Two hard caps bind the proposed notional:
    //   1. MAX_LEVERAGE — implied leverage is notional / allocatedCapital, so clamp to
    //      allocatedCapital * MAX_LEVERAGE (margin == allocatedCapital at the limit).
    //   2. maxExposurePerCoinUsdt — the operator per-coin hard ceiling; the sizer shrinks the
    //      1%-risk target to fit it so the order never reaches the gate above the cap.
    // Result is min(notional, leverage cap, per-coin cap) — only ever reduces the notional.
    private clampToCeilings(notional: MoneyValue, allocatedCapital: MoneyValue, maxExposurePerCoinUsdt: MoneyValue): MoneyValue {
        const leverageCap = allocatedCapital.times(MAX_LEVERAGE_DEC);
        const ceiling = Money.min(leverageCap, maxExposurePerCoinUsdt);

        if (notional.greaterThan(ceiling)) {
            return ceiling;
        }

        return notional;
    }

    // Round qty DOWN to a multiple of stepSize — truncating never overshoots the risk budget.
    private roundDownToStep(qty: MoneyValue, stepSize: MoneyValue): MoneyValue {
        if (stepSize.lessThanOrEqualTo(0)) {
            return qty;
        }

        const steps = qty.dividedBy(stepSize).floor();

        return steps.times(stepSize);
    }
}
