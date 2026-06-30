import { IBalance, IFunding, IOrder, IPosition } from '@bot/shared';
import { Inject, Injectable } from '@nestjs/common';

import { runWithLiveAccountStateCapability } from '../../paper-mode/security';
import { EXCHANGE_CLIENT, IExchangeClient, IMyTradeSnapshot, IReconciliationAccountStateSource } from '../interface';
import { balanceSnapshotToBalance, fundingPaymentSnapshotToFunding, openOrderSnapshotToOrder, positionSnapshotToPosition } from '../utils';

// LIVE / TESTNET adapter for the shared `IAccountStateSource` port (ADR 0032 §3 D14).
//
// Delegates to `CcxtBinanceExchangeClient`'s residual account-state methods,
// mapping engine snapshot shapes -> shared DTOs at the boundary. Bound for
// `EXCHANGE_ENV` ∈ {LIVE, TESTNET}; in PAPER mode `PaperAccountStateSource`
// takes the same port token so this class is never instantiated.
//
// Every protected-method call is wrapped in `runWithLiveAccountStateCapability`
// — the AsyncLocalStorage capability tag that the D14 runtime guard checks at
// the ccxt-client boundary. This adapter is one of the three whitelisted entry
// points (sibling to `KeyPermissionAssertionService` and the future
// `PaperExchangeNullityProbe`).
//
// Filter convention: the ccxt client already drops zero-quantity position
// snapshots at the boundary (M6 W4a), so no additional filtering happens
// here. The `symbol` parameter on `fetchPositions` / `fetchOpenOrders` is
// accepted for the shared-port surface but not yet plumbed — the ccxt
// methods currently return the full account scope, which the existing
// callers consume.

@Injectable()
export class ExchangeAccountStateSource implements IReconciliationAccountStateSource {
    constructor(@Inject(EXCHANGE_CLIENT) private readonly exchange: IExchangeClient) {}

    async fetchBalance(): Promise<IBalance[]> {
        return runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
            const snapshots = await this.exchange.fetchBalance();

            return snapshots.map(balanceSnapshotToBalance);
        });
    }

    async fetchPositions(symbol?: string): Promise<IPosition[]> {
        return runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
            const snapshots = await this.exchange.fetchPositions();
            const mapped = snapshots.map(positionSnapshotToPosition);

            return symbol === undefined ? mapped : mapped.filter((position) => position.symbol === symbol);
        });
    }

    async fetchOpenOrders(symbol?: string): Promise<IOrder[]> {
        return runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
            const snapshots = await this.exchange.fetchOpenOrders();
            const mapped = snapshots.map(openOrderSnapshotToOrder);

            return symbol === undefined ? mapped : mapped.filter((order) => order.symbol === symbol);
        });
    }

    async fetchFundingHistory(symbol: string, since: number): Promise<IFunding[]> {
        return runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
            const snapshots = await this.exchange.fetchFundingHistory(symbol, since);

            return snapshots.map(fundingPaymentSnapshotToFunding);
        });
    }

    // M49 (ADR 0010 §1b/§1f amendment). Closing-fill recovery for the
    // RECONCILED_MISSING finalize path. Returns the engine `IMyTradeSnapshot`
    // directly (decimal-as-string) — no shared-DTO mapping, since realized PnL +
    // per-order aggregation are engine-internal. Wrapped in the D14 capability frame
    // like every other account-state read on this adapter.
    async fetchMyTrades(symbol: string, sinceMs: number, untilMs?: number): Promise<readonly IMyTradeSnapshot[]> {
        return runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
            return this.exchange.fetchMyTrades(symbol, sinceMs, untilMs);
        });
    }
}
