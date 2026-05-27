// Runtime guard exception for the D14 capability proxy (ADR 0032 §3 D14).
//
// Fires when a caller reaches `CcxtBinanceExchangeClient`'s residual
// account-state methods (`fetchBalance` / `fetchPositions` / `fetchOpenOrders`
// / `fetchFundingHistory`) without an active `AsyncLocalStorage` capability
// tag from one of the two whitelisted entry points:
//   1. `KeyPermissionAssertionService` (boot-time `/sapi` calls).
//   2. `ExchangeAccountStateSource` (LIVE/TESTNET port adapter).
//   3. `PaperExchangeNullityProbe` (future, D13).
//
// The static module-graph test is the first line of defence; this exception
// is the runtime line of defence against escape hatches the static check
// cannot see (`ModuleRef.get`, `useFactory(injector)`, `forwardRef`, …).

export class UnauthorizedLiveAccountStateCallException extends Error {
    constructor(method: string) {
        super(
            `unauthorized live account-state call '${method}': caller is not in the D14 capability allowlist (KeyPermissionAssertionService | ExchangeAccountStateSource | PaperExchangeNullityProbe). ` +
                `Inject 'IAccountStateSource' instead of 'IExchangeClient'. See ADR 0032 §3 D14.`,
        );
        this.name = 'UnauthorizedLiveAccountStateCallException';
    }
}
