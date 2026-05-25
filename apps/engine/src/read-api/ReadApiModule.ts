import { IHealthView } from '@bot/shared';
import { Controller, Get, HttpCode, HttpStatus, Module } from '@nestjs/common';

import { AuthModule } from '../auth/AuthModule';
import { BootstrapModule } from '../bootstrap/BootstrapModule';
import { SchemaValidationService } from '../bootstrap/SchemaValidationService';
import { PositionModule } from '../position/PositionModule';
import { RiskModule } from '../risk/RiskModule';
import { StrategyModule } from '../strategy/StrategyModule';
import { MetricsController } from './controllers/MetricsController';
import { PositionsController } from './controllers/PositionsController';
import { NoStoreCacheInterceptor } from './interceptor/NoStoreCacheInterceptor';
import { CursorCodec } from './pagination/CursorCodec';

// M9 W4 (ADR 0022). Read-API surface — every controller here is a thin
// repo→mapper→DTO projection. No business logic, no event-bus reads, no
// risk-gate touching, no exchange-side calls. The module imports only what it
// needs to wire repositories (PositionModule, StrategyModule, RiskModule),
// AuthModule for the guard, and BootstrapModule for SchemaValidationService.
//
// HealthController is registered inline because it is a 1-method controller
// with no other consumer; splitting it into its own file would add a fourth
// controller file for one route. The existing `/health` controller (in
// `health/`) is a private-network liveness probe with no schema-validation
// projection — this `/v1/health` is the public read-API contract.
//
// Routes (all prefixed `/v1/`):
//   GET /v1/health                       (unauthenticated)
//   GET /v1/positions/open               scope=READ
//   GET /v1/positions/closed             scope=READ
//   GET /v1/positions/:id                scope=READ
//   GET /v1/decisions                    scope=READ
//   GET /v1/account/equity               scope=READ
//   GET /v1/risk/state                   scope=READ
//   GET /v1/performance/by-version       scope=READ

const BOOT_AT = new Date();
const MS_PER_SECOND = 1000;

@Controller('v1/health')
export class ReadApiHealthController {
    // M9 W4 (ADR 0022 §2.2). Liveness + schema-gate result. Unauthenticated by
    // design — only liveness + a single boolean status are exposed. No secrets,
    // no version string, no DB error detail. The `schemaValid` flag is read
    // from the cached gate result so a request never re-runs the SQL probe.
    constructor(private readonly schemaValidation: SchemaValidationService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    check(): IHealthView {
        const schemaValid = this.schemaValidation.lastValidationResult();
        const uptimeSec = Math.max(0, Math.floor((Date.now() - BOOT_AT.getTime()) / MS_PER_SECOND));

        return {
            status: schemaValid ? 'ok' : 'degraded',
            uptimeSec,
            schemaValid,
        };
    }
}

@Module({
    imports: [AuthModule, BootstrapModule, PositionModule, StrategyModule, RiskModule],
    controllers: [ReadApiHealthController, PositionsController, MetricsController],
    providers: [CursorCodec, NoStoreCacheInterceptor],
    exports: [CursorCodec, NoStoreCacheInterceptor],
})
export class ReadApiModule {}
