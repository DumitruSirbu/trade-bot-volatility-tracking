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
    type ITickSnapshot,
    type ITierSlippageParams,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { ORDER_TIMEOUT_MS } from '../../execution/const/executionConsts';
import { STREAMING_FILL_STALE_TICK_MS } from '../const';
import { StreamingFillAdapterException } from '../exception';
import { isPositiveDecimalString } from '../utils/priceUtils';

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

        // Live streaming adapter: synthesize one snapshot-derived executable-price
        // tick for MARKETABLE_LIMIT_IOC opens — a spread-crossing IOC fills at the
        // current quote; the shared detector confirms the touch. Fill tsMs is then
        // overridden to snapshot.ts + latencyMs (event-time); historical replay
        // (M7) still passes recorded tick_aggregates and keeps next-bar timestamps.
        const orderTimeoutMs = this.resolveOrderTimeoutMs(intent.policy);
        const signalBarOpenMs = snapshot.ts;

        const intraBarTicks = this.buildIntraBarTicks(intent, snapshot);

        const result = sharedApplyFill(snapshot, intent, coinTier, tierSlippageParams, seed, intraBarTicks, signalBarOpenMs, orderTimeoutMs, latencyMs);

        if (intent.policy === OrderPolicyEnum.MARKETABLE_LIMIT_IOC && result.filled) {
            return { ...result, tsMs: snapshot.ts + latencyMs };
        }

        return result;
    }

    // Synthesize the intra-bar tick path the shared missed-fill detector
    // consults. For MARKETABLE_LIMIT_IOC opens we emit a single side-aware
    // executable-price point derived from the live snapshot (ask for LONG,
    // bid for SHORT, same fallback chain as deriveReferencePrice). The detector
    // tests `tick.low` for LONG and `tick.high` for SHORT (inclusive), so a
    // spread-crossing IOC fills while a non-crossing inside-spread limit misses.
    // Any other policy keeps the empty path (no synthetic confirmation).
    private buildIntraBarTicks(intent: IFillIntent, snapshot: IFillSnapshot): ITickSnapshot[] {
        if (intent.policy !== OrderPolicyEnum.MARKETABLE_LIMIT_IOC) {
            return [];
        }

        const executablePrice = this.resolveExecutablePrice(intent.side, snapshot);

        // On the live paper path limitPrice ≡ executablePrice (same snapshot candidate),
        // so a gate-approved IOC always crosses; the non-crossing guard is defense-in-depth
        // against a future change that decouples the two derivations.
        if (executablePrice === null) {
            return [];
        }

        const syntheticTick: ITickSnapshot = {
            high: executablePrice,
            low: executablePrice,
            ts: new Date(snapshot.ts),
        };

        return [syntheticTick];
    }

    // Derive the actual executable market price from the live snapshot, mirroring
    // `PaperFillSimulator.deriveReferencePrice`'s quote-field fallback chain.
    // Open LONG = taker buy → ask; open SHORT = taker sell → bid. Only quote
    // fields are eligible (never bar-level high/low). Returns null when every
    // candidate is missing or non-positive — the caller then emits no synthetic
    // tick, so the fill misses rather than fabricating a price.
    private resolveExecutablePrice(side: 'long' | 'short', snapshot: IFillSnapshot): string | null {
        const primary = side === 'long' ? snapshot.ask : snapshot.bid;
        const opposite = side === 'long' ? snapshot.bid : snapshot.ask;
        const candidates: ReadonlyArray<string> = [primary, snapshot.mark, snapshot.last, opposite];

        for (const candidate of candidates) {
            if (isPositiveDecimalString(candidate)) {
                return candidate;
            }
        }

        return null;
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
