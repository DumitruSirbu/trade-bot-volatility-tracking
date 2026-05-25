import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { AuthModule } from '../auth/AuthModule';
import { CommonModule } from '../common/CommonModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { CursorCodec } from '../read-api/pagination/CursorCodec';
import { ControlAuditEntity } from './entity/ControlAuditEntity';
import { ControlAuditRepository } from './repository/ControlAuditRepository';
import { HaltController } from './HaltController';
import { FLATTEN_COORDINATOR, LoggingFlattenCoordinator } from './interface/IFlattenCoordinator';
import { HaltRateLimiter } from './HaltRateLimiter';
import { HaltService } from './HaltService';

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
    imports: [AlertSinkModule, AuthModule, CommonModule, TypeOrmModule.forFeature([ControlAuditEntity])],
    controllers: [HaltController],
    providers: [
        ControlAuditRepository,
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
    ],
    exports: [HaltService, ControlAuditRepository, CLOCK],
})
export class ControlModule {}
