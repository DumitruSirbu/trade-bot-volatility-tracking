/**
 * M42 — REST tick refresh handler on PAPER_TICK_REFRESH_REQUEST.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PAPER_TICK_REFRESH_REQUEST, PRICE_UPDATE_EVENT } from '../../../common/const';
import { AppConfigService } from '../../../config/service';
import { IExchangeClient } from '../../../exchange/interface';
import { ExchangeEnvironmentEnum } from '@bot/shared';
import { MarketDataService } from '../MarketDataService';
import { DepthAggressorService } from '../DepthAggressorService';
import { DeviationCalibrationService } from '../DeviationCalibrationService';
import { FlowPollService } from '../FlowPollService';
import { MarketContextService } from '../MarketContextService';
import { SymbolStateRegistry } from '../SymbolStateRegistry';
import { UniverseService } from '../UniverseService';

function buildMarketDataService(overrides: {
    exchangeClient: Pick<IExchangeClient, 'fetchTickers'>;
    eventEmitter?: EventEmitter2;
    exchangeEnv?: ExchangeEnvironmentEnum;
}): MarketDataService {
    const appConfig = { exchangeEnv: overrides.exchangeEnv ?? ExchangeEnvironmentEnum.PAPER } as AppConfigService;

    return new MarketDataService(
        overrides.exchangeClient as IExchangeClient,
        overrides.eventEmitter ?? new EventEmitter2(),
        appConfig,
        { loadTradableSymbols: jest.fn(), getEntry: jest.fn() } as unknown as UniverseService,
        { all: jest.fn(() => []), getOrCreate: jest.fn() } as unknown as SymbolStateRegistry,
        {} as MarketContextService,
        {} as DepthAggressorService,
        {} as FlowPollService,
        {} as DeviationCalibrationService,
    );
}

describe('MarketDataService — paper tick refresh (M42)', () => {
    it('onPaperTickRefreshRequest emits PRICE_UPDATE_EVENT when REST ticker exists', async () => {
        const eventEmitter = new EventEmitter2();
        const emitSpy = jest.spyOn(eventEmitter, 'emit');
        const exchangeClient = {
            fetchTickers: jest.fn().mockResolvedValue([
                {
                    symbol: 'OP/USDT:USDT',
                    timestampMs: 1_700_000_000_000,
                    last: '1.05',
                    bid: '1.04',
                    ask: '1.06',
                    quoteVolume: '1000000',
                },
            ]),
        };

        const service = buildMarketDataService({ exchangeClient, eventEmitter });

        await service.onPaperTickRefreshRequest({ symbol: 'OP/USDT:USDT', nowMs: 1_700_000_000_100 });

        expect(exchangeClient.fetchTickers).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith(
            PRICE_UPDATE_EVENT,
            expect.objectContaining({
                symbol: 'OP/USDT:USDT',
                price: '1.05',
                timestampMs: 1_700_000_000_100,
            }),
        );
    });

    it('onPaperTickRefreshRequest does not emit when symbol is absent from REST snapshot', async () => {
        const eventEmitter = new EventEmitter2();
        const emitSpy = jest.spyOn(eventEmitter, 'emit');
        const exchangeClient = {
            fetchTickers: jest.fn().mockResolvedValue([]),
        };

        const service = buildMarketDataService({ exchangeClient, eventEmitter });

        await service.onPaperTickRefreshRequest({ symbol: 'OP/USDT:USDT', nowMs: Date.now() });

        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('onPaperTickRefreshRequest skips REST when EXCHANGE_ENV is not paper', async () => {
        const eventEmitter = new EventEmitter2();
        const emitSpy = jest.spyOn(eventEmitter, 'emit');
        const exchangeClient = {
            fetchTickers: jest.fn(),
        };

        const service = buildMarketDataService({
            exchangeClient,
            eventEmitter,
            exchangeEnv: ExchangeEnvironmentEnum.LIVE,
        });

        await service.onPaperTickRefreshRequest({ symbol: 'OP/USDT:USDT', nowMs: Date.now() });

        expect(exchangeClient.fetchTickers).not.toHaveBeenCalled();
        expect(emitSpy).not.toHaveBeenCalled();
    });

    it('PAPER_TICK_REFRESH_REQUEST event name is wired for PaperFillSimulator emitAsync', () => {
        expect(PAPER_TICK_REFRESH_REQUEST).toBe('paper.tick.refresh.request');
    });
});
