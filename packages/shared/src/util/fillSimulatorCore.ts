import { Decimal } from 'decimal.js';

import { CoinTierEnum, OrderPolicyEnum } from '../enum/index.js';
import { IFillIntent } from '../interface/IFillIntent.js';
import { IFillPosition } from '../interface/IFillPosition.js';
import { IFillSeed } from '../interface/IFillSeed.js';
import { IFillSnapshot } from '../interface/IFillSnapshot.js';
import { ISimulatedFillCore } from '../interface/ISimulatedFillCore.js';
import { parseDecimal, formatDecimal, multiplyDecimal, divideDecimal } from './decimalMath.js';
import { computeTierFillPrice, ITierSlippageParams } from './tierSlippageCalculator.js';
import { isMissedFill, ITickSnapshot } from './missedFillDetector.js';
import { simulateIntrabarStop, ITickAggregateSnapshot } from './intraBarStopEvaluator.js';

// Type alias for Decimal instances per decimal.js d.ts pattern (avoids TS2709 namespace-collision).
type DecimalT = InstanceType<typeof Decimal>;

/**
 * Binance USDT-M Futures default fees, in basis points.
 * Standard non-VIP retail tier: maker 2 bps (0.02%), taker 4 bps (0.04%).
 * Per ADR 0015 §6.
 */
const FEE_TAKER_BPS = 4;
const FEE_MAKER_BPS = 2;
const BPS_DENOMINATOR = 10_000;

/**
 * FillSimulatorCore — pure functions for simulating order fills.
 * Used by both M7 backtests (HistoricalFillAdapter) and PAPER mode (StreamingFillAdapter).
 *
 * Deterministic by construction: No I/O, no clock, no randomness. Missed-fill is decided
 * by tick replay (fully deterministic), not a random roll. The `IFillSeed` parameter is
 * reserved for a future depth-aware/stochastic fill model and is currently unused.
 * No TypeORM entities, no Nest providers, no engine imports.
 *
 * Pure strategies:
 *   - Input: snapshot + intent + seed (reserved, unused) + market data
 *   - Output: fill result + low-fidelity flag
 *   - Same snapshot → same fill (byte-deterministic for numerical-equal inputs)
 *
 * lowFidelity semantics (per M11a-paper-mode-addendum.md "lowFidelity behaviour in PAPER"):
 *   - applyFill always returns lowFidelity: true because M7 uses tier-floor slippage (not
 *     depth-aware). The depth-aware extension is deferred; until it lands, all fills lack
 *     depth-of-book modeling. See ADR 0019 criterion 12 and ADR 0032 §3 D15.
 *   - applyIntraBarStop returns lowFidelity: true only when falling back to bar extremes
 *     (no tick path); when tick_aggregates exists, lowFidelity: false.
 */

/**
 * Simulate a single fill from a market snapshot and order intent.
 * Applies latency, missed-fill check, tier slippage, and fee.
 *
 * @param snapshot Market snapshot (bid/ask/mark/high/low)
 * @param intent Order intent (side, action, policy, limit, qty)
 * @param coinTier Coin tier classification
 * @param tierSlippageParams Tier slippage configuration
 * @param _seed Reserved for future depth-aware/stochastic model; currently unused
 * @param intraBarTicks Intra-bar ticks for missed-fill detection (may be empty)
 * @param signalBarOpenMs Bar open timestamp in ms (used for timeout window)
 * @param orderTimeoutMs Order timeout in ms
 * @param latencyMs Fill latency in ms (relative to signal bar)
 * @returns Simulated fill result
 */
export function applyFill(
    snapshot: IFillSnapshot,
    intent: IFillIntent,
    coinTier: CoinTierEnum,
    tierSlippageParams: ITierSlippageParams,
    _seed: IFillSeed,
    intraBarTicks: ITickSnapshot[],
    signalBarOpenMs: number,
    orderTimeoutMs: number,
    latencyMs: number,
): ISimulatedFillCore {
    const fillTsMs = computeFillTimestamp(signalBarOpenMs, latencyMs);

    // Check if order would be missed (limit orders only).
    if (isMissedFill(intent.policy, intent.limitPrice, intent.side, intraBarTicks, signalBarOpenMs, orderTimeoutMs)) {
        return buildMissedFill(fillTsMs);
    }

    // Apply tier-floor slippage.
    const slippageResult = computeTierFillPrice(intent.limitPrice, coinTier, intent.side, intent.action, tierSlippageParams);
    const fillPrice = parseDecimal(slippageResult.fillPrice);
    const slippagePct = slippageResult.slippagePct;

    // Compute fee.
    const feeUsdt = computeFee(fillPrice, parseDecimal(intent.qty), intent.policy);

    return {
        filled: true,
        fillPrice: slippageResult.fillPrice, // already formatted
        qty: intent.qty,
        feeUsdt: formatDecimal(feeUsdt),
        slippagePct: formatDecimal(slippagePct),
        missedReason: null,
        lowFidelity: true, // M7 uses tier-floor slippage, not depth-aware; per ADR 0032 D15
        tsMs: fillTsMs,
    };
}

/**
 * Simulate intra-bar protective fills (stop-loss or take-profit) for an open position.
 * Returns null if neither SL nor TP was hit during the bar.
 *
 * @param snapshot Market snapshot for reference (mark price, bar high/low)
 * @param position Open position state (entry, side, SL, TP)
 * @param intraBarTicks Intra-bar ticks for chronological ordering
 * @param barOpenMs Bar open timestamp in ms
 * @returns Protective fill result, or null if no stop was hit
 */
export function applyIntraBarStop(
    snapshot: IFillSnapshot,
    position: IFillPosition,
    intraBarTicks: ITickAggregateSnapshot[],
    barOpenMs: number,
): ISimulatedFillCore | null {
    const stopResult = simulateIntrabarStop(position.side, position.stopLoss, position.takeProfit, intraBarTicks, snapshot.high, snapshot.low, barOpenMs);

    if (stopResult.hit === null) {
        return null; // No SL or TP hit
    }

    // A stop fill closes the position at the hit price.
    // Fee depends on the exit action; for simplicity, use market fill semantics (taker).
    // Note: this mimics M7 backtest behavior where protective fills are taken at close price.
    const hitPrice = parseDecimal(stopResult.hitPrice!);
    const feeUsdt = computeFee(hitPrice, parseDecimal(position.size), OrderPolicyEnum.REDUCE_MARKET);

    return {
        filled: true,
        fillPrice: stopResult.hitPrice!,
        qty: position.size,
        feeUsdt: formatDecimal(feeUsdt),
        slippagePct: '0', // SL/TP fills are taken at the level, no slippage model applied
        missedReason: null,
        lowFidelity: stopResult.lowFidelity,
        tsMs: stopResult.hitTsMs!,
    };
}

/**
 * Compute fill timestamp: next bar's open plus latency.
 * Preserves the C2 look-ahead invariant: an entry off a signal bar's close
 * cannot fill within that same bar in the simulator.
 *
 * Pure function.
 */
function computeFillTimestamp(signalBarOpenMs: number, latencyMs: number): number {
    const CANDLE_5M_INTERVAL_MS = 5 * 60 * 1000;
    const nextBarOpenMs = signalBarOpenMs + CANDLE_5M_INTERVAL_MS;
    return nextBarOpenMs + latencyMs;
}

/**
 * Build a missed-fill result (qty and fee are zero).
 */
function buildMissedFill(fillTsMs: number): ISimulatedFillCore {
    return {
        filled: false,
        fillPrice: '0',
        qty: '0',
        feeUsdt: '0',
        slippagePct: '0',
        missedReason: 'timeout',
        lowFidelity: true, // Consistent with applyFill per ADR 0032 D15
        tsMs: fillTsMs,
    };
}

/**
 * Compute fee for a fill.
 * POST_ONLY_MAKER uses maker fee (2 bps); IOC and REDUCE_MARKET use taker fee (4 bps).
 */
function computeFee(fillPrice: DecimalT, qty: DecimalT, policy: string): DecimalT {
    const notional = multiplyDecimal(fillPrice, qty);
    const feeRateBps = policy === OrderPolicyEnum.POST_ONLY_MAKER ? FEE_MAKER_BPS : FEE_TAKER_BPS;
    const feeRate = divideDecimal(parseDecimal(feeRateBps), parseDecimal(BPS_DENOMINATOR));

    return multiplyDecimal(notional, feeRate);
}
