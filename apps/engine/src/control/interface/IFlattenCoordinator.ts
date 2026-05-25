import { Injectable, Logger } from '@nestjs/common';

// M9 W3 (ADR 0021 §2.4). Port consumed by `HaltService` when `flatten=true`.
// The CONCRETE implementation enqueues a CLOSE intent per open position
// through the EXISTING risk-gate + executor path — i.e. no direct exchange
// call. The control module deliberately depends on this port (DI token +
// interface) so the kill-switch path stays decoupled from RiskModule /
// PositionModule wiring (and from the M4-side intent assembler).
//
// The W3 default (`LoggingFlattenCoordinator`) is intentionally a logging
// no-op: it surfaces the request so smoke tests can see it landed, but the
// actual CLOSE-intent assembler is wired in W6 alongside the M4 programmatic
// halt entry points. This mirrors the `AlertModule` pattern of shipping a
// NoopAlertSink in W1 and swapping to TelegramAlertSink in W6.
//
// IMPORTANT: any future concrete impl MUST go through `RiskGateService` and
// the M5 `ExecutionService`. No `ccxt` import is permitted under
// `apps/engine/src/control/**`.

export const FLATTEN_COORDINATOR = Symbol('FLATTEN_COORDINATOR');

export interface IFlattenRequest {
    reason: string;
    correlationEventId: string | null;
    now: Date;
}

export interface IFlattenCoordinator {
    flattenAllOpen(request: IFlattenRequest): Promise<void>;
}

@Injectable()
export class LoggingFlattenCoordinator implements IFlattenCoordinator {
    private readonly logger = new Logger(LoggingFlattenCoordinator.name);

    async flattenAllOpen(request: IFlattenRequest): Promise<void> {
        // Visible breadcrumb. The real W6 implementation reads open positions,
        // synthesises a CLOSE `IOrderIntent` per row, and feeds each through
        // `RiskGateService.evaluate(...)`. Until W6 lands, the audit row +
        // alert are the durable evidence that a flatten was requested.
        this.logger.warn(`flatten.requested reason=${request.reason} correlation=${request.correlationEventId ?? 'null'}`);
    }
}
