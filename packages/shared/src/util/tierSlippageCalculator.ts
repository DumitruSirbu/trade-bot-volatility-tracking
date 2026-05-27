import { Decimal } from 'decimal.js';

import { CoinTierEnum } from '../enum/CoinTierEnum.js';
import { parseDecimal, formatDecimal, multiplyDecimal, divideDecimal, isGreaterThan } from './decimalMath.js';

// Type alias for Decimal instances per decimal.js d.ts pattern (avoids TS2709 namespace-collision).
type DecimalT = InstanceType<typeof Decimal>;

/**
 * Tier-floor slippage model (ADR 0015 §6 — extracted to shared for use by both
 * HistoricalFillAdapter and StreamingFillAdapter).
 *
 * Applies mandatory adverse slippage to every simulated fill independent of depth.
 * Encodes "you cannot fill better than the tier-typical effective spread" rule:
 * tier-1 (top-50 liquidity) ≥ ~15 bps, tier-2 ≥ ~50 bps, tier-3 ≥ ~100 bps.
 *
 * Pure functions: no I/O, no clock, no random.
 */

// Tier defaults; filled-in by strategy params at runtime.
export const DEFAULT_TIER1_SLIPPAGE_PCT = 0.15;
export const DEFAULT_TIER2_SLIPPAGE_PCT = 0.5;
export const DEFAULT_TIER3_SLIPPAGE_PCT = 1.0;

export interface ITierSlippageParams {
	readonly slippage_tier1_pct?: number;
	readonly slippage_tier2_pct?: number;
	readonly slippage_tier3_pct?: number;
}

export interface ITierSlippageResult {
	readonly fillPrice: string; // decimal
	readonly slippagePct: DecimalT;
}

/**
 * Compute the fill price after applying tier-floor slippage.
 * Pure function.
 *
 * @param refPrice Reference price (string, decimal format)
 * @param coinTier Tier classification (TIER_1, TIER_2, TIER_3)
 * @param side Order side ('long' or 'short')
 * @param action Order action ('open', 'reduce', 'close')
 * @param params Tier slippage configuration
 * @returns Result with filled price and slippage percentage applied
 */
export function computeTierFillPrice(
	refPrice: string,
	coinTier: CoinTierEnum,
	side: 'long' | 'short',
	action: 'open' | 'reduce' | 'close',
	params: ITierSlippageParams,
): ITierSlippageResult {
	const slippagePct = resolveTierSlippagePct(coinTier, params);
	const refDecimal = parseDecimal(refPrice);
	const fillPrice = applyAdverseSlippage(refDecimal, slippagePct, side, action);

	return {
		fillPrice: formatDecimal(fillPrice),
		slippagePct,
	};
}

function resolveTierSlippagePct(coinTier: CoinTierEnum, params: ITierSlippageParams): DecimalT {
	const pct =
		coinTier === CoinTierEnum.TIER_1
			? params.slippage_tier1_pct ?? DEFAULT_TIER1_SLIPPAGE_PCT
			: coinTier === CoinTierEnum.TIER_2
				? params.slippage_tier2_pct ?? DEFAULT_TIER2_SLIPPAGE_PCT
				: params.slippage_tier3_pct ?? DEFAULT_TIER3_SLIPPAGE_PCT;

	return parseDecimal(pct);
}

/**
 * Apply adverse slippage to a reference price based on side and action.
 *
 * Adverse direction (we pay more):
 *   - LONG opening / LONG reducing → buying side, adverse = higher (multiply by 1 + slippage)
 *   - SHORT opening / SHORT reducing → selling side, adverse = lower (multiply by 1 - slippage)
 */
function applyAdverseSlippage(
	refPrice: DecimalT,
	slippagePct: DecimalT,
	side: 'long' | 'short',
	action: 'open' | 'reduce' | 'close',
): DecimalT {
	const slippageFraction = divideDecimal(slippagePct, parseDecimal(100));
	const isAdverseHigher = isAdverseDirectionHigher(side, action);

	if (isAdverseHigher) {
		return multiplyDecimal(refPrice, parseDecimal(1).plus(slippageFraction));
	}

	return multiplyDecimal(refPrice, parseDecimal(1).minus(slippageFraction));
}

/**
 * Returns true when the adverse direction pushes the fill price UP (we pay more).
 *   - long open / long add / short close / short reduce → buying side, adverse = higher
 *   - short open / short add / long close / long reduce → selling side, adverse = lower
 */
function isAdverseDirectionHigher(side: 'long' | 'short', action: 'open' | 'reduce' | 'close'): boolean {
	const isEntry = action === 'open';

	if (side === 'long') {
		return isEntry; // long buying on open, selling on reduce/close
	}

	return !isEntry; // short selling on open, buying on reduce/close
}
