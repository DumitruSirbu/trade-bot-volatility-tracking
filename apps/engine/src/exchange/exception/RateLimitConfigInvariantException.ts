import { DomainException } from '../../common/exception';

// M11a W1.4 (ADR 0030 §2.4). Thrown when a rate-limit configuration invariant
// is violated. Two cases, both fatal:
//
//   - perSymbolShare: at `RateLimitPolicyService.onModuleInit`, when the
//     per-symbol ORDERS share × MAX_OPEN_POSITIONS exceeds 1.0 — the invariant
//     that guarantees no single-symbol sub-bucket can starve the account-wide
//     ORDERS bucket while the M4 3-slot model is active.
//   - unknownOperation (M46, ADR 0030 §2.7): at acquisition time, when an
//     operation maps to neither the `/fapi` nor `/sapi` weight table — the
//     limiter must never silently let an unknown call site bypass accounting.
export class RateLimitConfigInvariantException extends DomainException {
    private constructor(message: string) {
        super('RATE_LIMIT_CONFIG_INVARIANT_VIOLATED', message);
    }

    static perSymbolShareTooLarge(maxOpenPositions: number, perSymbolShare: number): RateLimitConfigInvariantException {
        return new RateLimitConfigInvariantException(
            `MAX_OPEN_POSITIONS (${maxOpenPositions}) × PER_SYMBOL_ORDERS_SHARE (${perSymbolShare}) > 1.0; ` +
                'either lower PER_SYMBOL_ORDERS_SHARE or cap MAX_OPEN_POSITIONS so per-symbol shares cannot exceed 100% of the ORDERS bucket.',
        );
    }

    static unknownOperation(operation: string): RateLimitConfigInvariantException {
        return new RateLimitConfigInvariantException(
            `No REQUEST_WEIGHT entry for ccxt operation '${operation}' — add it to FAPI_OPERATION_WEIGHTS or SAPI_OPERATION_WEIGHTS.`,
        );
    }

    static unknownBucket(className: string): RateLimitConfigInvariantException {
        return new RateLimitConfigInvariantException(
            `No rate-limit bucket matches class name '${className}'; refusing to silently default to RAW_REQUESTS_5M.`,
        );
    }
}
