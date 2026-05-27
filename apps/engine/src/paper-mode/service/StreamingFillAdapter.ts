import {
    CoinTierEnum,
    IFillIntent,
    IFillPosition,
    IFillSeed,
    IFillSnapshot,
    ISimulatedFillCore,
    OrderPolicyEnum,
    applyFill as sharedApplyFill,
    applyIntraBarStop as sharedApplyIntraBarStop,
    type ITickAggregateSnapshot,
    type ITierSlippageParams,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { ORDER_TIMEOUT_MS } from '../../execution/const/executionConsts';
import { StreamingFillAdapterException } from '../exception';

// StreamingFillAdapter — engine-side adapter wrapping the shared `FillSimulatorCore`
// for PAPER live event-time execution (ADR 0032 §3 D15).
//
// Per D15, PAPER cannot read future ticks at decision time. This adapter therefore
// maintains a per-symbol last-tick cache (last bid/ask/last/mark + timestamp) that
// is updated on every WS tick via `notifyTick(symbol, snapshot)` and a per-position
// registry of SL/TP listeners that the adapter walks on every tick arrival.
//
// SL/TP evaluation is EVENT-DRIVEN, never timer-driven (D15 / R3.1). No `setTimeout`,
// no wall-clock scheduling — every protective-fill decision fires synchronously from
// inside `notifyTick`. A `setTimeout`-driven model would drift relative to Binance's
// tick cadence under event-loop load, producing non-deterministic intra-bar timing.
//
// CAUSALITY INVARIANT (R3.1 mandatory): at time `t`, this adapter cannot read any
// tick or book-snapshot data with timestamp `> t`. The adapter has no access to
// future ticks — it only sees what has been pushed via `notifyTick` up to the
// current moment. See `StreamingFillAdapter.causality.spec.ts`.
//
// STREAMING vs BAR INVARIANT (M11a R4 Item 3B): the shared
// `simulateIntrabarStop` was designed for M7 backtests where the per-bar
// high/low is the unit of analysis. In live event-time PAPER, each WS tick
// is a single price point — feeding the bar-level high/low as the per-tick
// range causes both SL and TP to evaluate true simultaneously for a wide
// bar, and the shared SL-wins-ties rule then always fires SL. Per-tick
// evaluation MUST therefore collapse high/low to the tick's `last` price.
// Bar-level high/low fallback inside the shared evaluator stays reserved
// for the historical-replay path.
//
// LIFECYCLE: every open position registers via `registerPosition(positionId, ...)`
// and MUST be released via `releasePosition(positionId)` on close, cancel, or
// shutdown. The gemini r2 forward-looking callback-lifecycle finding is addressed
// by the explicit release primitive — registry entries do not leak.
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2): this file MUST NOT import ccxt or
// `RateLimitPolicyService`. The R2a.5 module-graph sentinel guards the closure.

// Per-position registration record. `evaluator` is the cached
// position-evaluation closure so the hot path is one map walk + the
// shared core call (no per-tick allocation of intermediate DTOs).
interface IRegisteredPosition {
    readonly positionId: string;
    readonly symbol: string;
    readonly position: IFillPosition;
    readonly seed: IFillSeed;
    readonly onTrigger: (fill: ISimulatedFillCore) => void;
}

// Stale-tick threshold: a tick older than this is considered too cold for the
// next order intent. Mirrors M5's submit-network-timeout horizon; a tick we
// haven't seen for 5s is suspicious enough that the adapter declines to fill
// rather than fill on stale data.
export const STREAMING_FILL_STALE_TICK_MS = 5_000;

@Injectable()
export class StreamingFillAdapter {
    private readonly logger = new Logger(StreamingFillAdapter.name);

    // Per-symbol last-tick cache. The hot path is `notifyTick` -> registry walk
    // -> shared core; reads of the cache by `simulateOrderFill` see whatever
    // the WS pump pushed last for the symbol.
    private readonly lastTickBySymbol = new Map<string, IFillSnapshot>();

    // Per-position registry keyed by positionId for O(1) release. We also keep
    // a per-symbol index so the per-tick walk is bounded by held positions on
    // the ticking symbol, not the full registry size.
    private readonly registry = new Map<string, IRegisteredPosition>();

    private readonly positionIdsBySymbol = new Map<string, Set<string>>();

    // ----- WS tick pump entry point (R2c.D wires the WS subscription) -----

    // Called by the engine's WS subscription bridge on every live mark/trade
    // tick for any held symbol. R2c.C provides this entry point; R2c.D wires
    // the actual MarketDataModule -> notifyTick bridge.
    notifyTick(symbol: string, snapshot: IFillSnapshot): void {
        this.lastTickBySymbol.set(symbol, snapshot);

        const positionIds = this.positionIdsBySymbol.get(symbol);

        if (positionIds === undefined || positionIds.size === 0) {
            return;
        }

        for (const positionId of positionIds) {
            const registered = this.registry.get(positionId);

            if (registered === undefined) {
                continue;
            }

            this.evaluateOnTick(registered, snapshot);
        }
    }

    // ----- Per-position SL/TP registry (event-driven evaluation) -----

    // Register an open position for intra-bar SL/TP evaluation. The adapter
    // calls `onTrigger(fill)` synchronously from inside `notifyTick` when the
    // shared `applyIntraBarStop` returns non-null for the latest tick on the
    // position's symbol.
    //
    // The caller (PaperFillSimulator / PaperAccountStateService at open) is
    // responsible for calling `releasePosition(positionId)` on close, cancel,
    // or process shutdown so the registry does not leak (gemini r2 finding).
    registerPosition(positionId: string, symbol: string, position: IFillPosition, seed: IFillSeed, onTrigger: (fill: ISimulatedFillCore) => void): void {
        if (this.registry.has(positionId)) {
            // Re-register over an existing entry is a programming bug — surface
            // loud rather than silently double-fire callbacks.
            throw new StreamingFillAdapterException(`registerPosition: positionId=${positionId} already registered. Release before re-registering.`);
        }

        this.registry.set(positionId, { positionId, symbol, position, seed, onTrigger });

        let bucket = this.positionIdsBySymbol.get(symbol);

        if (bucket === undefined) {
            bucket = new Set<string>();
            this.positionIdsBySymbol.set(symbol, bucket);
        }

        bucket.add(positionId);
    }

    // Explicit cleanup. Must be called by the position lifecycle code so
    // registry entries do not accumulate across the soak. Idempotent — releasing
    // an unknown positionId is a no-op (warn-log only) so a defensive caller
    // (e.g. shutdown hook) never throws.
    releasePosition(positionId: string): void {
        const registered = this.registry.get(positionId);

        if (registered === undefined) {
            return;
        }

        this.registry.delete(positionId);

        const bucket = this.positionIdsBySymbol.get(registered.symbol);

        if (bucket !== undefined) {
            bucket.delete(positionId);

            if (bucket.size === 0) {
                this.positionIdsBySymbol.delete(registered.symbol);
            }
        }
    }

    // Observability helper for tests + reviewers — does the registry currently
    // hold an entry for `positionId`?
    isRegistered(positionId: string): boolean {
        return this.registry.has(positionId);
    }

    // Observability helper for the memory-leak test — total active registrations.
    registeredCount(): number {
        return this.registry.size;
    }

    // M11a R4 Item 3A — exposes the per-symbol last-tick cache so the
    // PaperFillSimulator can derive a non-zero reference price for
    // market-style intents. Returns `null` when no tick has arrived for
    // the symbol yet — the simulator records a `no_tick_cached` missed-fill
    // in that case rather than fabricating a price.
    getLastSnapshot(symbol: string): IFillSnapshot | null {
        return this.lastTickBySymbol.get(symbol) ?? null;
    }

    // ----- Order placement (taker IOC / post-only-maker resolved immediately) -----

    // Simulate the fill for a single order intent against the last-known tick
    // for the intent's symbol. Returns null if no recent tick exists for the
    // symbol or the cached tick is older than STREAMING_FILL_STALE_TICK_MS —
    // the caller (`PaperFillSimulator`) treats null as a missed fill.
    //
    // PAPER's order policies (marketable-limit-IOC, post-only-maker collapsing
    // to immediate-or-cancel, reduce-market) do not produce resting orders;
    // every placeOrder resolves to fill-or-miss in one shot. SL/TP live on the
    // per-position registry, not here.
    simulateOrderFill(
        intent: IFillIntent,
        symbol: string,
        coinTier: CoinTierEnum,
        tierSlippageParams: ITierSlippageParams,
        seed: IFillSeed,
        nowMs: number,
        latencyMs: number,
    ): ISimulatedFillCore | null {
        const snapshot = this.lastTickBySymbol.get(symbol);

        if (snapshot === undefined) {
            this.logger.warn(`StreamingFillAdapter.simulateOrderFill: no tick cached for symbol=${symbol} — returning null (missed fill).`);

            return null;
        }

        if (nowMs - snapshot.ts > STREAMING_FILL_STALE_TICK_MS) {
            this.logger.warn(
                `StreamingFillAdapter.simulateOrderFill: cached tick stale for symbol=${symbol} ` +
                    `(age=${nowMs - snapshot.ts}ms > ${STREAMING_FILL_STALE_TICK_MS}ms) — returning null.`,
            );

            return null;
        }

        // For PAPER live event-time, intra-bar tick history is empty — the
        // shared core's missed-fill detector falls back to the limit-vs-mark
        // test (M5 IOC semantics) instead of replaying a recorded tick path.
        const orderTimeoutMs = this.resolveOrderTimeoutMs(intent.policy);
        // Signal-bar open is effectively "now" for live event-time; the
        // shared core's `computeFillTimestamp` advances by `latencyMs` only.
        const signalBarOpenMs = snapshot.ts;

        return sharedApplyFill(snapshot, intent, coinTier, tierSlippageParams, seed, [], signalBarOpenMs, orderTimeoutMs, latencyMs);
    }

    // ----- Per-tick SL/TP evaluation (event-driven) -----

    private evaluateOnTick(registered: IRegisteredPosition, snapshot: IFillSnapshot): void {
        // M11a R4 Item 3B FIX: collapse the synthesised tick-aggregate's
        // high/low to the tick's `last` price (a POINT estimate). Passing
        // `snapshot.high` / `snapshot.low` smuggles the bar-level range into
        // a per-tick evaluation — when SL is below `last` and TP is above
        // `last` but BOTH are inside [low, high], the shared evaluator sees
        // SL hit AND TP hit and the tie-break rule fires SL on every wide
        // bar. Live streaming MUST always be tick-precise; bar-level
        // high/low fallback inside the shared evaluator is for the
        // backtest-replay path.
        //
        // We also synthesise a tick-precise `IFillSnapshot` for the same
        // reason — the shared evaluator falls back to `snapshot.high` /
        // `snapshot.low` when the per-tick array is exhausted; collapsing
        // both layers keeps the evaluation a single-point check.
        const tickAggregate: ITickAggregateSnapshot = {
            high: snapshot.last,
            low: snapshot.last,
            close: snapshot.last,
            // ITickAggregateSnapshot expects Date; IFillSnapshot carries ms.
            ts: new Date(snapshot.ts),
        };

        const pointSnapshot: IFillSnapshot = {
            ...snapshot,
            high: snapshot.last,
            low: snapshot.last,
        };

        const fill = sharedApplyIntraBarStop(pointSnapshot, registered.position, [tickAggregate], snapshot.ts);

        if (fill === null) {
            return;
        }

        // Fire-and-forget the trigger callback. The caller is responsible for
        // synchronously calling `releasePosition` from inside the callback if
        // the position should no longer be evaluated (e.g. SL closed the
        // position) — that keeps the lifecycle explicit and inspectable.
        try {
            registered.onTrigger(fill);
        } catch (cause) {
            this.logger.error(
                `StreamingFillAdapter.evaluateOnTick: onTrigger for positionId=${registered.positionId} threw — ` +
                    `${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
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
}
