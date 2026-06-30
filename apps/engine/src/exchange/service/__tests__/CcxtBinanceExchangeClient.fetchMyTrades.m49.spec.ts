/**
 * M49 — CcxtBinanceExchangeClient.fetchMyTrades facade tests.
 *
 * QA requirement covered: 3 (facade mapping + capability routing).
 *
 * Verifies:
 * - `toMyTradeSnapshot` maps a ccxt Trade to IMyTradeSnapshot correctly.
 * - `realizedPnl` is read from `trade.info.realizedPnl` (the Binance raw field).
 * - `IMyTradeSnapshot` has NO `reduceOnly` field (it is intentionally absent).
 * - The call routes through `callExchange` in 'await' mode (not fail-fast).
 * - `assertActiveLiveAccountStateCapability` guard is enforced — calling without
 *   a capability frame throws.
 *
 * All tests bypass the real ccxt network by spying on the internal ccxt client
 * after construction and using a pass-through rate-limit policy that never blocks.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import type { Trade } from 'ccxt';

import { AppConfigService } from '../../../config/service';
import { IMyTradeSnapshot } from '../../interface/IExchangeSnapshots';
import { IRateLimitPolicy, IRateLimitedCall } from '../../interface/IRateLimitPolicy';
import { runWithLiveAccountStateCapability } from '../../../paper-mode/security';
import { CcxtBinanceExchangeClient } from '../CcxtBinanceExchangeClient';

// ─── Test infrastructure ─────────────────────────────────────────────────────

function buildAppConfig(env = ExchangeEnvironmentEnum.TESTNET): AppConfigService {
    return {
        exchangeApiKey: 'test-key',
        exchangeApiSecret: 'test-secret',
        exchangeEnv: env,
    } as unknown as AppConfigService;
}

interface ICapturingRateLimit extends IRateLimitPolicy {
    lastCall: IRateLimitedCall | null;
}

/** Pass-through: allows the ccxt call to execute (never throws, never sleeps). */
function buildPassThroughRateLimit(): ICapturingRateLimit {
    const stub: ICapturingRateLimit = {
        lastCall: null,
        acquire: jest.fn(async (call: IRateLimitedCall) => {
            stub.lastCall = call;
        }),
        reconcileFromHeaders: jest.fn(),
        snapshot: jest.fn(() => ({ classes: [] }) as never),
    };
    return stub;
}

/** Builds a minimal ccxt Trade that mirrors Binance USDT-M `userTrades` shape. */
function buildCcxtTrade(overrides: Partial<Trade & { info?: Record<string, unknown> }> = {}): Trade {
    return {
        id: 'trade-id-1',
        order: 'order-id-1',
        symbol: 'BTC/USDT:USDT',
        side: 'sell' as 'buy' | 'sell',
        price: 31000,
        amount: 0.1,
        cost: 3100,
        fee: { cost: 0.3, currency: 'USDT' },
        timestamp: 1_705_296_000_000,
        info: {
            realizedPnl: '100.123456789',
            clientOrderId: null,
        },
        ...overrides,
    } as unknown as Trade;
}

// ─── Helper to access the private ccxt client instance ───────────────────────
function injectMockCcxtFetchMyTrades(exchangeClient: CcxtBinanceExchangeClient, trades: Trade[]): void {
    const inner = (exchangeClient as unknown as { client: { fetchMyTrades: jest.Mock } }).client;
    inner.fetchMyTrades = jest.fn().mockResolvedValue(trades);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CcxtBinanceExchangeClient.fetchMyTrades (M49 — QA3)', () => {
    let rateLimit: ICapturingRateLimit;
    let exchangeClient: CcxtBinanceExchangeClient;

    beforeEach(() => {
        rateLimit = buildPassThroughRateLimit();
        exchangeClient = new CcxtBinanceExchangeClient(buildAppConfig(), rateLimit);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // QA 3a — Mapper: each ccxt Trade field is correctly normalised into the
    // IMyTradeSnapshot boundary shape (decimal-as-string, never float).
    it('maps ccxt trade fields to IMyTradeSnapshot with decimal-as-string money values (QA3a)', async () => {
        // BUILD
        const ccxtTrade = buildCcxtTrade({
            id: 'trade-42',
            order: 'order-99',
            symbol: 'BTCUSDT',
            side: 'sell',
            price: 31000,
            amount: 0.1,
            cost: 3100,
            fee: { cost: 0.3, currency: 'USDT' },
            timestamp: 1_705_296_000_000,
            info: { realizedPnl: '100.5', clientOrderId: null },
        });
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE — must be inside a capability frame
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 1_705_200_000_000));

        // CHECK — one result, correct fields
        expect(results).toHaveLength(1);
        const snap: IMyTradeSnapshot = results[0];

        expect(snap.tradeId).toBe('trade-42');
        expect(snap.orderId).toBe('order-99');
        expect(snap.symbol).toBe('BTCUSDT');
        expect(snap.side).toBe('sell');
        // money fields must be strings, not numbers
        expect(typeof snap.price).toBe('string');
        expect(typeof snap.amount).toBe('string');
        expect(typeof snap.cost).toBe('string');
        expect(typeof snap.fee).toBe('string');
        expect(snap.feeCurrency).toBe('USDT');
        expect(snap.price).toBe('31000');
        expect(snap.amount).toBe('0.1');
        expect(snap.timestampMs).toBe(1_705_296_000_000);
    });

    // QA 3b — realizedPnl sourced from info.realizedPnl (the Binance raw field),
    // not from ccxt's unified structure (which does not carry it for userTrades).
    it('sources realizedPnl from trade.info.realizedPnl as decimal string (QA3b)', async () => {
        // BUILD
        const ccxtTrade = buildCcxtTrade({
            info: { realizedPnl: '123.456789', clientOrderId: null },
        });
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK — realizedPnl is the raw string from info
        expect(results[0].realizedPnl).toBe('123.456789');
        expect(typeof results[0].realizedPnl).toBe('string');
    });

    // QA 3b (complement) — when info.realizedPnl is absent, the mapper falls
    // back to '0' (entry-fill safe default).
    it('falls back to realizedPnl=0 when info.realizedPnl is absent (entry-fill default)', async () => {
        // BUILD
        const ccxtTrade = buildCcxtTrade({ info: {} }); // no realizedPnl in info
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK — defaults to '0' (entry fills are not filtering victims here)
        expect(results[0].realizedPnl).toBe('0');
    });

    // QA 3c — IMyTradeSnapshot intentionally has NO reduceOnly field.
    // /fapi/v1/userTrades does not return reduceOnly; including it would always
    // be null and break the closing-fill discriminator (H1 per plan).
    it('IMyTradeSnapshot returned by fetchMyTrades has no reduceOnly property (QA3c — H1)', async () => {
        // BUILD
        const ccxtTrade = buildCcxtTrade();
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK — reduceOnly MUST NOT be present on the snapshot
        expect(results[0]).not.toHaveProperty('reduceOnly');
    });

    // QA 3d — fetchMyTrades routes through callExchange in 'await' mode
    // (not fail-fast). Account-history reads are NOT order operations.
    it('routes through callExchange in await mode with maxWaitMs=30000 (QA3d — rate-limit routing)', async () => {
        // BUILD — capturing rate-limit (pass-through so ccxt spy succeeds)
        injectMockCcxtFetchMyTrades(exchangeClient, []);

        // OPERATE
        await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK — IRateLimitedCall is in 'await' mode (not fail-fast like order ops)
        expect(rateLimit.lastCall).not.toBeNull();
        expect(rateLimit.lastCall?.mode).toBe('await');
        expect(rateLimit.lastCall?.maxWaitMs).toBe(30_000);
        expect(rateLimit.lastCall?.isOrderOp).toBe(false);
    });

    // QA 3e — assertActiveLiveAccountStateCapability guard: calling fetchMyTrades
    // outside a capability frame must throw UnauthorizedLiveAccountStateCallException.
    it('throws when called without an active live account-state capability frame (QA3e — D14 guard)', async () => {
        // BUILD — no runWithLiveAccountStateCapability wrapper
        injectMockCcxtFetchMyTrades(exchangeClient, []);

        // OPERATE + CHECK — must throw the capability guard exception
        await expect(exchangeClient.fetchMyTrades('BTCUSDT', 0)).rejects.toThrow();
    });

    // Mapping edge: numeric realizedPnl in info (non-Binance venue fallback) is
    // coerced to string at the boundary so no float escapes to callers.
    it('coerces numeric info.realizedPnl to string (boundary decimal contract)', async () => {
        // BUILD — numeric value in info (some venues return number instead of string)
        const ccxtTrade = buildCcxtTrade({ info: { realizedPnl: 99.99 as unknown as string } });
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK — coerced to string, not a float
        expect(typeof results[0].realizedPnl).toBe('string');
        expect(results[0].realizedPnl).toBe('99.99');
    });

    // Mapping: clientOrderId is read from info.clientOrderId (absent on
    // /fapi/v1/userTrades → null is the expected value).
    it('sets clientOrderId to null when absent from info (userTrades endpoint contract)', async () => {
        // BUILD
        const ccxtTrade = buildCcxtTrade({ info: { realizedPnl: '0' } }); // no clientOrderId in info
        injectMockCcxtFetchMyTrades(exchangeClient, [ccxtTrade]);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK
        expect(results[0].clientOrderId).toBeNull();
    });

    // untilMs forwarding: when an upper bound is supplied it is forwarded to the
    // inner ccxt call as Binance `params.endTime` so the read is confined to this
    // position's cycle (a later cycle's reducing fill cannot be misattributed).
    it('forwards untilMs to the inner ccxt fetchMyTrades as params.endTime (QA — window upper bound)', async () => {
        // BUILD
        const untilMs = 1_705_300_000_000;
        injectMockCcxtFetchMyTrades(exchangeClient, []);
        const inner = (exchangeClient as unknown as { client: { fetchMyTrades: jest.Mock } }).client;

        // OPERATE
        await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 1_705_200_000_000, untilMs));

        // CHECK — the inner ccxt call received params.endTime = untilMs
        expect(inner.fetchMyTrades).toHaveBeenCalledWith('BTCUSDT', 1_705_200_000_000, undefined, { endTime: untilMs });
    });

    // Empty result: when ccxt returns [] the facade returns a readonly empty array.
    it('returns empty readonly array when ccxt fetchMyTrades returns no trades', async () => {
        // BUILD
        injectMockCcxtFetchMyTrades(exchangeClient, []);

        // OPERATE
        const results = await runWithLiveAccountStateCapability('ExchangeAccountStateSource', () => exchangeClient.fetchMyTrades('BTCUSDT', 0));

        // CHECK
        expect(results).toHaveLength(0);
    });
});
