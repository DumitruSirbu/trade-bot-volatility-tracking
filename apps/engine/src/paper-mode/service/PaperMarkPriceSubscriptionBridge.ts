import { ExchangeEnvironmentEnum, IPriceUpdateEvent } from '@bot/shared';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PRICE_UPDATE_EVENT } from '../../common/const';
import { parseMoney } from '../../common/utils/money';
import { AppConfigService } from '../../config/service';
import { PaperAccountStateService } from './PaperAccountStateService';
import { StreamingFillAdapter } from './StreamingFillAdapter';

// PaperMarkPriceSubscriptionBridge — R2c.D Item 1 (ADR 0032 §D5 + §D15).
//
// Pure subscription bridge: forwards every PRICE_UPDATE_EVENT emitted by the
// existing MarketDataModule WS tick stream to BOTH:
//   - PaperAccountStateService.notifyMarkPrice  (MTM throttle + drawdown
//     evaluation per §D5)
//   - StreamingFillAdapter.notifyTick           (intra-bar SL/TP evaluation
//     per §D15)
//
// No business logic, no DB writes, no orders — it is the seam that connects
// the live tick pump to PAPER's evaluators. The bridge lifecycle is bound to
// the Nest application: subscribe on bootstrap, release on shutdown.
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2 / §3 D14): this file MUST NOT import
// ccxt or RateLimitPolicyService. The R2a.5 module-graph sentinel guards the
// closure.
//
// CONSTRUCTION RULE: this provider is bound ONLY when EXCHANGE_ENV === PAPER
// (PaperModeModule factory provider, see provider registration). If it ever
// gets instantiated under LIVE/TESTNET the constructor short-circuits to a
// no-op subscription so it cannot interfere with live order flow.
//
// ARCHITECT-ADJUDICATION ITEM (R2c.D Item 1): ADR 0032 §D4 names
// `!markPrice@arr` / `<symbol>@markPrice` as the funding/next-funding metadata
// source and references mark-price-driven MTM in §D5. The engine's current
// MarketDataModule subscribes to `!ticker@arr` (last/quoteVolume only) and
// emits PRICE_UPDATE_EVENT with the `last` trade price, not the mark price.
// We use PRICE_UPDATE_EVENT as the available seam — for the restricted-profile
// soak the divergence between `last` and `mark` is bounded (no funding-anchor
// premium). Switching to a dedicated mark-price subscription is deferred to
// the architect-adjudication wave; the seam swap is localised to this file.

// IFillSnapshot factory — the StreamingFillAdapter's intra-bar evaluator
// expects bid/ask/last/mark/high/low. Tick-level price-update events carry
// only the last trade price + ts, so the bridge synthesises a minimal
// snapshot where every price column collapses to `last`. The shared
// `applyIntraBarStop` reads `high`/`low` for stop-trigger detection; with
// per-tick snapshots `high == low == last` is the correct per-tick degenerate
// case (one trade, one price). The 5-min OHLC range is owned by the
// market-data layer and never re-flows through this bridge.
function buildSnapshotFromTick(event: IPriceUpdateEvent) {
    return {
        bid: event.price,
        ask: event.price,
        last: event.price,
        mark: event.price,
        high: event.price,
        low: event.price,
        ts: event.timestampMs,
    } as const;
}

@Injectable()
export class PaperMarkPriceSubscriptionBridge implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(PaperMarkPriceSubscriptionBridge.name);

    // The unbind handle returned by EventEmitter2.on() — captured so the
    // shutdown hook can drop the subscription cleanly. Reusable in tests via
    // explicit `releaseForTest()` so the per-suite Jest harness does not leak
    // listeners across cases.
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly eventEmitter: EventEmitter2,
        private readonly accountState: PaperAccountStateService,
        private readonly streamingAdapter: StreamingFillAdapter,
    ) {}

    onApplicationBootstrap(): void {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            // Defence-in-depth — the PaperModeModule factory provider gates
            // construction by env already; this branch is the secondary
            // guard so a future module-wiring regression cannot accidentally
            // attach the bridge under LIVE/TESTNET.
            this.logger.log(`PaperMarkPriceSubscriptionBridge skipped: EXCHANGE_ENV=${this.appConfig.exchangeEnv} (PAPER only)`);

            return;
        }

        const listener = (event: IPriceUpdateEvent): void => this.handlePriceUpdate(event);

        this.eventEmitter.on(PRICE_UPDATE_EVENT, listener);
        this.unsubscribe = () => this.eventEmitter.off(PRICE_UPDATE_EVENT, listener);

        this.logger.log(`PaperMarkPriceSubscriptionBridge subscribed to ${PRICE_UPDATE_EVENT}`);
    }

    onApplicationShutdown(): void {
        if (this.unsubscribe !== null) {
            this.unsubscribe();
            this.unsubscribe = null;
            this.logger.log(`PaperMarkPriceSubscriptionBridge unsubscribed from ${PRICE_UPDATE_EVENT}`);
        }
    }

    // Single dispatch path. Both the MTM throttle (account-state side) and
    // the intra-bar evaluator (streaming-adapter side) need to see EVERY
    // tick — the account-state side coalesces internally per §D5; the
    // streaming-adapter side evaluates synchronously per §D15.
    private handlePriceUpdate(event: IPriceUpdateEvent): void {
        try {
            this.accountState.notifyMarkPrice({
                symbol: event.symbol,
                markPrice: parseMoney(event.price),
                observedAt: new Date(event.timestampMs),
            });
        } catch (cause) {
            this.logger.error(
                `PaperMarkPriceSubscriptionBridge: notifyMarkPrice failed for ${event.symbol} — ` + `${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }

        try {
            this.streamingAdapter.notifyTick(event.symbol, buildSnapshotFromTick(event));
        } catch (cause) {
            this.logger.error(
                `PaperMarkPriceSubscriptionBridge: notifyTick failed for ${event.symbol} — ` + `${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }
}
