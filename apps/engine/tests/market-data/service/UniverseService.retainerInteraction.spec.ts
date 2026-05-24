/**
 * UniverseService × SubscriptionRetainer — held-symbol invariant (M6 W2, ADR 0011 §5).
 *
 * Coverage:
 *   - A symbol the bot holds (retainer.isRetained === true) that drops out of
 *     the top-N universe MUST keep its membership entry. No symbolLeft event
 *     is emitted; the entry stays so consumers (monitor, PnL, reconciliation)
 *     keep reading its price tape.
 *   - A non-retained symbol that leaves still emits symbolLeft and is removed
 *     (control case — proves the filter is reason-set-driven, not blanket-off).
 *   - Once the retainer releases, the next refresh evicts the symbol normally.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { RetainReasonEnum } from '@bot/shared';

import { UNIVERSE_SYMBOL_LEFT_EVENT } from '../../../src/common/const';
import { IMarketInfo, ITickerSnapshot } from '../../../src/exchange/interface/IExchangeSnapshots';
import { SubscriptionRetainer } from '../../../src/market-data/service/SubscriptionRetainer';
import { UniverseService } from '../../../src/market-data/service/UniverseService';

const ABOVE_FLOOR_VOLUME = '100000000';
const NOW_MS = 1_700_000_000_000;

function buildMarket(symbol: string, base: string): IMarketInfo {
    return {
        symbol,
        base,
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
    };
}

function buildTicker(symbol: string, quoteVolume: string = ABOVE_FLOOR_VOLUME): ITickerSnapshot {
    return { symbol, timestampMs: NOW_MS, last: '100', bid: '99.9', ask: '100.1', quoteVolume };
}

interface IBuiltHarness {
    service: UniverseService;
    retainer: SubscriptionRetainer;
    eventEmitter: EventEmitter2;
    emitSpy: jest.SpyInstance;
}

function buildHarness(markets: IMarketInfo[]): IBuiltHarness {
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
    const retainer = new SubscriptionRetainer();
    const eventEmitter = new EventEmitter2();
    const emitSpy = jest.spyOn(eventEmitter, 'emit');
    const service = new UniverseService(exchangeClient as never, eventEmitter, retainer);

    return { service, retainer, eventEmitter, emitSpy };
}

async function loadAndRefresh(service: UniverseService, markets: IMarketInfo[], tickers: ITickerSnapshot[]): Promise<void> {
    await service.loadTradableSymbols();
    service.refresh(tickers, NOW_MS);
}

describe('UniverseService — universe-prune honors SubscriptionRetainer (ADR 0011 §5)', () => {
    it('retained symbol that drops from the top-N stays in the universe entries and emits NO symbolLeft event', async () => {
        const btc = buildMarket('BTC/USDT:USDT', 'BTC');
        const eth = buildMarket('ETH/USDT:USDT', 'ETH');
        const markets = [btc, eth];
        const { service, retainer, emitSpy } = buildHarness(markets);

        // First refresh: both symbols in the universe.
        await loadAndRefresh(service, markets, [buildTicker('BTC/USDT:USDT'), buildTicker('ETH/USDT:USDT')]);
        expect(service.isMember('BTC/USDT:USDT')).toBe(true);
        expect(service.isMember('ETH/USDT:USDT')).toBe(true);

        // The bot has an open position in BTC; retainer holds it.
        retainer.retain('BTC/USDT:USDT', RetainReasonEnum.OPEN_POSITION);

        // BTC drops to zero volume (would normally leave the universe).
        emitSpy.mockClear();
        service.refresh([buildTicker('ETH/USDT:USDT')], NOW_MS);

        // CHECK: BTC is still a member; no symbolLeft event for BTC fired.
        expect(service.isMember('BTC/USDT:USDT')).toBe(true);
        const leftEvents = emitSpy.mock.calls.filter(([name]) => name === UNIVERSE_SYMBOL_LEFT_EVENT);
        expect(leftEvents).toHaveLength(0);
    });

    it('control: a NON-retained symbol that drops from the top-N still emits symbolLeft and is removed', async () => {
        const btc = buildMarket('BTC/USDT:USDT', 'BTC');
        const eth = buildMarket('ETH/USDT:USDT', 'ETH');
        const markets = [btc, eth];
        const { service, emitSpy } = buildHarness(markets);

        await loadAndRefresh(service, markets, [buildTicker('BTC/USDT:USDT'), buildTicker('ETH/USDT:USDT')]);

        // ETH leaves (no retainer holding it).
        emitSpy.mockClear();
        service.refresh([buildTicker('BTC/USDT:USDT')], NOW_MS);

        expect(service.isMember('ETH/USDT:USDT')).toBe(false);
        const leftEvents = emitSpy.mock.calls.filter(([name]) => name === UNIVERSE_SYMBOL_LEFT_EVENT);
        expect(leftEvents.length).toBeGreaterThan(0);
    });

    it('once retainer releases, the next refresh evicts the symbol normally (no permanent retention leak)', async () => {
        const btc = buildMarket('BTC/USDT:USDT', 'BTC');
        const eth = buildMarket('ETH/USDT:USDT', 'ETH');
        const markets = [btc, eth];
        const { service, retainer, emitSpy } = buildHarness(markets);

        await loadAndRefresh(service, markets, [buildTicker('BTC/USDT:USDT'), buildTicker('ETH/USDT:USDT')]);
        retainer.retain('BTC/USDT:USDT', RetainReasonEnum.OPEN_POSITION);

        // BTC drops out, retainer keeps it.
        service.refresh([buildTicker('ETH/USDT:USDT')], NOW_MS);
        expect(service.isMember('BTC/USDT:USDT')).toBe(true);

        // Position closes → retainer releases.
        retainer.release('BTC/USDT:USDT', RetainReasonEnum.OPEN_POSITION);
        emitSpy.mockClear();

        // Next refresh evicts cleanly.
        service.refresh([buildTicker('ETH/USDT:USDT')], NOW_MS);

        expect(service.isMember('BTC/USDT:USDT')).toBe(false);
        const leftEvents = emitSpy.mock.calls.filter(([name]) => name === UNIVERSE_SYMBOL_LEFT_EVENT);
        const leftSymbols = leftEvents.map(([, payload]) => (payload as { symbol: string }).symbol);
        expect(leftSymbols).toContain('BTC/USDT:USDT');
    });
});
