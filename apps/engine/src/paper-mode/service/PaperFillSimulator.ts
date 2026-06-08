import {
    CoinTierEnum,
    IFillIntent,
    IFillSeed,
    IFillSnapshot,
    IOrderIntent,
    ISimulatedFillCore,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
    DEFAULT_TIER1_SLIPPAGE_PCT,
    DEFAULT_TIER2_SLIPPAGE_PCT,
    DEFAULT_TIER3_SLIPPAGE_PCT,
    type ITierSlippageParams,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { createHmac, randomUUID } from 'node:crypto';

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { PAPER_FILL_LATENCY_MS } from '../const';
import { PaperSimulatorIdempotencyRepository } from '../repository/PaperSimulatorIdempotencyRepository';
import { isPositiveDecimalString } from '../utils/priceUtils';
import { StreamingFillAdapter } from './StreamingFillAdapter';

// HKDF info string for the per-soak seed-master. Distinct from
// boot_mode_history / paper_state_audit / auth sub-keys so a leak of the
// seed-master cannot forge an audit row, and a leak of an audit sub-key
// cannot replay a simulator decision (ADR 0032 §3 D3 + §D6).
const HKDF_INFO_PAPER_SIMULATOR_SEED = 'paper_simulator_seed v1';

// M11a R4 Item 5: PAPER_FILL_LATENCY_MS was relocated to
// `paper-mode/const/paperFillSimulatorConsts.ts` and is now imported above.

// Per-D3, the simulator config hash + tier-slippage params are sourced from
// the M7 committed configuration. R2c.C uses the defaults so the soak runs
// against the committed tier-floor model — a per-soak override that flatters
// v1 would defeat the soak. R2c.D wires a real config-source if the committed
// path needs operator-tunable knobs.
const DEFAULT_TIER_SLIPPAGE_PARAMS: ITierSlippageParams = {
    slippage_tier1_pct: DEFAULT_TIER1_SLIPPAGE_PCT,
    slippage_tier2_pct: DEFAULT_TIER2_SLIPPAGE_PCT,
    slippage_tier3_pct: DEFAULT_TIER3_SLIPPAGE_PCT,
};

// Context the engine threads alongside the shared `IOrderIntent` for PAPER
// simulator idempotency keying (ADR 0032 §D3). Per the R2c.C scoping note:
// the shared `IOrderIntent` is FROZEN (D2) and cannot grow new fields. Rather
// than extending the shared port, the simulator accepts a small context arg
// that the PaperExecutionClient derives from `intent` + injected config.
//
//   - `eventId` already lives on `IOrderIntent.eventId` (re-passed here so the
//     hash inputs are explicit at the call site and a hash-input swap is a
//     mechanical edit, not a hidden dependency on intent-shape evolution).
//   - `orderIntentId` is derived deterministically from the intent shape so a
//     SIGKILL replay re-derives the same id from the persisted decision row.
//   - `versionNamespace` distinguishes active vs. shadow versions per D17 so
//     v1.PAPER and v2.shadow do not collide on the idempotency ledger.
export interface IPaperSimulatorContext {
    readonly eventId: string;
    readonly orderIntentId: string;
    readonly versionNamespace: string;
}

// PaperFillSimulator — deterministic per-order fill resolution backed by the
// shared `FillSimulatorCore` via `StreamingFillAdapter`, with HMAC-derived
// per-order seeds and an idempotency ledger that makes SIGKILL replay
// byte-deterministic (ADR 0032 §3 D3 + D15).
//
// The simulator is the single owner of:
//   - per-order seed derivation (`order_seed = HMAC(seed_master, event_id ||
//     symbol || order_intent_id || version_namespace)`),
//   - the idempotency-ledger lookup-before-roll discipline,
//   - the `IOrderIntent` -> `IFillIntent` translation (the shared core knows
//     only the minimal fill DTO; the port-shape `IOrderIntent` lives on the
//     engine boundary).
//
// COMPILE-TIME INVARIANT (ADR 0032 §2 D2 + D14): MUST NOT import ccxt or
// `RateLimitPolicyService`. The R2a.5 module-graph sentinel guards the
// closure transitively.

interface IPaperSimulatorResult {
    readonly fill: ISimulatedFillCore;
    readonly orderSeed: IFillSeed;
    readonly simulatedFillId: string;
}

@Injectable()
export class PaperFillSimulator {
    private readonly logger = new Logger(PaperFillSimulator.name);

    // Memoised per-soak seed master; recomputed once on first use from the
    // bootstrap secret via HKDF. Per D3, `seed_master` is never persisted —
    // it is re-derivable at every boot from the bootstrap secret.
    private cachedSeedMaster: Buffer | null = null;

    constructor(
        private readonly subkeys: BootstrapSubkeyDeriver,
        private readonly idempotencyRepo: PaperSimulatorIdempotencyRepository,
        private readonly streamingAdapter: StreamingFillAdapter,
    ) {}

    // Simulate (or replay) the fill for a single order intent. The contract:
    //   1. Compute the per-order seed.
    //   2. Look up the idempotency ledger by `(eventId, orderIntentId,
    //      versionNamespace)`. If a row exists, return its persisted fill
    //      verbatim (numerically equivalent on replay per D15).
    //   3. Otherwise: delegate to StreamingFillAdapter.simulateOrderFill.
    //      Persist the resulting fill (or the missed-fill sentinel) into the
    //      ledger so a subsequent replay returns it.
    async simulateFill(intent: IOrderIntent, context: IPaperSimulatorContext, coinTier: CoinTierEnum, nowMs: number): Promise<IPaperSimulatorResult> {
        const orderSeed = this.deriveOrderSeed(intent, context);

        const existing = await this.idempotencyRepo.findByKey({
            eventId: context.eventId,
            orderIntentId: context.orderIntentId,
            versionNamespace: context.versionNamespace,
        });

        if (existing !== null) {
            this.logger.warn(
                `PaperFillSimulator idempotent replay: event_id=${context.eventId} ` +
                    `order_intent_id=${context.orderIntentId} namespace=${context.versionNamespace} ` +
                    `simulated_fill_id=${existing.simulatedFillId}`,
            );

            return {
                fill: existing.simulatedFillPayload as unknown as ISimulatedFillCore,
                orderSeed,
                simulatedFillId: existing.simulatedFillId,
            };
        }

        // M11a R4 Item 3A — derive the reference price from the live tick
        // cache BEFORE building the fill intent so the shared core sees a
        // real reference price for market-style intents. Previously the
        // intent was synthesized with `limitPrice: '0'`, which the shared
        // `applyFill` used as the reference and produced fillPrice=0 +
        // fee=0 + slippagePct=0 for every PAPER trade — invalidating the
        // soak's accounting math.
        const snapshot = this.streamingAdapter.getLastSnapshot(intent.symbol);

        if (snapshot === null) {
            const fill = this.buildMissedFillForNoTick(nowMs);
            const simulatedFillId = randomUUID();
            await this.idempotencyRepo.insertNew({
                eventId: context.eventId,
                orderIntentId: context.orderIntentId,
                versionNamespace: context.versionNamespace,
                simulatedFillId,
                simulatedFillPayload: fill as unknown as Record<string, unknown>,
            });

            return { fill, orderSeed, simulatedFillId };
        }

        const fillIntent = this.translateToFillIntent(intent, snapshot);
        const fillOrNull = this.streamingAdapter.simulateOrderFill(
            fillIntent,
            intent.symbol,
            coinTier,
            DEFAULT_TIER_SLIPPAGE_PARAMS,
            orderSeed,
            nowMs,
            PAPER_FILL_LATENCY_MS,
        );

        const fill = fillOrNull ?? this.buildMissedFillForNoTick(nowMs);
        const simulatedFillId = randomUUID();

        await this.idempotencyRepo.insertNew({
            eventId: context.eventId,
            orderIntentId: context.orderIntentId,
            versionNamespace: context.versionNamespace,
            simulatedFillId,
            simulatedFillPayload: fill as unknown as Record<string, unknown>,
        });

        return { fill, orderSeed, simulatedFillId };
    }

    // Per ADR 0032 §D3:
    //   seed_master = HKDF(bootstrap_secret, info='paper_simulator_seed v1')
    //   order_seed  = HMAC-SHA256(seed_master, event_id || symbol ||
    //                                          order_intent_id ||
    //                                          version_namespace)
    //
    // The byte separator (0x1F unit-separator) defeats the catenation-ambiguity
    // attack on a multi-field HMAC input — `event_id=A,symbol=BC` and
    // `event_id=AB,symbol=C` produce distinct seeds.
    private deriveOrderSeed(intent: IOrderIntent, context: IPaperSimulatorContext): IFillSeed {
        const seedMaster = this.getSeedMaster();
        const hmac = createHmac('sha256', seedMaster);
        const separator = Buffer.from([0x1f]);
        hmac.update(Buffer.from(context.eventId, 'utf8'));
        hmac.update(separator);
        hmac.update(Buffer.from(intent.symbol, 'utf8'));
        hmac.update(separator);
        hmac.update(Buffer.from(context.orderIntentId, 'utf8'));
        hmac.update(separator);
        hmac.update(Buffer.from(context.versionNamespace, 'utf8'));

        return {
            seedBytes: hmac.digest(),
            version: HKDF_INFO_PAPER_SIMULATOR_SEED,
        };
    }

    private getSeedMaster(): Buffer {
        if (this.cachedSeedMaster === null) {
            this.cachedSeedMaster = this.subkeys.deriveSubkey(HKDF_INFO_PAPER_SIMULATOR_SEED);
        }

        return this.cachedSeedMaster;
    }

    // Translate the shared port `IOrderIntent` into the shared core
    // `IFillIntent`. The mapping is intentionally narrow — the simulator does
    // not consume strategy metadata (flowType, signalScore, idiosyncrasy);
    // those drive risk gating upstream of execution, not fill resolution.
    //
    // M11a R4 Item 3A: `limitPrice` is now derived from the live tick cache
    // for market-style policies (MARKETABLE_LIMIT_IOC, REDUCE_MARKET):
    //   - LONG opens use the ask (taker price);
    //   - SHORT opens use the bid (taker price);
    //   - LONG exits (reduceOnly) hit the bid (sell to close); SHORT exits
    //     hit the ask (buy to close);
    //   - Fallback to `mark` then `last` then `(bid+ask)/2` when a side is
    //     missing — keeps the simulator deterministic against partial-quote
    //     ticks without ever producing a zero reference. The shared core's
    //     tier-floor slippage then applies on top.
    // POST_ONLY_MAKER is not currently selected by the R2c.C policy router;
    // when a future wave wires it, the intent's actual limit price (if
    // supplied) takes precedence over the derived reference.
    private translateToFillIntent(intent: IOrderIntent, snapshot: IFillSnapshot): IFillIntent {
        const action = this.translateAction(intent.intentAction);
        const policy = action === 'open' ? OrderPolicyEnum.MARKETABLE_LIMIT_IOC : OrderPolicyEnum.REDUCE_MARKET;
        const side = intent.tradeSide === PositionSideEnum.LONG ? 'long' : 'short';
        const reduceOnly = action === 'reduce' || action === 'close';
        const limitPrice = this.deriveReferencePrice(snapshot, side, reduceOnly);

        return {
            side,
            action,
            policy,
            limitPrice,
            qty: intent.quantity,
            postOnly: false,
            reduceOnly,
        };
    }

    // Pick the taker-side reference price from the live snapshot. Returned
    // as a decimal string so the shared core consumes it without conversion.
    // Defensive fallbacks: ask/bid → mark → last → midpoint. Never returns
    // "0"; if every field is missing or non-positive the call site has
    // already short-circuited to a `no_tick_cached` missed-fill upstream.
    private deriveReferencePrice(snapshot: IFillSnapshot, side: 'long' | 'short', reduceOnly: boolean): string {
        // Open LONG / close SHORT → hit ask. Open SHORT / close LONG → hit bid.
        const wantsAsk = (side === 'long' && !reduceOnly) || (side === 'short' && reduceOnly);
        const primary = wantsAsk ? snapshot.ask : snapshot.bid;
        const opposite = wantsAsk ? snapshot.bid : snapshot.ask;
        const candidates: ReadonlyArray<string> = [primary, snapshot.mark, snapshot.last, opposite];

        for (const candidate of candidates) {
            if (isPositiveDecimalString(candidate)) {
                return candidate;
            }
        }

        // All single fields unusable; try midpoint of bid+ask if both parsable.
        if (isPositiveDecimalString(snapshot.bid) && isPositiveDecimalString(snapshot.ask)) {
            const mid = new Decimal(snapshot.bid).plus(snapshot.ask).dividedBy(2);

            return mid.toFixed();
        }

        // Last-resort: pass through `mark` even if it failed the positivity
        // check above — the shared core's missed-fill path will see `0` and
        // mark the fill as missed rather than fabricating a price.
        return snapshot.mark;
    }

    private translateAction(intentAction: OrderIntentActionEnum): 'open' | 'reduce' | 'close' {
        if (intentAction === OrderIntentActionEnum.OPEN || intentAction === OrderIntentActionEnum.ADD) {
            return 'open';
        }

        if (intentAction === OrderIntentActionEnum.REDUCE) {
            return 'reduce';
        }

        // CLOSE + FLATTEN both collapse to a full close from the fill-model
        // perspective; the in-memory state owner distinguishes them via the
        // close-reason it stamps downstream.
        return 'close';
    }

    // When the StreamingFillAdapter has no recent tick for the symbol, the
    // simulator records a deterministic missed-fill into the ledger so a
    // SIGKILL replay returns the same outcome. The persisted payload uses the
    // same shape the shared core would have produced.
    private buildMissedFillForNoTick(nowMs: number): ISimulatedFillCore {
        return {
            filled: false,
            fillPrice: '0',
            qty: '0',
            feeUsdt: '0',
            slippagePct: '0',
            missedReason: 'no_tick_cached',
            lowFidelity: false,
            tsMs: nowMs,
        };
    }
}
