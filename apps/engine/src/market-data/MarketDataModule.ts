import { Module } from '@nestjs/common';

import { ExchangeModule } from '../exchange/ExchangeModule';
import {
    DepthAggressorService,
    DeviationCalibrationService,
    FlowPollService,
    MarketContextService,
    MarketDataService,
    SymbolStateRegistry,
    UniverseService,
} from './service';

// The only consumer of IExchangeClient. Owns the universe, candle aggregation,
// closed-bar indicators, the tiered depth/OI/aggressor subscriptions, the shared
// trigger evaluation, and the price.update / volatility.detected emissions (ADR §1).
@Module({
    imports: [ExchangeModule],
    providers: [
        SymbolStateRegistry,
        UniverseService,
        MarketContextService,
        DepthAggressorService,
        FlowPollService,
        DeviationCalibrationService,
        MarketDataService,
    ],
    exports: [UniverseService, SymbolStateRegistry, MarketContextService],
})
export class MarketDataModule {}
