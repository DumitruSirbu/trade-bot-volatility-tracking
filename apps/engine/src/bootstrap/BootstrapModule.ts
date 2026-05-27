import { Module } from '@nestjs/common';

import { AlertModule } from '../alert/AlertModule';
import { BootModeHistoryModule } from '../boot-mode-history/BootModeHistoryModule';
import { ControlModule } from '../control/ControlModule';
import { ExchangeModule } from '../exchange/ExchangeModule';
import { ExecutionModule } from '../execution/ExecutionModule';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { PaperModeModule } from '../paper-mode/PaperModeModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { HaltStateRestoreService } from './HaltStateRestoreService';
import { KeyPermissionAssertionService } from './KeyPermissionAssertionService';
import { LiveGoAheadVerifier } from './LiveGoAheadVerifier';
import { SchemaValidationService } from './SchemaValidationService';
import { EngineBootstrapService } from './service';

// Composition-root module for the engine's boot pipeline.
//
// **PHASE 0 — SCHEMA_VALIDATION (M9 W1, ADR 0025).**
// `SchemaValidationService` uses the `OnModuleInit` hook (not
// `OnApplicationBootstrap`). NestJS dispatches every `OnModuleInit` callback
// strictly BEFORE any `OnApplicationBootstrap` callback fires globally, so the
// schema gate runs before phases 1-9 AND before `BootModeChainService` (which
// lives in `BootModeHistoryModule` and runs in `OnApplicationBootstrap`).
// Without the lifecycle split, `BootModeHistoryModule`'s hooks would fire
// before `BootstrapModule`'s — Nest invokes hooks bottom-up through the import
// graph — which would order chain verification ahead of schema validation.
//
// **PHASES 1-9** are owned by `EngineBootstrapService` (ADR 0014). The
// service is lifted out of `position/service/` so it sits structurally above
// PositionModule, ExecutionModule, RiskModule, and MarketDataModule with no
// `forwardRef` cycles — BootstrapModule has no inbound consumers.
//
// `AlertModule` is imported so the schema gate can publish a
// `BOOT_SCHEMA_GATE_FAILED` payload through the `IAlertSink` port even before
// the Telegram sender lands in W6. The W1 default is a logger-backed no-op.
//
// `BootModeChainService` is registered + exported by `BootModeHistoryModule`
// and is NOT re-declared here. Re-declaring would create a second injector-
// scoped instance whose `OnApplicationBootstrap` hook would fire a second
// boot-mode chain append — double-instantiation is what masked the wiring
// bug that produced the original `TransitionTokenVerifier` UnknownDependencies
// error. Hook ordering inside the OnApplicationBootstrap phase is:
//
//   `BootModeHistoryModule` deps fire first (imported here) → so
//   `BootModeChainService` runs before any provider declared in this module.
//   Within this module the order is declaration-order:
//   `KeyPermissionAssertionService` → `HaltStateRestoreService` →
//   `EngineBootstrapService`. (`SchemaValidationService` already ran in
//   `OnModuleInit`; `LiveGoAheadVerifier` has no lifecycle hook.)
//
// Net order: Schema(MI) → BootModeChain(AB) → KeyPermAssert(AB) →
// HaltStateRestore(AB) → EngineBootstrap(AB).
@Module({
    imports: [
        AlertModule,
        BootModeHistoryModule,
        ControlModule,
        ExchangeModule,
        PaperModeModule,
        PositionModule,
        ExecutionModule,
        RiskModule,
        MarketDataModule,
    ],
    providers: [SchemaValidationService, LiveGoAheadVerifier, KeyPermissionAssertionService, HaltStateRestoreService, EngineBootstrapService],
    // `SchemaValidationService.lastValidationResult()` backs `GET /v1/health`'s
    // `schemaValid` flag in ReadApiModule. The provider stays singleton-scoped here.
    exports: [SchemaValidationService],
})
export class BootstrapModule {}
