import { ExchangeEnvironmentEnum, IExecutionClient, IOrder, IOrderIntent as ISharedOrderIntent, OrderIntentActionEnum, PositionSideEnum } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/service';
import { ExchangeRequestException, PaperExecutionGuardException } from '../exception';
import { ICreateOrderRequest, IEngineExecutionClient, IExchangeOrderSnapshot } from '../interface';
import { exchangeOrderSnapshotToOrder } from '../utils';
import { CcxtBinanceExchangeClient } from './CcxtBinanceExchangeClient';

// LIVE / TESTNET order-command adapter (ADR 0032 §3 D2). Implements the shared
// `IExecutionClient` port and is the SOLE owner of the ccxt order surface
// (`createOrder`, `cancelOrder`, `fetchOrder`).
//
// Collaborates with `CcxtBinanceExchangeClient` via its typed facade methods
// (`submitOrder` / `cancelOrderByClientId` / `fetchOrderByClientId` /
// `cancelAllOrdersForSymbol` / `fetchOpenOrdersForSymbol`). The facades route
// through the same rate-limit + sanitization boundary the rest of the
// exchange surface uses. Direct raw-ccxt access is forbidden (the previous
// `internalRawClient` getter is now private to `CcxtBinanceExchangeClient`).
//
// PAPER mode binds `PaperExecutionClient` to the `EXECUTION_CLIENT` port
// token, but Nest still INSTANTIATES this concrete class under PAPER —
// the env-factory lists it in `inject:` so the DI graph constructs it
// unconditionally to pass to the selector. The constructor MUST therefore
// be side-effect-free under PAPER (no ccxt I/O happens in the ctor, so
// this is structurally true). Instead, every public order-command method
// ASSERTS `EXCHANGE_ENV !== PAPER` (M11a R2a HIGH H1 + R2a-fix-wave-2
// Item 1): a runtime config rebind or a future refactor that resolves
// this concrete via the port in PAPER would silently route orders to
// `fapi.binance.com`. The per-method guard fails loud at the first order.
//
// Deferred to R2c: `ExchangeOrderSubmitter` + `ProtectiveOrderAttacher`
// inject this class directly (not via the `EXECUTION_CLIENT` port). The
// proper architecture is to env-gate those callers OR migrate them to
// the shared port so the per-method guard becomes structurally
// unreachable. Today the per-method guards are the live defence.
//
// The shared `IOrderIntent` is the MINIMAL port-side intent shape; the
// engine-internal `IOrderIntent` (in `risk/interface/`) carries
// MoneyValue/sizing/IOpenPositionState and is consumed by the M5 execution
// loop directly via the legacy engine-shape methods on this class
// (`createOrder` + `cancelOrderByClientId` + `fetchOrderByClientId`). The
// shared-port `placeOrder` is the future PAPER swap-in surface; existing
// execution callers continue to use the engine-shape methods until their
// migration wave lands.

// M11a R4 Item 4C — also implements the engine-shape `IEngineExecutionClient`
// surface so the `ENGINE_EXECUTION_CLIENT` factory in ExchangeModule can
// dispatch on EXCHANGE_ENV without the callers caring which adapter is wired.
@Injectable()
export class CcxtExecutionClient implements IExecutionClient, IEngineExecutionClient {
    private readonly logger = new Logger(CcxtExecutionClient.name);

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly exchange: CcxtBinanceExchangeClient,
    ) {
        // Intentionally no-op (R2a-fix-wave-2 Item 1): Nest's env-factory
        // construction graph still instantiates this class under PAPER, so a
        // constructor assertion would crash the boot. The per-method guards
        // below enforce the "no live order under PAPER" invariant.
    }

    // ─── Shared `IExecutionClient` surface (ADR 0032 §3 D2) ────────────────
    //
    // Minimal intent -> ccxt mapping for the port-side caller. The engine's
    // M5 execution loop does NOT use this method today (it goes through the
    // engine-shape `createOrder` below to pass the richer engine intent
    // through); R2c migrates strategy/execution to the shared port.

    async placeOrder(intent: ISharedOrderIntent): Promise<IOrder> {
        this.assertNotPaperEnv('placeOrder');
        const request = this.sharedIntentToCreateRequest(intent);
        const snapshot = await this.createOrder(request);

        return exchangeOrderSnapshotToOrder(snapshot);
    }

    async cancelOrder(symbol: string, id: string): Promise<void> {
        this.assertNotPaperEnv('cancelOrder');
        await this.cancelOrderByClientId(symbol, id);
    }

    async cancelAllOrdersForSymbol(symbol: string): Promise<void> {
        this.assertNotPaperEnv('cancelAllOrdersForSymbol');
        await this.exchange.cancelAllOrdersForSymbol(symbol);
    }

    async fetchOrderStatus(symbol: string, id: string): Promise<IOrder> {
        this.assertNotPaperEnv('fetchOrderStatus');
        const snapshot = await this.fetchOrderByClientId(symbol, id);

        if (snapshot === null) {
            throw new ExchangeRequestException(`fetchOrderStatus:${symbol}:${id}`, 'order not found at exchange');
        }

        return exchangeOrderSnapshotToOrder(snapshot);
    }

    async fetchOpenOrders(symbol?: string): Promise<IOrder[]> {
        this.assertNotPaperEnv('fetchOpenOrders');
        const snapshots = await this.exchange.fetchOpenOrdersForSymbol(symbol);

        return snapshots.map((snapshot) => exchangeOrderSnapshotToOrder(snapshot));
    }

    // ─── Engine-shape order surface (extracted from CcxtBinanceExchangeClient) ───
    //
    // These signatures are consumed by the M5 ExecutionModule callers
    // (`ExchangeOrderSubmitter`, `ProtectiveOrderAttacher`). Identical behaviour
    // to the previous `CcxtBinanceExchangeClient.createOrder` etc. — only the
    // class home moved per ADR 0032 §3 D2.

    async createOrder(request: ICreateOrderRequest): Promise<IExchangeOrderSnapshot> {
        this.assertNotPaperEnv('createOrder');

        return this.exchange.submitOrder(request);
    }

    async fetchOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot | null> {
        this.assertNotPaperEnv('fetchOrderByClientId');

        return this.exchange.fetchOrderByClientId(symbol, clientOrderId);
    }

    async cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<IExchangeOrderSnapshot> {
        this.assertNotPaperEnv('cancelOrderByClientId');

        return this.exchange.cancelOrderByClientId(symbol, clientOrderId);
    }

    // M11a R2a HIGH H1 (ADR 0032 §3 D2). Fires at every public
    // order-command call (constructor guard dropped in R2a-fix-wave-2
    // Item 1 — Nest instantiates the class under PAPER for the env-factory
    // `inject:` list). PAPER mode binds
    // `PaperExecutionClient` to the `EXECUTION_CLIENT` port token via the
    // env-conditional factory in `ExchangeModule`, so this class is never
    // resolved through the port under PAPER. The two execution-side callers
    // (`ExchangeOrderSubmitter`, `ProtectiveOrderAttacher`) inject the
    // concrete class directly today; R2c migrates them to the shared port
    // and the per-method guard becomes structurally unreachable.
    private assertNotPaperEnv(context: string): void {
        if (this.appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER) {
            throw new PaperExecutionGuardException(context);
        }
    }

    private sharedIntentToCreateRequest(intent: ISharedOrderIntent): ICreateOrderRequest {
        // The shared port-side intent is the minimal cross-boundary shape (no
        // policy/limit/price context). The engine's M5 path passes the richer
        // engine-internal intent through `createOrder` directly; this mapping
        // exists for future shared-port callers (PAPER swap, off-engine
        // tooling) and applies a conservative market-order default with the
        // exchange-side `BUY` / `SELL` translation.
        //
        // ADR cross-reference (logic R2a M5): `clientOrderId = intent.eventId`
        // is a placeholder for the port-side path. The engine-shape callers
        // (`ExchangeOrderSubmitter`) mint the canonical `tbvt-…` id via the
        // M5 `ClientOrderIdFactory`; the shared-port `placeOrder` path is
        // unreachable today (R2a PaperExecutionClient throws, LIVE callers
        // use engine-shape `createOrder`). Subject to ClientOrderIdFactory
        // discipline alignment in R2c when shared-port callers go live.
        const side: 'buy' | 'sell' =
            intent.tradeSide === PositionSideEnum.LONG && isOpenOrAdd(intent.intentAction)
                ? 'buy'
                : intent.tradeSide === PositionSideEnum.SHORT && isOpenOrAdd(intent.intentAction)
                  ? 'sell'
                  : intent.tradeSide === PositionSideEnum.LONG
                    ? 'sell'
                    : 'buy';

        return {
            symbol: intent.symbol,
            type: 'market',
            side,
            amount: intent.quantity,
            price: null,
            clientOrderId: intent.eventId,
        };
    }
}

function isOpenOrAdd(action: OrderIntentActionEnum): boolean {
    return action === OrderIntentActionEnum.OPEN || action === OrderIntentActionEnum.ADD;
}
