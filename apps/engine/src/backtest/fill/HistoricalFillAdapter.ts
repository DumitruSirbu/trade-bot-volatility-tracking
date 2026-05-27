import {
    CoinTierEnum,
    IBacktestConfig,
    IBacktestFill,
    ISimulatedFillCore,
    OrderPolicyEnum,
    applyFill as sharedApplyFill,
    simulateIntrabarStop as sharedSimulateIntrabarStop,
    type ITickSnapshot,
    type ITickAggregateSnapshot,
    type ITierSlippageParams,
} from '@bot/shared';

import { Money, MoneyValue } from '../../common/utils';
import { ORDER_TIMEOUT_MS } from '../../execution/const/executionConsts';
import { BookSnapshotEntity, TickAggregateEntity } from '../../market-data/entity';

// HistoricalFillAdapter — engine-side adapter wrapping the shared FillSimulatorCore
// (`packages/shared/src/util/fillSimulatorCore.ts`) for M7 backtest replays. Per ADR 0032
// §3 D15 the fill algorithm is now a single pure shared library; this adapter exists so
// the BacktestRunnerService and BacktestOrchestrator continue to consume a stable
// engine-shaped `IFillRequest → IBacktestFill` surface while delegating the actual math
// to `@bot/shared`.
//
// Latency handling: the shared `applyFill` end-to-end folds latency into the fill
// timestamp via the `latencyMs` parameter — the standalone `LatencyModel.computeFillTimestamp`
// helper is therefore obsolete and was removed in the same wave that introduced this adapter.
//
// Numerical equivalence with the pre-extraction `FillSimulator` is asserted by
// `apps/engine/src/backtest/__tests__/M7FillEquivalence.regression.spec.ts` against a
// committed golden tape so any drift in the shared core or this adapter is caught at CI time.
//
// Pure adapter. Stateless. No DI: the runner constructs one per replay, mirroring the
// pre-extraction `new FillSimulator()` pattern.
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

// Result of intra-bar stop evaluation. Mirrors the pre-extraction `IStopSimulatorResult`
// shape so call sites (BacktestRunnerService.checkPositionExit) continue to consume
// `MoneyValue | null` price values without changes.
export interface IStopSimulatorResult {
    readonly hit: 'stop_loss' | 'take_profit' | null;
    readonly hitTsMs: number | null;
    readonly hitPrice: MoneyValue | null;
    readonly lowFidelity: boolean;
}

export class HistoricalFillAdapter {
    simulateFill(request: IFillRequest): IBacktestFill {
        const intentDto = this.buildIntent(request);
        const snapshot = this.buildSnapshotForFill(request);
        const seed = this.buildSeed();
        const tickSnapshots = this.toTickSnapshots(request.ticks);
        const orderTimeoutMs = this.resolveOrderTimeoutMs(request.policy);

        const result: ISimulatedFillCore = sharedApplyFill(
            snapshot,
            intentDto,
            request.coinTier,
            request.tierSlippageParams,
            seed,
            tickSnapshots,
            request.signalBarOpenMs,
            orderTimeoutMs,
            request.config.latencyMs,
        );

        return this.toBacktestFill(request, result);
    }

    // Intra-bar SL/TP evaluation. Mirrors the pre-extraction `simulateIntrabarStop`
    // function signature so the runner's call site swaps the import only. Delegates to
    // the shared primitive which evaluates the per-tick path and falls back to bar-extreme
    // inference (lowFidelity = true) when ticks are absent.
    //
    // The runner does its own close-fill accounting via `simulateFill` once it knows a
    // stop was hit, so the public adapter surface returns the verdict only — not the
    // shared `applyIntraBarStop` fill-shaped DTO (which the runner does not consume).
    simulateIntrabarStop(
        side: 'long' | 'short',
        stopLoss: MoneyValue,
        takeProfit: MoneyValue,
        ticks: TickAggregateEntity[],
        barHigh: MoneyValue,
        barLow: MoneyValue,
        barOpenMs: number,
    ): IStopSimulatorResult {
        const aggregateSnapshots = this.toAggregateSnapshots(ticks);
        const sharedResult = sharedSimulateIntrabarStop(
            side,
            stopLoss.toFixed(),
            takeProfit.toFixed(),
            aggregateSnapshots,
            barHigh.toFixed(),
            barLow.toFixed(),
            barOpenMs,
        );

        return {
            hit: sharedResult.hit,
            hitTsMs: sharedResult.hitTsMs,
            hitPrice: sharedResult.hitPrice === null ? null : new Money(sharedResult.hitPrice),
            lowFidelity: sharedResult.lowFidelity,
        };
    }

    private buildIntent(request: IFillRequest) {
        return {
            side: request.side,
            action: request.intent,
            policy: request.policy,
            limitPrice: request.limitPrice.toFixed(),
            qty: request.qty.toFixed(),
            postOnly: request.policy === OrderPolicyEnum.POST_ONLY_MAKER,
            reduceOnly: request.intent === 'reduce' || request.intent === 'close',
        };
    }

    // The shared core uses snapshot.high/low only for the intra-bar stop helper; the fill
    // path does not read them. We pass through the request's barHigh/barLow for the few
    // intra-bar-stop call sites that build a request directly.
    private buildSnapshotForFill(request: IFillRequest) {
        const ref = request.limitPrice.toFixed();
        return {
            bid: ref,
            ask: ref,
            last: ref,
            mark: ref,
            high: request.barHigh.toFixed(),
            low: request.barLow.toFixed(),
            ts: request.signalBarOpenMs,
        };
    }

    // M7 backtest does not consume the shared seed at any branch reached during normal
    // replay (missed-fill detection is tick-deterministic). We supply a zero-byte seed so
    // the shared core has a well-formed DTO without inventing PRNG material the M7 model
    // does not use. PAPER mode (StreamingFillAdapter) is where HMAC-derived seeds engage.
    private buildSeed() {
        return {
            seedBytes: Buffer.alloc(0),
            version: 'm7-historical-v1',
        };
    }

    private toTickSnapshots(ticks: TickAggregateEntity[]): ITickSnapshot[] {
        return ticks.map((tick) => ({
            high: tick.high.toFixed(),
            low: tick.low.toFixed(),
            ts: tick.ts,
        }));
    }

    private toAggregateSnapshots(ticks: TickAggregateEntity[]): ITickAggregateSnapshot[] {
        return ticks.map((tick) => ({
            high: tick.high.toFixed(),
            low: tick.low.toFixed(),
            close: tick.close.toFixed(),
            ts: tick.ts,
        }));
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

    private toBacktestFill(request: IFillRequest, core: ISimulatedFillCore): IBacktestFill {
        return {
            eventId: request.eventId,
            symbol: request.symbol,
            side: request.side,
            intent: request.intent,
            priceUsdt: core.fillPrice,
            qty: core.qty,
            feeUsdt: core.feeUsdt,
            slippagePct: core.slippagePct,
            tsMs: core.tsMs,
            missed: !core.filled,
            // Tier-floor model only at M7 (depth-aware extension is a deferred wave).
            depthAware: false,
        };
    }
}
