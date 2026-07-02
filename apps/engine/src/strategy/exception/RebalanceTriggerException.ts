import { DomainException } from '../../common/exception';

// Raised when the paper-only manual rebalance trigger is invoked outside paper env. The
// controller translates this to HTTP 403 — the operation is categorically not permitted in
// this environment (ADR 0048 §10). Thrown by the service so the CLI path (which calls the
// same seam over HTTP today, but may call the service directly tomorrow) sees a typed failure.
export class RebalanceTriggerForbiddenException extends DomainException {
    constructor(message: string, cause?: unknown) {
        super('REBALANCE_TRIGGER_FORBIDDEN', message, cause);
    }
}

// Raised when a manual rebalance trigger is rejected for a config/validation reason: the
// portfolio path is dormant (no active version), the strategy_versions row is missing, its
// params fail the shared Zod schema, or the cooldown window has not elapsed. The controller
// translates this to HTTP 400 — the request was well-formed but cannot be honoured now.
export class RebalanceTriggerRejectedException extends DomainException {
    constructor(message: string, cause?: unknown) {
        super('REBALANCE_TRIGGER_REJECTED', message, cause);
    }
}
