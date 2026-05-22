import { DomainException } from '../../common/exception';

// Raised at startup/registry-load when the active strategy version cannot be resolved or
// its params JSONB fails the shared Zod schema. Fail fast — never run a strategy with an
// unresolved impl or invalid params (ADR 0003 §7/§8).
export class StrategyConfigException extends DomainException {
    constructor(message: string, cause?: unknown) {
        super('STRATEGY_CONFIG_INVALID', message, cause);
    }
}
