import { AsyncLocalStorage } from 'node:async_hooks';

import { UnauthorizedLiveAccountStateCallException } from '../exception';

// D14 runtime guard (ADR 0032 §3 D14): capability-tagged `AsyncLocalStorage`
// proxy on `CcxtBinanceExchangeClient`'s residual account-state methods.
//
// Design:
//   - Each whitelisted entry point (`KeyPermissionAssertionService`,
//     `ExchangeAccountStateSource`, future `PaperExchangeNullityProbe`) wraps
//     its calls into the protected methods inside `runWithCapability(caller, fn)`.
//   - `assertActiveCapability(method)` is called inside the ccxt client's
//     account-state methods; if no capability is currently active in the
//     async context, it throws `UnauthorizedLiveAccountStateCallException`.
//   - The static module-graph test catches accidental constructor-injected
//     paths; this runtime guard catches escape hatches the static walk cannot
//     see (`ModuleRef.get`, `useFactory(injector)`, `forwardRef`).
//
// Why a module-scope singleton AsyncLocalStorage: Nest providers are
// constructed once per app; a per-instance ALS would lose context across
// the boundary. AsyncLocalStorage propagates across `await` continuations
// without requiring a context object to thread through the call chain.

export type LiveAccountStateCaller = 'KeyPermissionAssertionService' | 'ExchangeAccountStateSource' | 'PaperExchangeNullityProbe';

interface ICapabilityFrame {
    readonly caller: LiveAccountStateCaller;
}

// Module-scope singleton. AsyncLocalStorage is process-wide by design; the
// store value is the active capability frame for the current async context.
const capabilityStore = new AsyncLocalStorage<ICapabilityFrame>();

// Whitelisted entry points wrap their protected-method calls in this helper.
// The frame is auto-popped when `fn` settles (success or throw), so an
// uncaught exception cannot leave the capability dangling for an unrelated
// continuation that the same async context might later reach.
export function runWithLiveAccountStateCapability<T>(caller: LiveAccountStateCaller, fn: () => Promise<T>): Promise<T> {
    return capabilityStore.run({ caller }, fn);
}

// Called inside `CcxtBinanceExchangeClient`'s residual account-state methods
// (`fetchBalance` / `fetchPositions` / `fetchOpenOrders` / `fetchFundingHistory`)
// at the very start, before the ccxt call. No active frame -> throw.
export function assertActiveLiveAccountStateCapability(method: string): void {
    const frame = capabilityStore.getStore();

    if (frame === undefined) {
        throw new UnauthorizedLiveAccountStateCallException(method);
    }
}

// Test-only inspector — returns the active caller tag, or null if none.
// Useful for the adversarial test that asserts the static module-graph
// allowlist matches the runtime allowlist.
export function activeLiveAccountStateCaller(): LiveAccountStateCaller | null {
    return capabilityStore.getStore()?.caller ?? null;
}
