/**
 * M12 post-live-smoke fix — Bug 3 verification.
 *
 * `CcxtBinanceExchangeClient.close()` is invoked from NestJS lifecycle
 * `onModuleDestroy()`. Previously it routed through `callExchange('close', ...)`,
 * which required a `'close'` entry in `OPERATION_REQUEST_WEIGHTS` and threw on
 * teardown when the entry was absent — leaking a stack trace + exit code 1.
 *
 * The fix bypasses the rate-limiter on teardown (no HTTP weight is consumed
 * by a local connection-close). This spec proves that `onModuleDestroy()`
 * never throws even when the rate-limit policy would reject the operation.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';

import { AppConfigService } from '../../../src/config/service';
import { IRateLimitPolicy } from '../../../src/exchange/interface/IRateLimitPolicy';
import { CcxtBinanceExchangeClient } from '../../../src/exchange/service/CcxtBinanceExchangeClient';

function buildAppConfig(): AppConfigService {
    return {
        exchangeApiKey: 'test-key',
        exchangeApiSecret: 'test-secret',
        exchangeEnv: ExchangeEnvironmentEnum.TESTNET,
    } as unknown as AppConfigService;
}

function buildRateLimitThatThrowsOnAcquire(): IRateLimitPolicy {
    return {
        acquire: jest.fn(async () => {
            throw new Error('GUARD BREACH: close() must not call rate-limit acquire() on teardown');
        }),
        reconcileFromHeaders: jest.fn(),
        snapshot: jest.fn(() => ({ classes: [] }) as never),
    } as unknown as IRateLimitPolicy;
}

describe('CcxtBinanceExchangeClient — onModuleDestroy teardown (M12 post-live-smoke Bug 3)', () => {
    it('onModuleDestroy() bypasses the rate-limit policy and does not throw', async () => {
        const rateLimit = buildRateLimitThatThrowsOnAcquire();
        const client = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);

        await expect(client.onModuleDestroy()).resolves.toBeUndefined();
        expect(rateLimit.acquire).not.toHaveBeenCalled();
    });

    it('close() swallows ccxt-side errors during teardown (logs only, does not propagate)', async () => {
        const rateLimit = buildRateLimitThatThrowsOnAcquire();
        const client = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);

        // Force the underlying ccxt client.close() to reject — teardown should still resolve.
        const ccxtClient = (client as unknown as { client: { close: () => Promise<void> } }).client;
        ccxtClient.close = jest.fn(async () => {
            throw new Error('simulated ccxt connection teardown failure');
        });

        await expect(client.close()).resolves.toBeUndefined();
    });
});
