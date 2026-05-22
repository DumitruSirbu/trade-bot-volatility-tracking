import { EventEmitter2 } from '@nestjs/event-emitter';

import { IMarketInfo, ITickerSnapshot } from '../../../src/exchange/interface/IExchangeSnapshots';
import { UniverseService } from '../../../src/market-data/service/UniverseService';

// A high-volume quote so every market clears the liquidity floor.
const ABOVE_FLOOR_VOLUME = '100000000';
const NOW_MS = 1_700_000_000_000;

function buildMarket(overrides: Partial<IMarketInfo> & { symbol: string; base: string }): IMarketInfo {
    return {
        quote: 'USDT',
        settle: 'USDT',
        active: true,
        isLinearPerpetual: true,
        contractSize: '1',
        pricePrecision: 2,
        amountPrecision: 3,
        tickSize: '0.01',
        stepSize: '0.001',
        minNotional: '5',
        ...overrides,
    };
}

function buildTicker(symbol: string): ITickerSnapshot {
    return { symbol, timestampMs: NOW_MS, last: '100', bid: '99.9', ask: '100.1', quoteVolume: ABOVE_FLOOR_VOLUME };
}

function buildService(markets: IMarketInfo[]): UniverseService {
    const exchangeClient = {
        loadMarkets: jest.fn().mockResolvedValue(markets),
        fetchTickers: jest.fn(),
        fetchBalance: jest.fn(),
        fetchOpenInterest: jest.fn(),
        fetchFundingRate: jest.fn(),
        watchTickers: jest.fn(),
        watchOrderBook: jest.fn(),
        watchTrades: jest.fn(),
        close: jest.fn(),
    };

    // Plain construction — no NestJS DI needed; token is only required when the
    // container wires it; here we pass the mock directly.
    return new UniverseService(exchangeClient as never, new EventEmitter2());
}

// Loads markets then refreshes with a ticker for every market so the full filter
// chain (isTradablePerpetual → linearPerpetualSymbols → rankByVolume) runs.
async function loadAndRefresh(service: UniverseService, markets: IMarketInfo[]): Promise<void> {
    await service.loadTradableSymbols();
    service.refresh(
        markets.map((m) => buildTicker(m.symbol)),
        NOW_MS,
    );
}

describe('UniverseService — stablecoin exclusion from tradable universe', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('excludes an active linear perpetual whose base is a stablecoin (USDC)', async () => {
        const markets = [buildMarket({ symbol: 'USDC/USDT:USDT', base: 'USDC' })];
        const service = buildService(markets);

        await loadAndRefresh(service, markets);

        expect(service.getEntries().map((e) => e.symbol)).not.toContain('USDC/USDT:USDT');
    });

    it('includes an active linear perpetual whose base is a non-stablecoin (BTC)', async () => {
        const markets = [buildMarket({ symbol: 'BTC/USDT:USDT', base: 'BTC' })];
        const service = buildService(markets);

        await loadAndRefresh(service, markets);

        expect(service.getEntries().map((e) => e.symbol)).toContain('BTC/USDT:USDT');
    });

    it('excludes an inactive market regardless of base (pre-existing active guard)', async () => {
        const markets = [buildMarket({ symbol: 'ETH/USDT:USDT', base: 'ETH', active: false })];
        const service = buildService(markets);

        await loadAndRefresh(service, markets);

        expect(service.getEntries().map((e) => e.symbol)).not.toContain('ETH/USDT:USDT');
    });

    it('excludes a non-linear-perpetual market regardless of base (pre-existing perp guard)', async () => {
        const markets = [buildMarket({ symbol: 'SOL/USDT', base: 'SOL', isLinearPerpetual: false })];
        const service = buildService(markets);

        await loadAndRefresh(service, markets);

        expect(service.getEntries().map((e) => e.symbol)).not.toContain('SOL/USDT');
    });

    describe('boundary — multiple stablecoin bases and a look-alike non-stablecoin', () => {
        it('excludes USDC and DAI but includes DAIUSDT-base LINK whose symbol only resembles a stablecoin', async () => {
            // LINK has nothing to do with DAI; "DAIX" is not in the stablecoin set.
            const markets = [
                buildMarket({ symbol: 'USDC/USDT:USDT', base: 'USDC' }),
                buildMarket({ symbol: 'DAI/USDT:USDT', base: 'DAI' }),
                buildMarket({ symbol: 'LINK/USDT:USDT', base: 'LINK' }),
            ];
            const service = buildService(markets);

            await loadAndRefresh(service, markets);

            const symbols = service.getEntries().map((e) => e.symbol);

            expect(symbols).not.toContain('USDC/USDT:USDT');
            expect(symbols).not.toContain('DAI/USDT:USDT');
            expect(symbols).toContain('LINK/USDT:USDT');
        });

        it('excludes every stablecoin in the set when all appear together', async () => {
            const stablecoins = ['USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDD', 'DAI', 'USDP', 'GUSD', 'FRAX', 'LUSD'];
            const markets = [
                ...stablecoins.map((base) => buildMarket({ symbol: `${base}/USDT:USDT`, base })),
                buildMarket({ symbol: 'BTC/USDT:USDT', base: 'BTC' }),
            ];
            const service = buildService(markets);

            await loadAndRefresh(service, markets);

            const symbols = service.getEntries().map((e) => e.symbol);

            for (const base of stablecoins) {
                expect(symbols).not.toContain(`${base}/USDT:USDT`);
            }

            expect(symbols).toContain('BTC/USDT:USDT');
        });

        it('does not exclude a base that merely starts with "USD" but is not in the stablecoin set (e.g. USDFI)', async () => {
            // USDFI is not in STABLECOIN_BASE_SYMBOLS; it must not be caught by a naive prefix check.
            const markets = [buildMarket({ symbol: 'USDFI/USDT:USDT', base: 'USDFI' })];
            const service = buildService(markets);

            await loadAndRefresh(service, markets);

            expect(service.getEntries().map((e) => e.symbol)).toContain('USDFI/USDT:USDT');
        });
    });
});
