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
    readonly tradeSide: PositionSideEnum;
    readonly fundingRate: number; // periodic rate (ratio)
    readonly fundingRateAnnualized: number; // pct
    readonly fundingRateSuppressThreshold: number; // params.funding_rate_suppress_threshold (abs periodic rate)
    readonly instrument: IInstrumentConstraints;
}

export type SizingResult =
    | { readonly kind: 'sized'; readonly sizing: IIntentSizing }
    | { readonly kind: 'below_min_notional' }
    | { readonly kind: 'invalid_inputs' }
    | { readonly kind: 'funding_suppressed' };

// Pure decimal sizing (ADR 0004 §8). All arithmetic in decimal.js — never float. Computes an
// ATR-based notional, applies the funding adjustment, clamps to <= MAX_LEVERAGE, step-rounds
// the qty DOWN, and enforces the instrument min-notional. No I/O, no clock — every input is
// passed in so a backtest reproduces live sizing byte-for-byte.
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
        const stopDistance = input.atr14.times(input.atrStopMultiplier);

        const baseNotional = riskPerTradeUsdt.dividedBy(stopDistance).times(input.entryPrice);
        const fundedNotional = this.applyFundingCut(baseNotional, input);
        const leverageClampedNotional = this.clampToMaxLeverage(fundedNotional, input.allocatedCapital);

        const rawQty = leverageClampedNotional.dividedBy(input.entryPrice);
        const qty = this.roundDownToStep(rawQty, input.instrument.stepSize);
        const notional = qty.times(input.entryPrice);

        if (notional.lessThan(input.instrument.minNotional)) {
            return { kind: 'below_min_notional' };
        }

        const leverage = notional.dividedBy(input.allocatedCapital);

        return {
            kind: 'sized',
            sizing: {
                qty,
                notional,
                leverage,
                riskPerTradeUsdt,
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

        return finiteScalars && positiveDecimals && validCapital && input.atrStopMultiplier > 0;
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

    // required margin = notional / leverage; if implied leverage > MAX, shrink notional so
    // leverage == MAX (margin == allocatedCapital * ... ). Implied leverage here is
    // notional / allocatedCapital, so clamp notional to allocatedCapital * MAX_LEVERAGE.
    private clampToMaxLeverage(notional: MoneyValue, allocatedCapital: MoneyValue): MoneyValue {
        const maxNotional = allocatedCapital.times(MAX_LEVERAGE_DEC);

        if (notional.greaterThan(maxNotional)) {
            return maxNotional;
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
