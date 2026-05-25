import { Module } from '@nestjs/common';

import { AlertModule } from '../alert/AlertModule';
import { ControlModule } from '../control/ControlModule';
import { ExecutionModule } from '../execution/ExecutionModule';
import { MarketDataModule } from '../market-data/MarketDataModule';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { HaltStateRestoreService } from './HaltStateRestoreService';
import { SchemaValidationService } from './SchemaValidationService';
import { EngineBootstrapService } from './service';

// Composition-root module for the engine's boot pipeline.
//
// **PHASE 0 — SCHEMA_VALIDATION (M9 W1, ADR 0025).**
// `SchemaValidationService` is registered FIRST so its `onApplicationBootstrap`
// hook fires before `EngineBootstrapService`'s. NestJS initialises providers
// inside a module in declaration order and dispatches lifecycle hooks in the
// same order, so the schema gate runs strictly before phases 1-9.
//
// Boot-pipeline reshuffle (M9 W1): BootstrapModule keeps its position as the
// LAST import of `AppModule` (so phases 1-9 still fire after every other
// module's `onModuleInit` completes). What changes is the in-module ordering:
// `SchemaValidationService` is declared BEFORE `EngineBootstrapService` in the
// providers list, so its `onApplicationBootstrap` hook fires first inside this
// module. The schema gate runs against `DataSource` (already wired by
// DatabaseModule earlier in the import graph) and BEFORE phases 1-9 produce
// or consume any persistence write. On hard fail the gate calls
// `process.exit(1)`, so phases 1-9 never begin.
//
// **PHASES 1-9** are owned by `EngineBootstrapService` (ADR 0014). The
// service is lifted out of `position/service/` so it sits structurally above
// PositionModule, ExecutionModule, RiskModule, and MarketDataModule with no
// `forwardRef` cycles — BootstrapModule has no inbound consumers.
//
// `AlertModule` is imported so the schema gate can publish a
// `BOOT_SCHEMA_GATE_FAILED` payload through the `IAlertSink` port even before
// the Telegram sender lands in W6. The W1 default is a logger-backed no-op.
// `HaltStateRestoreService` is declared BETWEEN `SchemaValidationService`
// (PHASE 0) and `EngineBootstrapService` (PHASES 1-9) so its
// `onApplicationBootstrap` fires after the schema gate validates
// `control_audit` exists and BEFORE phases 1-9 open subscriptions / the
// orchestrator. NestJS dispatches lifecycle hooks in provider declaration
// order inside a module.
@Module({
    imports: [AlertModule, ControlModule, PositionModule, ExecutionModule, RiskModule, MarketDataModule],
    providers: [SchemaValidationService, HaltStateRestoreService, EngineBootstrapService],
    // M9 W4 — `SchemaValidationService.lastValidationResult()` backs `GET /v1/health`'s
    // `schemaValid` flag in ReadApiModule. The provider stays singleton-scoped here.
    exports: [SchemaValidationService],
})
export class BootstrapModule {}
