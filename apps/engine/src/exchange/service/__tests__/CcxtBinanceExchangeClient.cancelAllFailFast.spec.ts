/**
 * M11a R2a-fix-wave-2 Item 3 — MEDIUM (security) fix verification.
 *
 * `cancelAllOrders` MUST route through the rate-limiter in `fail-fast` mode
 * (same as `createOrder` / `cancelOrder` / `cancelOrderByClientId`). Under a
 * kill-switch burst with a saturated rate-limit bucket, an `await` mode
 * (30s wait) would stall the unwind exactly when fail-fast is needed.
 *
 * The previous `isOrderOp` predicate in `CcxtBinanceExchangeClient.descriptorFromTag`
 * only matched `createOrder` / `cancelOrder` / `cancelOrderByClientId`, so the
 * facade's `cancelAllOrders:<symbol>` tag routed via `await` (silent bug).
 * This spec asserts the IRateLimitedCall handed to `IRateLimitPolicy.acquire`
 * for `cancelAllOrdersForSymbol` is in fail-fast mode with `maxWaitMs=null`.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';

import { AppConfigService } from '../../../config/service';
import { IRateLimitPolicy, IRateLimitedCall } from '../../interface/IRateLimitPolicy';
import { ExchangeRateLimitExhaustedException } from '../../exception';
import { CcxtBinanceExchangeClient } from '../CcxtBinanceExchangeClient';

function buildAppConfig(): AppConfigService {
    // ccxt's binanceusdm constructor accepts empty strings; we never make a
    // network call (the rate-limiter throws before ccxt is reached).
    return {
        exchangeApiKey: 'test-key',
        exchangeApiSecret: 'test-secret',
        exchangeEnv: ExchangeEnvironmentEnum.TESTNET,
    } as unknown as AppConfigService;
}

interface ICapturingRateLimit extends IRateLimitPolicy {
    lastCall: IRateLimitedCall | null;
}

function buildCapturingRateLimit(throwOnAcquire: boolean): ICapturingRateLimit {
    const stub: ICapturingRateLimit = {
        lastCall: null,
        acquire: jest.fn(async (call: IRateLimitedCall) => {
            stub.lastCall = call;

            if (throwOnAcquire) {
                throw new ExchangeRateLimitExhaustedException('ORDERS_10S', 0, null);
            }
        }),
        reconcileFromHeaders: jest.fn(),
        snapshot: jest.fn(() => ({ classes: [] }) as never),
    } as unknown as ICapturingRateLimit;

    return stub;
}

describe('CcxtBinanceExchangeClient — cancelAllOrders fail-fast routing (R2a-fix-wave-2 Item 3)', () => {
    it('cancelAllOrdersForSymbol routes the rate-limited call in fail-fast mode (maxWaitMs=null, isOrderOp=true)', async () => {
        // BUILD — capturing limiter that throws so we never reach ccxt I/O
        const rateLimit = buildCapturingRateLimit(true);
        const client = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);

        // OPERATE — expect the rate-limit throw to surface (wrapped in
        // ExchangeRequestException by the callExchange boundary).
        await expect(client.cancelAllOrdersForSymbol('BTCUSDT')).rejects.toThrow();

        // CHECK — the IRateLimitedCall handed to acquire is fail-fast,
        // `isOrderOp=true`, and the operation tag matches the facade contract.
        expect(rateLimit.lastCall).not.toBeNull();
        expect(rateLimit.lastCall?.operation).toBe('cancelAllOrders');
        expect(rateLimit.lastCall?.isOrderOp).toBe(true);
        expect(rateLimit.lastCall?.mode).toBe('fail-fast');
        expect(rateLimit.lastCall?.maxWaitMs).toBeNull();
    });

    it('createOrder still routes fail-fast (regression guard against widening the predicate)', async () => {
        const rateLimit = buildCapturingRateLimit(true);
        const client = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);

        await expect(
            client.submitOrder({ symbol: 'BTCUSDT', type: 'market', side: 'buy', amount: '0.001', price: null, clientOrderId: 'cid-x' }),
        ).rejects.toThrow();

        expect(rateLimit.lastCall?.operation).toBe('createOrder');
        expect(rateLimit.lastCall?.mode).toBe('fail-fast');
    });

    it('fetchOrderByClientId continues to route in await mode (non-order read path)', async () => {
        const rateLimit = buildCapturingRateLimit(true);
        const client = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);

        await expect(client.fetchOrderByClientId('BTCUSDT', 'cid-x')).rejects.toThrow();

        expect(rateLimit.lastCall?.operation).toBe('fetchOrderByClientId');
        expect(rateLimit.lastCall?.mode).toBe('await');
        expect(rateLimit.lastCall?.maxWaitMs).toBe(30_000);
    });
});
