// M11a R2a Item 5B adversarial test (ADR 0032 §3 D14).
//
// Asserts the runtime AsyncLocalStorage capability proxy on
// `CcxtBinanceExchangeClient`'s residual account-state methods. Two cases:
//
// 1. A synthetic caller that bypasses the static module graph (simulating
//    `ModuleRef.get(EXCHANGE_CLIENT)` or `forwardRef` escape) and calls
//    `fetchBalance` without an active capability tag — must throw
//    `UnauthorizedLiveAccountStateCallException`.
// 2. The same call wrapped in `runWithLiveAccountStateCapability(...)` — must
//    succeed (the guard is opt-in for the three whitelisted entry points:
//    KeyPermissionAssertionService, ExchangeAccountStateSource, PaperExchangeNullityProbe).
//
// The test exercises the guard at the assertion site directly (no Nest DI),
// which is the smallest faithful reproduction of "an attacker bypasses DI
// and calls the protected method." We rely on the real
// `assertActiveLiveAccountStateCapability` function being called from inside
// the real `CcxtBinanceExchangeClient.fetchBalance` (verified by direct
// source inspection in this file's final case — the string sentinel).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertActiveLiveAccountStateCapability, runWithLiveAccountStateCapability } from '../security';
import { UnauthorizedLiveAccountStateCallException } from '../exception';

describe('LiveAccountStateCapabilityGuard — D14 runtime guard', () => {
    it('throws UnauthorizedLiveAccountStateCallException when no capability is active', () => {
        expect(() => assertActiveLiveAccountStateCapability('fetchBalance')).toThrow(UnauthorizedLiveAccountStateCallException);
    });

    it('does not throw when wrapped in runWithLiveAccountStateCapability', async () => {
        await expect(
            runWithLiveAccountStateCapability('ExchangeAccountStateSource', async () => {
                assertActiveLiveAccountStateCapability('fetchBalance');

                return 'ok';
            }),
        ).resolves.toBe('ok');
    });

    it('capability tag is scoped to the awaited continuation; siblings without runWith throw', async () => {
        await runWithLiveAccountStateCapability('KeyPermissionAssertionService', async () => {
            assertActiveLiveAccountStateCapability('fetchBalance');
        });

        // After the runWith resolves the frame pops; a subsequent unwrapped
        // call from the same test sees no active capability and throws.
        expect(() => assertActiveLiveAccountStateCapability('fetchBalance')).toThrow(UnauthorizedLiveAccountStateCallException);
    });

    it('the four protected ccxt methods on CcxtBinanceExchangeClient call assertActiveLiveAccountStateCapability (source sentinel)', () => {
        // Defence in depth: a future refactor that drops the assertion from
        // one of the four protected methods would silently disarm the
        // runtime guard. A string sentinel against the source catches that
        // class of regression without standing up a live ccxt instance.
        const source = readFileSync(resolve(__dirname, '../../exchange/service/CcxtBinanceExchangeClient.ts'), 'utf8');

        for (const method of ['fetchBalance', 'fetchPositions', 'fetchOpenOrders', 'fetchFundingHistory']) {
            expect(source).toMatch(new RegExp(`assertActiveLiveAccountStateCapability\\('${method}'\\)`));
        }
    });
});
