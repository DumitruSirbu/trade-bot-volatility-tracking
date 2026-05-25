import { CoinTierEnum, IBacktestConfig, IBacktestFill, OrderPolicyEnum } from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils';
import { ORDER_TIMEOUT_MS } from '../../execution/const/executionConsts';
import { BookSnapshotEntity, TickAggregateEntity } from '../../market-data/entity';
import { computeFillTimestamp } from './LatencyModel';
import { isMissedFill } from './MissedFillModel';
import { computeTierFillPrice, ITierSlippageParams } from './TierSlippageModel';

// Binance USDT-M Futures default fees, expressed in basis points (1 bps = 0.01%).
// Standard non-VIP retail tier: maker 0.02% (2 bps), taker 0.04% (4 bps). Kept here as
// named constants so the backtest never has magic numbers in fee math and the values
// remain easy to override per-strategy in a later wave if VIP tiers / fee rebates are
// modelled. ADR 0015 §6 — fees are taker-by-policy for IOC/market, maker for POST_ONLY.
export const FEE_TAKER_BPS = 4;
export const FEE_MAKER_BPS = 2;
const BPS_DENOMINATOR = 10_000;

// One simulated fill's input bundle. All fields are pre-resolved by the BacktestRunner so
// the simulator stays pure (no I/O, no clock).
export interface IFillRequest {
    readonly eventId: string;
    readonly symbol: string;
    readonly side: 'long' | 'short';
    readonly intent: 'open' | 'reduce' | 'close';
    readonly policy: string;
    readonly limitPrice: MoneyValue;
    readonly qty: MoneyValue;
    readonly coinTier: CoinTierEnum;
    readonly signalBarOpenMs: number;
    readonly barHigh: MoneyValue;
    readonly barLow: MoneyValue;
    readonly ticks: TickAggregateEntity[];
    readonly bookSnapshot: BookSnapshotEntity | null;
    readonly tierSlippageParams: ITierSlippageParams;
    readonly config: Pick<IBacktestConfig, 'latencyMs' | 'enableDepthAwareSlippage' | 'enableIntrabarStopSimulation'>;
}

// FillSimulator orchestrates the per-order fill pipeline: latency timestamp →
// missed-fill check (limit policies only) → tier-floor slippage → fee → IBacktestFill.
// Depth-aware slippage is wired separately in W3; for W2b the depthAware flag on the
// returned fill is always false and only the tier-floor model applies.
//
// No DI: plain class, constructed once per backtest run by the orchestrator. The simulator
// is stateless beyond its constructor (none required); a class wrapper is preferred over
// loose functions so the W3 depth-aware extension can take a constructor-injected helper.
export class FillSimulator {
    simulateFill(request: IFillRequest): IBacktestFill {
        const fillTsMs = computeFillTimestamp(request.signalBarOpenMs, request.config.latencyMs);

        if (this.isOrderMissed(request)) {
            return this.buildMissedFill(request, fillTsMs);
        }

        const slippageResult = computeTierFillPrice(request.limitPrice, request.coinTier, request.side, request.intent, request.tierSlippageParams);
        const feeUsdt = this.computeFee(slippageResult.fillPrice, request.qty, request.policy);

        return {
            eventId: request.eventId,
            symbol: request.symbol,
            side: request.side,
            intent: request.intent,
            priceUsdt: slippageResult.fillPrice.toFixed(),
            qty: request.qty.toFixed(),
            feeUsdt: feeUsdt.toFixed(),
            slippagePct: slippageResult.slippagePct.toString(),
            tsMs: fillTsMs,
            missed: false,
            depthAware: false,
        };
    }

    private isOrderMissed(request: IFillRequest): boolean {
        const timeoutMs = this.resolveOrderTimeoutMs(request.policy);

        return isMissedFill(request.policy, request.limitPrice, request.side, request.ticks, request.signalBarOpenMs, timeoutMs);
    }

    private resolveOrderTimeoutMs(policy: string): number {
        if (policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC) {
            return ORDER_TIMEOUT_MS[OrderPolicyEnum.MARKETABLE_LIMIT_IOC];
        }

        if (policy === OrderPolicyEnum.POST_ONLY_MAKER) {
            return ORDER_TIMEOUT_MS[OrderPolicyEnum.POST_ONLY_MAKER];
        }

        return ORDER_TIMEOUT_MS[OrderPolicyEnum.REDUCE_MARKET];
    }

    private buildMissedFill(request: IFillRequest, fillTsMs: number): IBacktestFill {
        const zero = new Money(0);

        return {
            eventId: request.eventId,
            symbol: request.symbol,
            side: request.side,
            intent: request.intent,
            priceUsdt: zero.toFixed(),
            qty: zero.toFixed(),
            feeUsdt: zero.toFixed(),
            slippagePct: '0',
            tsMs: fillTsMs,
            missed: true,
            depthAware: false,
        };
    }

    private computeFee(fillPrice: MoneyValue, qty: MoneyValue, policy: string): MoneyValue {
        const notional = fillPrice.times(qty);
        const feeRateBps = this.resolveFeeBps(policy);
        const feeRate = new Money(feeRateBps).dividedBy(BPS_DENOMINATOR);

        return notional.times(feeRate);
    }

    // POST_ONLY_MAKER is the only maker policy (we rest on the passive side and the taker
    // crosses to us). IOC and REDUCE_MARKET both cross the book → taker fee.
    private resolveFeeBps(policy: string): number {
        if (policy === OrderPolicyEnum.POST_ONLY_MAKER) {
            return FEE_MAKER_BPS;
        }

        return FEE_TAKER_BPS;
    }
}
