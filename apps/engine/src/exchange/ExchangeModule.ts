import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/AppConfigModule';
import { EXCHANGE_CLIENT } from './interface';
import { CcxtBinanceExchangeClient } from './service';

// The only module permitted to talk to Binance. Exposes IExchangeClient via the
// EXCHANGE_CLIENT token; consumers (MarketDataModule) depend on the interface,
// never on ccxt or the concrete client (ADR §1).
@Module({
    imports: [AppConfigModule],
    providers: [
        {
            provide: EXCHANGE_CLIENT,
            useClass: CcxtBinanceExchangeClient,
        },
    ],
    exports: [EXCHANGE_CLIENT],
})
export class ExchangeModule {}
