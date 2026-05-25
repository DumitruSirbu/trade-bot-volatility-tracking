import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { AuthController, LoginValidationFilter } from '../auth/AuthController';
import { AuthModule } from '../auth/AuthModule';
import { LoginRateLimiter } from '../auth/LoginRateLimiter';
import { CommonModule } from '../common/CommonModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { CursorCodec } from '../read-api/pagination/CursorCodec';
import { LoginRateLimitStateEntity } from '../auth/entity/LoginRateLimitStateEntity';
import { LoginRateLimitStateRepository } from '../auth/repository/LoginRateLimitStateRepository';
import { RATE_LIMIT_HALT_PORT } from '../exchange/interface/IRateLimitHaltPort';
import { ControlAuditEntity } from './entity/ControlAuditEntity';
import { ControlAuditRepository } from './repository/ControlAuditRepository';
import { HaltController } from './HaltController';
import { FLATTEN_COORDINATOR, LoggingFlattenCoordinator } from './interface/IFlattenCoordinator';
import { HaltRateLimiter } from './HaltRateLimiter';
import { HaltService } from './HaltService';
import { RateLimitHaltAdapter } from './RateLimitHaltAdapter';

// M9 W3. Wires the kill-switch control plane:
//
//   - `HaltController`           — REST routes (auth-guarded).
//   - `HaltService`              — write-then-flip-then-alert orchestration.
//   - `ControlAuditRepository`   — append-only persistence projection.
//   - `HaltRateLimiter`          — per-`sub` sliding window.
//   - `LoggingFlattenCoordinator`— W3 default; W6 swaps in the risk-gate-
//                                   driven flatten implementation behind the
//                                   `FLATTEN_COORDINATOR` token. The kill-
//                                   switch path NEVER calls the exchange
//                                   directly — `no ccxt import in
//                                   apps/engine/src/control/**`.
//   - `SystemClock`              — boundary clock for the controller, kept
//                                   behind the `CLOCK` token so adversarial
//                                   tests can pin it.
//
// `CommonModule` is imported for `HaltFlagService` (the existing M0 halt flag
// the service wraps — NOT recreated). `AlertSinkModule` supplies `IAlertSink`
// (extracted from `AlertModule` to break the forwardRef cycle that caused
// `HaltService` ALERT_SINK to resolve to `undefined` under NestJS 11 — see
// `alert/sink/AlertSinkModule.ts`). `AuthModule` supplies the guard's
// dependencies (registered globally there).
//
// `HaltStateRestoreService` lives in `bootstrap/` and is wired into
// `BootstrapModule` (PHASE 3 ordering) so that the boot pipeline restores the
// halt flag before any market-data subscription opens.
@Module({
    imports: [AlertSinkModule, AuthModule, CommonModule, TypeOrmModule.forFeature([ControlAuditEntity, LoginRateLimitStateEntity])],
    // M10 W0.5 — AuthController (POST /v1/auth/login) registered here to
    // avoid an AuthModule → ControlModule cycle (ControlModule already imports
    // AuthModule for the guard). The controller depends on AppConfigService,
    // CLOCK, HaltFlagService (CommonModule), AuthTokenService (AuthModule),
    // ControlAuditRepository (this module), LoginRateLimiter (this module).
    controllers: [HaltController, AuthController],
    providers: [
        ControlAuditRepository,
        // M11a W1.9 — persistence repo for the login limiter so a restart
        // does not re-open the brute-force window. Hot-path remains in-memory.
        LoginRateLimitStateRepository,
        LoginRateLimiter,
        // M10 R2 #1 — DI-resolved route filter so it can write the LOGIN_FAILURE
        // audit row when the global ValidationPipe rejects a malformed body.
        LoginValidationFilter,
        // R1 wave #6 (architect D): the audit-history cursor goes through the
        // same MAC-bound codec as the read-API surface (positions / metrics).
        // Locally provided here so ControlModule stays independent of the
        // read-API import graph. CursorCodec is stateless beyond the injected
        // auth secret, so duplicate providers are safe.
        CursorCodec,
        HaltRateLimiter,
        HaltService,
        { provide: CLOCK, useClass: SystemClock },
        { provide: FLATTEN_COORDINATOR, useClass: LoggingFlattenCoordinator },
        // M11a W1.4 (ADR 0030 §2.6.2) — port impl consumed by ExchangeModule's
        // RateLimitPolicyService. Exposed via the RATE_LIMIT_HALT_PORT token
        // so the exchange module never imports control directly.
        RateLimitHaltAdapter,
        { provide: RATE_LIMIT_HALT_PORT, useExisting: RateLimitHaltAdapter },
    ],
    exports: [HaltService, ControlAuditRepository, CLOCK, RATE_LIMIT_HALT_PORT],
})
export class ControlModule {}
