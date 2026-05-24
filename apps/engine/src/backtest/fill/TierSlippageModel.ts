import { CoinTierEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils';

// Tier-floor slippage model (ADR 0015 §6 — slippage floor). This is the MANDATORY adverse
// price adjustment applied to every simulated fill, independent of whether depth-aware
// slippage engages. It encodes the "you cannot fill better than the tier-typical effective
// spread" rule: tier-1 (top-50 liquidity) pays at least ~15 bps, tier-2 ~50 bps, tier-3
// ~100 bps. The actual values flow from strategy_versions.params so the same backtest can
// be re-run under stress assumptions (BACKTEST_STRESS_SLIPPAGE_MULTIPLIER) without changing
// code.
//
// Adverse direction:
//   - OPEN long  / CLOSE short → fill at refPrice * (1 + s)  (you buy higher than expected)
//   - OPEN short / CLOSE long  → fill at refPrice * (1 - s)  (you sell lower than expected)
//   - REDUCE behaves like CLOSE on its same side.
//
// Pure function: no clock, no random, no I/O.

// Tier defaults (M7 plan §slippage floors). Backtest uses these when params doesn't override.
export const DEFAULT_TIER1_SLIPPAGE_PCT = 0.15;
export const DEFAULT_TIER2_SLIPPAGE_PCT = 0.5;
export const DEFAULT_TIER3_SLIPPAGE_PCT = 1.0;

// Strategy-params shape consumed at backtest time. All values are PERCENT, not bps.
export interface ITierSlippageParams {
    readonly slippage_tier1_pct?: number;
    readonly slippage_tier2_pct?: number;
    readonly slippage_tier3_pct?: number;
}

export interface ITierSlippageResult {
    readonly fillPrice: MoneyValue;
    readonly slippagePct: number;
}

export function computeTierFillPrice(
    refPrice: MoneyValue,
    coinTier: CoinTierEnum,
    side: 'long' | 'short',
    intent: 'open' | 'reduce' | 'close',
    params: ITierSlippageParams,
): ITierSlippageResult {
    const slippagePct = resolveTierSlippagePct(coinTier, params);
    const fillPrice = applyAdverseSlippage(refPrice, slippagePct, side, intent);

    return { fillPrice, slippagePct };
}

function resolveTierSlippagePct(coinTier: CoinTierEnum, params: ITierSlippageParams): number {
    if (coinTier === CoinTierEnum.TIER_1) {
        return params.slippage_tier1_pct ?? DEFAULT_TIER1_SLIPPAGE_PCT;
    }

    if (coinTier === CoinTierEnum.TIER_2) {
        return params.slippage_tier2_pct ?? DEFAULT_TIER2_SLIPPAGE_PCT;
    }

    return params.slippage_tier3_pct ?? DEFAULT_TIER3_SLIPPAGE_PCT;
}

function applyAdverseSlippage(refPrice: MoneyValue, slippagePct: number, side: 'long' | 'short', intent: 'open' | 'reduce' | 'close'): MoneyValue {
    const slippageFraction = new Money(slippagePct).dividedBy(100);
    const isAdverseHigher = isAdverseDirectionHigher(side, intent);

    if (isAdverseHigher) {
        return refPrice.times(new Money(1).plus(slippageFraction));
    }

    return refPrice.times(new Money(1).minus(slippageFraction));
}

// Returns true when the adverse direction pushes the fill price UP (we pay more):
//   - long open / long add / short close / short reduce → buying side, adverse = higher
//   - short open / short add / long close / long reduce → selling side, adverse = lower
function isAdverseDirectionHigher(side: 'long' | 'short', intent: 'open' | 'reduce' | 'close'): boolean {
    const isEntry = intent === 'open';

    if (side === 'long') {
        return isEntry; // long buying on open, selling on reduce/close
    }

    return !isEntry; // short selling on open, buying on reduce/close
}
