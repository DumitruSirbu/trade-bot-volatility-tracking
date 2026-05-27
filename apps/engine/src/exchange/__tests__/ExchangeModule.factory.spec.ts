/**
 * M11a R2a Item 5 — env-conditional factory test (ADR 0032 §3 D2 + D14).
 *
 * Asserts the `EXECUTION_CLIENT` and `ACCOUNT_STATE_SOURCE` port factories in
 * `ExchangeModule` dispatch on `EXCHANGE_ENV`:
 *   - TESTNET / LIVE -> CcxtExecutionClient + ExchangeAccountStateSource.
 *   - PAPER          -> PaperExecutionClient + PaperAccountStateSource.
 *
 * R2a-fix-wave-2 Item 4: previous version mirrored the dispatch in a local
 * `buildPortFactories` helper, so a `useFactory` edit could diverge silently.
 * This version reads the REAL provider entries off `ExchangeModule.providers`
 * via Nest's `MODULE_METADATA.PROVIDERS` reflection key, locates the
 * `EXECUTION_CLIENT` / `ACCOUNT_STATE_SOURCE` factory entries, and INVOKES
 * `useFactory` directly with stubbed dependencies. A future edit to either
 * factory's dispatch MUST update this test — the harness is the production
 * code path.
 *
 * Standing up a full Nest `TestingModule` would force resolving
 * `CcxtBinanceExchangeClient`, whose constructor instantiates ccxt's
 * `binanceusdm` (network + API keys + URL selection); that is out of scope
 * for a unit test.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { AppConfigService } from '../../config/service';
import { PaperAccountStateSource, PaperExecutionClient } from '../../paper-mode/service';
import { PaperExecutionGuardException } from '../exception';
import { ACCOUNT_STATE_SOURCE, ENGINE_EXECUTION_CLIENT, EXECUTION_CLIENT } from '../interface';
import { CcxtBinanceExchangeClient, CcxtExecutionClient, ExchangeAccountStateSource } from '../service';
import { ExchangeModule } from '../ExchangeModule';

interface IFactoryProvider {
    provide: symbol | string;
    useFactory: (...args: unknown[]) => unknown;
    inject?: unknown[];
}

function readProviders(): IFactoryProvider[] {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ExchangeModule) as unknown[] | undefined;

    if (providers === undefined) {
        throw new Error('ExchangeModule providers metadata missing');
    }

    return providers.filter(
        (entry): entry is IFactoryProvider =>
            typeof entry === 'object' && entry !== null && 'useFactory' in entry && typeof (entry as IFactoryProvider).useFactory === 'function',
    );
}

function findFactory(token: symbol): IFactoryProvider {
    const found = readProviders().find((entry) => entry.provide === token);

    if (found === undefined) {
        throw new Error(`No useFactory provider for token ${String(token)} in ExchangeModule`);
    }

    return found;
}

describe('ExchangeModule — env-conditional port factories (real provider metadata)', () => {
    // Stubbed dependencies — the factories only branch on `appConfig.exchangeEnv`
    // and return one of the two injected instances. No method on the stubs is
    // ever called by the factory itself.
    const ccxtExec = { tag: 'CcxtExecutionClient' } as unknown as CcxtExecutionClient;
    const paperExec = { tag: 'PaperExecutionClient' } as unknown as PaperExecutionClient;
    const ccxtAcct = { tag: 'ExchangeAccountStateSource' } as unknown as ExchangeAccountStateSource;
    const paperAcct = { tag: 'PaperAccountStateSource' } as unknown as PaperAccountStateSource;

    function buildAppConfig(env: ExchangeEnvironmentEnum): AppConfigService {
        return { exchangeEnv: env } as unknown as AppConfigService;
    }

    describe('EXECUTION_CLIENT factory', () => {
        const factory = findFactory(EXECUTION_CLIENT as symbol);

        it.each([
            [ExchangeEnvironmentEnum.TESTNET, ccxtExec],
            [ExchangeEnvironmentEnum.LIVE, ccxtExec],
            [ExchangeEnvironmentEnum.PAPER, paperExec],
        ])('EXCHANGE_ENV=%s -> selects the matching adapter', (env, expected) => {
            const result = factory.useFactory(buildAppConfig(env), ccxtExec, paperExec);
            expect(result).toBe(expected);
        });
    });

    // M11a R4 Item 4C — engine-shape order-command port. Same dispatch as
    // EXECUTION_CLIENT; verifying it independently catches a future edit
    // that breaks one factory but leaves the other in sync.
    describe('ENGINE_EXECUTION_CLIENT factory', () => {
        const factory = findFactory(ENGINE_EXECUTION_CLIENT as symbol);

        it.each([
            [ExchangeEnvironmentEnum.TESTNET, ccxtExec],
            [ExchangeEnvironmentEnum.LIVE, ccxtExec],
            [ExchangeEnvironmentEnum.PAPER, paperExec],
        ])('EXCHANGE_ENV=%s -> selects the matching adapter', (env, expected) => {
            const result = factory.useFactory(buildAppConfig(env), ccxtExec, paperExec);
            expect(result).toBe(expected);
        });
    });

    describe('ACCOUNT_STATE_SOURCE factory', () => {
        const factory = findFactory(ACCOUNT_STATE_SOURCE as symbol);

        it.each([
            [ExchangeEnvironmentEnum.TESTNET, ccxtAcct],
            [ExchangeEnvironmentEnum.LIVE, ccxtAcct],
            [ExchangeEnvironmentEnum.PAPER, paperAcct],
        ])('EXCHANGE_ENV=%s -> selects the matching adapter', (env, expected) => {
            const result = factory.useFactory(buildAppConfig(env), ccxtAcct, paperAcct);
            expect(result).toBe(expected);
        });
    });
});

describe('CcxtExecutionClient — PAPER per-method guard (HIGH H1, R2a-fix-wave-2 Item 1)', () => {
    // R2a-fix-wave-2 Item 1: the constructor no longer asserts (Nest's
    // env-factory `inject:` instantiates this class under PAPER). The per-
    // method guards are the live defence — verify each one throws under
    // PAPER and not under LIVE/TESTNET.
    const paperConfig = { exchangeEnv: ExchangeEnvironmentEnum.PAPER } as unknown as AppConfigService;
    const liveConfig = { exchangeEnv: ExchangeEnvironmentEnum.LIVE } as unknown as AppConfigService;
    const testnetConfig = { exchangeEnv: ExchangeEnvironmentEnum.TESTNET } as unknown as AppConfigService;

    function buildClient(config: AppConfigService): CcxtExecutionClient {
        const exchange = {} as unknown as CcxtBinanceExchangeClient;
        return new CcxtExecutionClient(config, exchange);
    }

    it('constructor does NOT throw under PAPER (Nest must be able to instantiate the class for the env-factory inject list)', () => {
        expect(() => buildClient(paperConfig)).not.toThrow();
    });

    const sharedIntent = {
        eventId: 'evt-1',
        symbol: 'BTCUSDT',
        tradeSide: 'LONG',
        intentAction: 'OPEN',
        quantity: '0.001',
    } as never;

    const orderCommandMethods: Array<[string, (client: CcxtExecutionClient) => Promise<unknown>]> = [
        ['placeOrder', (c) => c.placeOrder(sharedIntent)],
        ['cancelOrder', (c) => c.cancelOrder('BTCUSDT', 'cid')],
        ['cancelAllOrdersForSymbol', (c) => c.cancelAllOrdersForSymbol('BTCUSDT')],
        ['fetchOrderStatus', (c) => c.fetchOrderStatus('BTCUSDT', 'cid')],
        ['fetchOpenOrders', (c) => c.fetchOpenOrders('BTCUSDT')],
        ['createOrder', (c) => c.createOrder({ symbol: 'BTCUSDT', type: 'market', side: 'buy', amount: '0.001', price: null, clientOrderId: 'cid' })],
        ['fetchOrderByClientId', (c) => c.fetchOrderByClientId('BTCUSDT', 'cid')],
        ['cancelOrderByClientId', (c) => c.cancelOrderByClientId('BTCUSDT', 'cid')],
    ];

    it.each(orderCommandMethods)('%s throws PaperExecutionGuardException under PAPER', async (_name, invoke) => {
        const client = buildClient(paperConfig);
        await expect(invoke(client)).rejects.toBeInstanceOf(PaperExecutionGuardException);
    });

    it('constructor accepts EXCHANGE_ENV=testnet', () => {
        expect(() => buildClient(testnetConfig)).not.toThrow();
    });

    it('constructor accepts EXCHANGE_ENV=live', () => {
        expect(() => buildClient(liveConfig)).not.toThrow();
    });
});

// The previous `internalRawClient` / `internalCallExchange` /
// `internalNormaliseOrder` getters leaked the raw ccxt client across the
// class boundary; they are now PRIVATE typed facades. The sentinel checks
// that no MEMBER ACCESS (`.internalXxx`) appears outside the owning class.
// Plain string mentions in comments / doc are permitted.
function collectTsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') {
            continue;
        }

        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            collectTsFiles(full, acc);
            continue;
        }

        if (full.endsWith('.ts') && !full.endsWith('CcxtBinanceExchangeClient.ts')) {
            acc.push(full);
        }
    }

    return acc;
}

describe('CcxtBinanceExchangeClient — internal* surface removal (HIGH H2)', () => {
    const exchangeSrc = resolve(__dirname, '..');
    const files = collectTsFiles(exchangeSrc);

    it.each(['internalRawClient', 'internalCallExchange', 'internalNormaliseOrder'])(
        'no member-access on `.%s` exists outside CcxtBinanceExchangeClient.ts',
        (sentinel) => {
            const pattern = new RegExp(`\\.${sentinel}\\b`);

            for (const file of files) {
                const source = readFileSync(file, 'utf8');
                expect({ file, hasMatch: pattern.test(source) }).toEqual({ file, hasMatch: false });
            }
        },
    );
});
