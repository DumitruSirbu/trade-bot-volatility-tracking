import { Module } from '@nestjs/common';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { AppConfigModule } from '../config/AppConfigModule';
import { ControlModule } from '../control/ControlModule';
import { EXCHANGE_CLIENT } from './interface';
import { RATE_LIMIT_POLICY } from './interface/IRateLimitPolicy';
import { CcxtBinanceExchangeClient, RateLimitPolicyService } from './service';

// The only module permitted to talk to Binance. Exposes IExchangeClient via the
// EXCHANGE_CLIENT token; consumers (MarketDataModule) depend on the interface,
// never on ccxt or the concrete client (ADR §1).
//
// M11a W1.4 (ADR 0030) — also owns the in-process rate-limit policy. The
// ccxt client takes IRateLimitPolicy as a constructor dep; reconciliation +
// funding pollers reach the limiter transitively through the client (every
// ccxt method goes through `callExchange` which acquires + reconciles).
@Module({
    imports: [AppConfigModule, AlertSinkModule, ControlModule],
    providers: [
        // CLOCK is locally provided; ControlModule also exports CLOCK but
        // Nest's DI scoping resolves the local provider first. Multiple
        // providers for the same port token are intentional (M9 R1 #5).
        { provide: CLOCK, useClass: SystemClock },
        RateLimitPolicyService,
        {
            provide: RATE_LIMIT_POLICY,
            useExisting: RateLimitPolicyService,
        },
        {
            provide: EXCHANGE_CLIENT,
            useClass: CcxtBinanceExchangeClient,
        },
    ],
    exports: [EXCHANGE_CLIENT, RATE_LIMIT_POLICY],
})
export class ExchangeModule {}
