import { DomainException } from '../../common/exception';

// M11a W1.4 (ADR 0030 §2.4). Thrown at `RateLimitPolicyService.onModuleInit`
// when the per-symbol ORDERS share × MAX_OPEN_POSITIONS exceeds 1.0 — the
// invariant that guarantees no single-symbol sub-bucket can starve the
// account-wide ORDERS bucket while the M4 3-slot model is active. Boot-time
// failure: a misconfiguration here would silently let one symbol monopolise
// the order quota for the whole UID.
export class RateLimitConfigInvariantException extends DomainException {
    constructor(maxOpenPositions: number, perSymbolShare: number) {
        super(
            'RATE_LIMIT_CONFIG_INVARIANT_VIOLATED',
            `MAX_OPEN_POSITIONS (${maxOpenPositions}) × PER_SYMBOL_ORDERS_SHARE (${perSymbolShare}) > 1.0; ` +
                'either lower PER_SYMBOL_ORDERS_SHARE or cap MAX_OPEN_POSITIONS so per-symbol shares cannot exceed 100% of the ORDERS bucket.',
        );
    }
}
