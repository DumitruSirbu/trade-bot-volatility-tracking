import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Module } from '@nestjs/common';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { AppConfigModule } from '../config/AppConfigModule';
import { AppConfigService } from '../config/service';
import { ControlModule } from '../control/ControlModule';
import { PaperModeModule } from '../paper-mode/PaperModeModule';
import { PaperExchangeNullityProbe } from '../paper-mode/security/PaperExchangeNullityProbe';
import { PaperAccountStateSource, PaperExecutionClient } from '../paper-mode/service';
import { ACCOUNT_STATE_SOURCE, ENGINE_EXECUTION_CLIENT, EXCHANGE_CLIENT, EXECUTION_CLIENT } from './interface';
import { RATE_LIMIT_POLICY } from './interface/IRateLimitPolicy';
import { CcxtBinanceExchangeClient, CcxtExecutionClient, ExchangeAccountStateSource, RateLimitPolicyService } from './service';

// The only module permitted to talk to Binance. Exposes:
//   - IExchangeClient via EXCHANGE_CLIENT — connection management +
//     market-data + residual account-state surface (D14 whitelisted callers
//     only).
//   - IExecutionClient via EXECUTION_CLIENT — shared order-command port.
//     `EXCHANGE_ENV ∈ {LIVE, TESTNET}` -> CcxtExecutionClient;
//     `EXCHANGE_ENV === PAPER` -> PaperExecutionClient (stub in R2a).
//   - IAccountStateSource via ACCOUNT_STATE_SOURCE — shared account-state
//     port. Same env-conditional dispatch.
//
// M11a W1.4 (ADR 0030) — also owns the in-process rate-limit policy. The
// ccxt client takes IRateLimitPolicy as a constructor dep; reconciliation +
// funding pollers reach the limiter transitively through the client.
//
// M11a R2a (ADR 0032 §3 D2 + D14) — port factories. `useFactory` reads
// `AppConfigService.exchangeEnv` once at provider construction and binds the
// matching adapter. PaperModeModule is imported unconditionally so the PAPER
// providers can resolve; under LIVE/TESTNET the PAPER providers are
// instantiated but never wired into the live decision loop (the factory
// returns the Ccxt-backed adapters).
@Module({
    imports: [AppConfigModule, AlertSinkModule, ControlModule, PaperModeModule],
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
        CcxtBinanceExchangeClient,
        {
            provide: EXCHANGE_CLIENT,
            useExisting: CcxtBinanceExchangeClient,
        },
        CcxtExecutionClient,
        ExchangeAccountStateSource,
        {
            provide: EXECUTION_CLIENT,
            useFactory: (appConfig: AppConfigService, ccxt: CcxtExecutionClient, paper: PaperExecutionClient) =>
                appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER ? paper : ccxt,
            inject: [AppConfigService, CcxtExecutionClient, PaperExecutionClient],
        },
        // M11a R4 Item 4C — engine-shape order-command port. Same
        // env-conditional dispatch as EXECUTION_CLIENT above; consumed by
        // ExchangeOrderSubmitter / ProtectiveOrderAttacher (engine-shape
        // callers) so PAPER routes through PaperExecutionClient's engine-
        // shape methods instead of the unreachable concrete-class injection.
        {
            provide: ENGINE_EXECUTION_CLIENT,
            useFactory: (appConfig: AppConfigService, ccxt: CcxtExecutionClient, paper: PaperExecutionClient) =>
                appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER ? paper : ccxt,
            inject: [AppConfigService, CcxtExecutionClient, PaperExecutionClient],
        },
        {
            provide: ACCOUNT_STATE_SOURCE,
            useFactory: (appConfig: AppConfigService, ccxt: ExchangeAccountStateSource, paper: PaperAccountStateSource) =>
                appConfig.exchangeEnv === ExchangeEnvironmentEnum.PAPER ? paper : ccxt,
            inject: [AppConfigService, ExchangeAccountStateSource, PaperAccountStateSource],
        },
        // M11a R2d Item 2 (ADR 0032 §D8 Fallback Profile + §D13). The probe
        // lives in `paper-mode/security/` to keep its source under the
        // paper-mode ESLint scope, but is PROVIDED here because it needs
        // direct access to `EXCHANGE_CLIENT` (one of the two D14 whitelisted
        // ccxt-reach services). Adding it to PaperModeModule would force a
        // PaperModeModule -> ExchangeModule edge that conflicts with the
        // existing ExchangeModule -> PaperModeModule import. Under
        // EXCHANGE_ENV !== PAPER the probe constructor short-circuits in
        // onApplicationBootstrap.
        PaperExchangeNullityProbe,
    ],
    exports: [
        EXCHANGE_CLIENT,
        EXECUTION_CLIENT,
        ENGINE_EXECUTION_CLIENT,
        ACCOUNT_STATE_SOURCE,
        RATE_LIMIT_POLICY,
        PaperExchangeNullityProbe,
        // M11a R4 Item 4C: concrete-class export retained only for
        // ReconciliationService (case-(f) still injects the concrete; deferred
        // to a follow-up). Order-command callers (ExchangeOrderSubmitter,
        // ProtectiveOrderAttacher) now inject ENGINE_EXECUTION_CLIENT so PAPER
        // routes through PaperExecutionClient's engine-shape methods.
        CcxtExecutionClient,
    ],
})
export class ExchangeModule {}
