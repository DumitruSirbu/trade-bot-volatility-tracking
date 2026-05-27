// M11a R2a HIGH H1 (ADR 0032 §3 D2 + trading-safety invariant).
//
// Belt-and-braces guard for `CcxtExecutionClient`. The class is the LIVE/
// TESTNET adapter for the shared `IExecutionClient` port; under
// `EXCHANGE_ENV === PAPER` the env-conditional factory in `ExchangeModule`
// binds `PaperExecutionClient` to the port token, so this concrete is never
// resolved through the port. But two execution-side callers
// (`ExchangeOrderSubmitter`, `ProtectiveOrderAttacher`) inject the concrete
// class directly today — without this guard, a runtime config rebind or a
// future refactor that resolves the concrete in PAPER would silently route
// orders to `fapi.binance.com` (LIVE host).
//
// The guard fires in every public order-command method (R2a-fix-wave-2
// Item 1: a constructor guard was dropped because Nest's env-factory
// `inject:` list instantiates this class under PAPER). The per-method
// assertion is the live defence against a routing/refactor bug that
// resolves the concrete in PAPER and tries to place a real order.
//
// R2c lands the migration: once `ExchangeOrderSubmitter` and
// `ProtectiveOrderAttacher` consume the shared `IExecutionClient` port,
// only the env-conditional factory chooses the concrete and the second
// guard becomes structurally unreachable.

export class PaperExecutionGuardException extends Error {
    constructor(context: string) {
        super(
            `CcxtExecutionClient invoked under EXCHANGE_ENV=paper at '${context}'. PAPER mode MUST NOT reach the live exchange order surface; ` +
                `PaperExecutionClient is the bound adapter. R2c migrates ExchangeOrderSubmitter + ProtectiveOrderAttacher to the shared IExecutionClient port. ` +
                `See ADR 0032 §3 D2 + trading-safety invariant "no order path bypasses the risk gate."`,
        );
        this.name = 'PaperExecutionGuardException';
    }
}
