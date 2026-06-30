import { IAccountStateSource } from '@bot/shared';

import { IMyTradeSnapshot } from './IExchangeSnapshots';

// M49 (ADR 0010 §1b/§1f amendment). Engine-local extension of the shared
// `IAccountStateSource` port that adds the closing-fill recovery read.
//
// The method returns the engine boundary type `IMyTradeSnapshot` (decimal-as-
// string), NOT a shared DTO — so it intentionally does NOT live on the shared
// `@bot/shared` port (whose methods all return shared DTOs). Both port adapters
// (`ExchangeAccountStateSource` LIVE/TESTNET, `PaperAccountStateSource` PAPER)
// implement this interface; the binding under the existing `ACCOUNT_STATE_SOURCE`
// token is unchanged. `ReconciliationService` injects this narrower type so it can
// call `fetchMyTrades` without a separate provider.
export interface IReconciliationAccountStateSource extends IAccountStateSource {
    // Account trade history for `symbol` in the window [`sinceMs`, `untilMs`]
    // (inclusive lower bound; optional inclusive upper bound). The upper bound confines
    // the read to a single position cycle so a later cycle's reducing fill on the same
    // symbol cannot be misattributed. LIVE delegates to the ccxt `fetchMyTrades` facade;
    // PAPER returns `[]` (PAPER never reaches the LIVE finalize path — it is inert by
    // construction).
    fetchMyTrades(symbol: string, sinceMs: number, untilMs?: number): Promise<readonly IMyTradeSnapshot[]>;
}
