import {
    CoinTierEnum,
    CorrelationModeEnum,
    FlowTypeEnum,
    IExecutionClient,
    IOrder,
    IOrderIntent,
    ISimulatedFillCore,
    OrderIntentActionEnum,
    OrderPolicyEnum,
    PositionSideEnum,
} from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AppConfigService } from '../../config/service';
import { ICreateOrderRequest, IEngineExecutionClient, IExchangeOrderSnapshot } from '../../exchange/interface';
import {
    PAPER_ACTIVE_VERSION_NAMESPACE_NONE,
    PAPER_ACTIVE_VERSION_NAMESPACE_PREFIX,
    PAPER_DEFAULT_COIN_TIER_LABEL,
    PAPER_EXCHANGE_ORDER_ID_PREFIX,
} from '../const';
import { PaperModeNotImplementedException } from '../exception';
import { PaperSimulatorIdempotencyRepository } from '../repository/PaperSimulatorIdempotencyRepository';
import { PaperFillSimulator, IPaperSimulatorContext } from './PaperFillSimulator';

// PAPER adapter for the shared `IExecutionClient` port (ADR 0032 §3 D2).
//
// R2c.C real implementation. Routes `placeOrder` to `PaperFillSimulator`
// which (a) computes the deterministic per-order seed, (b) consults the
// `paper_simulator_idempotency` ledger before rolling, (c) delegates to the
// shared `FillSimulatorCore` via `StreamingFillAdapter`, and (d) records the
// resulting fill (or missed-fill) so SIGKILL replay returns the same answer.
//
// The other order-lifecycle methods (cancel / fetch-status / fetch-open) are
// no-ops or thin reads against the idempotency ledger because PAPER's fill
// policies (marketable-limit-IOC, post-only-maker collapsing to immediate-or-
// cancel, reduce-market) NEVER leave a resting order. SL/TP are evaluated
// intra-bar by `StreamingFillAdapter` rather than placed as resting
// protective orders. Per D2 this matches the LIVE `CcxtExecutionClient`
// shape so the M5 execution loop is mode-agnostic at the port boundary.
//
// COMPILE-TIME INVARIANTS (ADR 0032 §2 D2):
//   - MUST NOT import `RateLimitPolicyService` — the rate-limit token bucket
//     is a LIVE/TESTNET-only concern. The R2a.5 module-graph sentinel
//     fails the build if this constraint is ever silently violated.
//   - MUST NOT import any ccxt module — PAPER orders never leave the process.
//
// CONTEXT-THREADING DECISION (R2c.C scoping question):
//   The shared `IOrderIntent` is FROZEN per D2 and does NOT carry
//   `orderIntentId` or `versionNamespace`. Rather than mutate the shared
//   interface, this client derives both internally:
//     - `eventId`         → from `intent.eventId` (already on the shared shape).
//     - `orderIntentId`   → SHA-256 of a stable hash of intent fields so a
//                            SIGKILL replay of the same intent re-derives the
//                            same id from the persisted decision row.
//     - `versionNamespace` → `paper.active.v<ACTIVE_VERSION_ID>` where the id
//                            is the actually-executing version (legacy single-
//                            symbol id when set, else the M50 portfolio id;
//                            ADR 0047/0049), so shadow versions (R2d future)
//                            get distinct namespaces per D17 without coupling
//                            to a yet-to-land shadow-evaluator runtime.
//   This keeps shared/ untouched; if a future wave needs cross-process
//   `orderIntentId` parity (e.g. for cross-version comparison tooling), the
//   shared `IOrderIntent` would need an architect-adjudicated extension.
//   Flagged in the work-log as a future shared-side discussion item.

// M11a R4 Item 5: `PAPER_DEFAULT_COIN_TIER_LABEL` and
// `PAPER_EXCHANGE_ORDER_ID_PREFIX` were relocated to
// `paper-mode/const/paperFillSimulatorConsts.ts`. We re-resolve the enum
// from the string label here so the const file stays free of the
// CoinTierEnum dependency.
const PAPER_DEFAULT_COIN_TIER: CoinTierEnum = CoinTierEnum[PAPER_DEFAULT_COIN_TIER_LABEL as keyof typeof CoinTierEnum];

// M11a R4 Item 4C — also implements the engine-shape `IEngineExecutionClient`
// surface so the `ENGINE_EXECUTION_CLIENT` factory in ExchangeModule selects
// THIS class under PAPER. Without it, `ExchangeOrderSubmitter` /
// `ProtectiveOrderAttacher` injected `CcxtExecutionClient` concretely, which
// throws `PaperExecutionGuardException` at every order call under PAPER —
// PaperExecutionClient was structurally unreachable and the PAPER soak could
// not actually trade. The engine-shape methods below build a synthetic
// shared `IOrderIntent` from the engine-shape request and route through the
// shared port `placeOrder` so both surfaces produce numerically equivalent
// fills for the same intent shape.
@Injectable()
export class PaperExecutionClient implements IExecutionClient, IEngineExecutionClient {
    private readonly logger = new Logger(PaperExecutionClient.name);

    constructor(
        private readonly simulator: PaperFillSimulator,
        private readonly idempotencyRepo: PaperSimulatorIdempotencyRepository,
        private readonly appConfig: AppConfigService,
    ) {}

    async placeOrder(intent: IOrderIntent): Promise<IOrder> {
        const context = this.buildSimulatorContext(intent);
        const nowMs = Date.now();
        const result = await this.simulator.simulateFill(intent, context, PAPER_DEFAULT_COIN_TIER, nowMs);

        this.logger.log(
            `PAPER placeOrder event_id=${context.eventId} symbol=${intent.symbol} ` +
                `intent=${intent.intentAction} side=${intent.tradeSide} qty=${intent.quantity} ` +
                `filled=${result.fill.filled} fill_id=${result.simulatedFillId}`,
        );

        return this.mapFillToOrder(intent, context, result.fill, result.simulatedFillId);
    }

    // PAPER does not maintain resting orders — `cancelOrder` is a no-op.
    // Documented rather than thrown so a strategy/risk caller running under
    // PAPER doesn't crash on a defensive cancel (e.g. on a halt drain).
    async cancelOrder(symbol: string, id: string): Promise<void> {
        this.logger.debug(`PAPER cancelOrder (no-op) symbol=${symbol} id=${id}`);
    }

    // Same rationale as `cancelOrder` — no resting orders, nothing to cancel.
    async cancelAllOrdersForSymbol(symbol: string): Promise<void> {
        this.logger.debug(`PAPER cancelAllOrdersForSymbol (no-op) symbol=${symbol}`);
    }

    // PAPER's order status is the persisted fill from the idempotency ledger.
    // The caller passes the simulated-fill-id (what `placeOrder` returned as
    // `exchangeOrderId`); we look it up by id rather than by composite key
    // because the caller only has the surfaced order id, not the composite
    // simulator key.
    async fetchOrderStatus(symbol: string, id: string): Promise<IOrder> {
        const fillId = this.stripPaperPrefix(id);
        // We don't index the ledger by `simulated_fill_id` today (the unique
        // constraint lives on the composite key per D3). The R2a / R2b
        // surface treats the cancel/status methods as thin compatibility
        // shims; until R2c.D wires the M5 execution loop, the realistic
        // caller path is "placeOrder returns IOrder, the caller doesn't
        // re-fetch by id." Returning a typed error message keeps the path
        // failure-loud rather than silently returning a stale stub.
        throw new PaperModeNotImplementedException(
            `fetchOrderStatus(symbol=${symbol}, fill_id=${fillId}) — PAPER fills resolve synchronously inside placeOrder; ` +
                'the caller should consume the placeOrder result directly. A by-id ledger reader lands when the M5 execution loop is migrated.',
        );
    }

    // PAPER never holds resting orders — return empty so any reconciliation
    // path bound to this port sees a consistent (empty) open-orders view.
    async fetchOpenOrders(_symbol?: string): Promise<IOrder[]> {
        return [];
    }

    // ─── Engine-shape `IEngineExecutionClient` surface (M11a R4 Item 4C) ──
    //
    // The M5 execution loop consumes `ICreateOrderRequest` and produces
    // `IExchangeOrderSnapshot`. Under PAPER we route through the simulator
    // (same idempotency ledger as `placeOrder`) and map back to the engine
    // shape so ExchangeOrderSubmitter / ProtectiveOrderAttacher are
    // mode-agnostic.

    async createOrder(request: ICreateOrderRequest): Promise<IExchangeOrderSnapshot> {
        const intent = this.engineRequestToSharedIntent(request);
        const context = this.buildSimulatorContext(intent);
        const nowMs = Date.now();
        const result = await this.simulator.simulateFill(intent, context, PAPER_DEFAULT_COIN_TIER, nowMs);

        this.logger.log(
            `PAPER engine-shape createOrder clientOrderId=${request.clientOrderId} symbol=${request.symbol} ` +
                `side=${request.side} type=${request.type} qty=${request.amount} ` +
                `filled=${result.fill.filled} fill_id=${result.simulatedFillId}`,
        );

        return this.mapFillToExchangeSnapshot(request, result.fill, result.simulatedFillId);
    }

    // Engine callers fetch by clientOrderId post-submit; PAPER fills resolve
    // synchronously inside `createOrder`, so there is no resting order to
    // re-fetch. Returns `null` — the engine's recovery path treats null as
    // "exchange has no such order", which is structurally true for PAPER.
    async fetchOrderByClientId(_symbol: string, _clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        return null;
    }

    // PAPER has no resting orders to cancel; we synthesise a CANCELED-status
    // snapshot so the caller's contract (cancelOrderByClientId returns the
    // post-cancel snapshot) is satisfied without throwing.
    async cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot> {
        this.logger.debug(`PAPER cancelOrderByClientId (no-op) symbol=${symbol} clientOrderId=${clientOrderId}`);

        return {
            exchangeOrderId: `${PAPER_EXCHANGE_ORDER_ID_PREFIX}cancel:${clientOrderId}`,
            clientOrderId,
            symbol,
            status: 'canceled',
            type: 'limit',
            side: 'buy',
            reduceOnly: false,
            price: null,
            average: null,
            amount: null,
            filled: '0',
            remaining: null,
            cost: null,
            fee: null,
            feeCurrency: 'USDT',
            timestampMs: Date.now(),
        };
    }

    // ----- internals -----

    // Translate the engine-shape `ICreateOrderRequest` into the minimal
    // shared `IOrderIntent` the simulator consumes. Many fields the shared
    // intent carries (signalScore, flowType, coinTier, idiosyncrasyScore,
    // correlationMode) are decision-loop metadata that the engine-shape
    // request does NOT surface — we stub them with conservative defaults
    // because the simulator does not consume them for fill resolution
    // (strategy metadata drives risk gating upstream of execution per the
    // shared `IFillIntent` translation in PaperFillSimulator).
    private engineRequestToSharedIntent(request: ICreateOrderRequest): IOrderIntent {
        const reduceOnly = Boolean(request.params?.reduceOnly) || Boolean(request.params?.closePosition);
        const intentAction = this.deriveIntentAction(request.side, reduceOnly);
        const tradeSide = this.deriveTradeSide(request.side, reduceOnly);

        return {
            intentAction,
            symbol: request.symbol,
            // `clientOrderId` is the engine's deterministic id; the simulator's
            // idempotency ledger keys on (eventId, orderIntentId, namespace),
            // so seeding eventId from clientOrderId guarantees a SIGKILL
            // replay re-derives the same simulator-context.
            eventId: request.clientOrderId,
            tradeSide,
            signalScore: 0,
            correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
            coinTier: PAPER_DEFAULT_COIN_TIER,
            idiosyncrasyScore: 0,
            quantity: request.amount,
            flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
        };
    }

    private deriveIntentAction(side: string, reduceOnly: boolean): OrderIntentActionEnum {
        if (reduceOnly) {
            return OrderIntentActionEnum.CLOSE;
        }

        // Engine-shape `side` is 'buy' | 'sell'; the engine never distinguishes
        // OPEN vs ADD at this boundary — the M5 caller already knows. Default
        // to OPEN; an ADD scenario in PAPER hashes identically against the
        // idempotency ledger by clientOrderId so the distinction does not
        // affect replay determinism.
        return OrderIntentActionEnum.OPEN;
    }

    private deriveTradeSide(side: string, reduceOnly: boolean): PositionSideEnum {
        // ccxt-side 'buy' on entry → LONG; 'sell' on entry → SHORT.
        // On a reduceOnly close: 'sell' closes a LONG; 'buy' closes a SHORT.
        if (reduceOnly) {
            return side === 'sell' ? PositionSideEnum.LONG : PositionSideEnum.SHORT;
        }

        return side === 'buy' ? PositionSideEnum.LONG : PositionSideEnum.SHORT;
    }

    private mapFillToExchangeSnapshot(request: ICreateOrderRequest, fill: ISimulatedFillCore, simulatedFillId: string): IExchangeOrderSnapshot {
        const status = fill.filled ? 'closed' : 'canceled';
        const exchangeOrderId = `${PAPER_EXCHANGE_ORDER_ID_PREFIX}${simulatedFillId}`;
        const reduceOnly = Boolean(request.params?.reduceOnly) || Boolean(request.params?.closePosition);

        return {
            exchangeOrderId,
            clientOrderId: request.clientOrderId,
            symbol: request.symbol,
            status,
            type: request.type,
            side: request.side,
            reduceOnly,
            price: fill.fillPrice,
            average: fill.filled ? fill.fillPrice : null,
            amount: request.amount,
            filled: fill.qty,
            remaining: fill.filled ? '0' : request.amount,
            cost: fill.filled ? this.computeCost(fill.fillPrice, fill.qty) : null,
            fee: fill.feeUsdt,
            feeCurrency: 'USDT',
            timestampMs: fill.tsMs,
        };
    }

    // ----- shared-port helpers (unchanged) -----

    private buildSimulatorContext(intent: IOrderIntent): IPaperSimulatorContext {
        return {
            eventId: intent.eventId,
            orderIntentId: this.deriveOrderIntentId(intent),
            versionNamespace: this.resolveVersionNamespace(),
        };
    }

    // SHA-256 over a stable, ordered serialization of intent fields. The hash
    // input mirrors the simulator's seed-input shape (separator-delimited so
    // catenation ambiguity cannot collide two distinct intents); the digest
    // is the engine-side stable identifier for an order intent that did not
    // arrive with one already assigned.
    private deriveOrderIntentId(intent: IOrderIntent): string {
        const hasher = createHash('sha256');
        const separator = Buffer.from([0x1f]);
        hasher.update(Buffer.from(intent.eventId, 'utf8'));
        hasher.update(separator);
        hasher.update(Buffer.from(intent.symbol, 'utf8'));
        hasher.update(separator);
        hasher.update(Buffer.from(intent.intentAction, 'utf8'));
        hasher.update(separator);
        hasher.update(Buffer.from(intent.tradeSide, 'utf8'));
        hasher.update(separator);
        hasher.update(Buffer.from(intent.quantity, 'utf8'));

        return hasher.digest('hex');
    }

    // `paper.active.v<id>` namespace per D17 — distinct from any shadow
    // version's namespace so the idempotency-ledger composite key cannot
    // collide between active and shadow runs, and encodes which strategy
    // version actually executed the order.
    //
    // ADR 0049 made the legacy single-symbol version id nullable (the VWAP
    // path boots dormant), and M50 (ADR 0047) added the portfolio version id.
    // We namespace on whichever version is actually active: the legacy id when
    // set (it is the executing strategy in that case), otherwise the portfolio
    // id. Only when genuinely neither is set do we fall back to an explicit
    // sentinel — never the literal `vnull` that would silently defeat the
    // version-encoding purpose of the namespace.
    private resolveVersionNamespace(): string {
        const activeVersionId = this.resolveActiveVersionId();
        const versionLabel = activeVersionId ?? PAPER_ACTIVE_VERSION_NAMESPACE_NONE;

        return `${PAPER_ACTIVE_VERSION_NAMESPACE_PREFIX}${versionLabel}`;
    }

    private resolveActiveVersionId(): number | null {
        return this.appConfig.activeStrategyVersionId ?? this.appConfig.activePortfolioStrategyVersionId;
    }

    private mapFillToOrder(intent: IOrderIntent, context: IPaperSimulatorContext, fill: ISimulatedFillCore, simulatedFillId: string): IOrder {
        const status = fill.filled ? 'closed' : 'canceled';
        const exchangeOrderId = `${PAPER_EXCHANGE_ORDER_ID_PREFIX}${simulatedFillId}`;
        const action = intent.intentAction;
        const reduceOnly = action === OrderIntentActionEnum.REDUCE || action === OrderIntentActionEnum.CLOSE || action === OrderIntentActionEnum.FLATTEN;
        const ccxtSide = this.deriveCcxtSide(intent.tradeSide, reduceOnly);
        const type = this.deriveOrderTypeLabel(action);

        return {
            exchangeOrderId,
            clientOrderId: context.orderIntentId,
            symbol: intent.symbol,
            status,
            type,
            side: ccxtSide,
            reduceOnly,
            price: fill.fillPrice,
            amount: intent.quantity,
            filled: fill.qty,
            remaining: fill.filled ? '0' : intent.quantity,
            cost: fill.filled ? this.computeCost(fill.fillPrice, fill.qty) : null,
            average: fill.filled ? fill.fillPrice : null,
            fee: fill.feeUsdt,
            feeCurrency: 'USDT',
            timestampMs: fill.tsMs,
        };
    }

    private deriveCcxtSide(tradeSide: PositionSideEnum, reduceOnly: boolean): string {
        const isLong = tradeSide === PositionSideEnum.LONG;

        if (reduceOnly) {
            // Exit a long → sell; exit a short → buy.
            return isLong ? 'sell' : 'buy';
        }

        return isLong ? 'buy' : 'sell';
    }

    private deriveOrderTypeLabel(action: OrderIntentActionEnum): string {
        if (action === OrderIntentActionEnum.OPEN || action === OrderIntentActionEnum.ADD) {
            return OrderPolicyEnum.MARKETABLE_LIMIT_IOC;
        }

        return OrderPolicyEnum.REDUCE_MARKET;
    }

    private computeCost(fillPrice: string, qty: string): string {
        // String multiplication via Number is acceptable for the cosmetic
        // `cost` field — the load-bearing money math has already produced
        // `fillPrice` and `qty` via `decimal.js`. Documented: if `cost` ever
        // becomes load-bearing for downstream callers, swap to Decimal.
        const product = Number(fillPrice) * Number(qty);

        return Number.isFinite(product) ? product.toString() : '0';
    }

    private stripPaperPrefix(id: string): string {
        if (id.startsWith(PAPER_EXCHANGE_ORDER_ID_PREFIX)) {
            return id.slice(PAPER_EXCHANGE_ORDER_ID_PREFIX.length);
        }

        return id;
    }
}
