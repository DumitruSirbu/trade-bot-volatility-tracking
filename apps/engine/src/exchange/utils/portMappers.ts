import { IBalance, IFunding, IOrder, IPosition } from '@bot/shared';

import { IBalanceSnapshot, IExchangeOrderSnapshot, IFundingPaymentSnapshot, IOpenOrderSnapshot, IPositionSnapshot } from '../interface';

// Engine-internal-snapshot -> shared-DTO mappers for the M11a R2a port surface
// (ADR 0032 §3 D2 + D14). The engine's `IExchangeSnapshots` types are the
// ccxt-shaped boundary; the shared `IOrder` / `IPosition` / `IBalance` /
// `IFunding` are the port-side DTOs. Both adapters (`CcxtExecutionClient`,
// `ExchangeAccountStateSource`) translate at the boundary so callers of the
// shared ports never see the engine-internal shapes.
//
// One file, one direction: every mapper here is engine-snapshot -> shared-DTO.
// The reverse direction (shared `IOrderIntent` -> engine ccxt request) is in
// `CcxtExecutionClient` itself because it needs the engine's amount/price
// quantisation context.

export function balanceSnapshotToBalance(snapshot: IBalanceSnapshot): IBalance {
    return {
        asset: snapshot.asset,
        free: snapshot.free,
        used: snapshot.used,
        total: snapshot.total,
    };
}

export function positionSnapshotToPosition(snapshot: IPositionSnapshot): IPosition {
    return {
        symbol: snapshot.symbol,
        side: snapshot.side,
        qty: snapshot.qty,
        entryPrice: snapshot.entryPrice,
        markPrice: snapshot.markPrice,
        liquidationPrice: snapshot.liquidationPrice,
        marginType: snapshot.marginType,
        leverage: snapshot.leverage,
        timestampMs: snapshot.timestampMs,
    };
}

// Shared `IOrder` carries more fields than the engine's `IOpenOrderSnapshot`
// (the latter is reconciliation-specific). Where the open-order snapshot omits
// fields (price, amount, filled, …), the shared DTO holds null — these reads
// surface on `IAccountStateSource.fetchOpenOrders`, where holders of the port
// only depend on identity + status, not on fill-level detail.
export function openOrderSnapshotToOrder(snapshot: IOpenOrderSnapshot): IOrder {
    return {
        exchangeOrderId: snapshot.exchangeOrderId,
        clientOrderId: snapshot.clientOrderId,
        symbol: snapshot.symbol,
        status: snapshot.status,
        type: snapshot.type,
        side: snapshot.side,
        reduceOnly: snapshot.reduceOnly,
        price: null,
        amount: null,
        filled: null,
        remaining: null,
        cost: null,
        average: null,
        fee: null,
        feeCurrency: null,
        timestampMs: snapshot.timestampMs,
    };
}

export function exchangeOrderSnapshotToOrder(snapshot: IExchangeOrderSnapshot): IOrder {
    return {
        exchangeOrderId: snapshot.exchangeOrderId,
        clientOrderId: snapshot.clientOrderId,
        symbol: snapshot.symbol,
        status: snapshot.status,
        type: snapshot.type,
        side: snapshot.side,
        reduceOnly: snapshot.reduceOnly,
        price: snapshot.price,
        amount: snapshot.amount,
        filled: snapshot.filled,
        remaining: snapshot.remaining,
        cost: snapshot.cost,
        average: snapshot.average,
        fee: snapshot.fee,
        feeCurrency: snapshot.feeCurrency,
        timestampMs: snapshot.timestampMs,
    };
}

export function fundingPaymentSnapshotToFunding(snapshot: IFundingPaymentSnapshot): IFunding {
    return {
        id: snapshot.id,
        symbol: snapshot.symbol,
        fundingTimeMs: snapshot.fundingTimeMs,
        amount: snapshot.amount,
        asset: snapshot.asset,
    };
}
