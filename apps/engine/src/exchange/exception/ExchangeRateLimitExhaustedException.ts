import { DomainException } from '../../common/exception';

// M11a W1.4 (ADR 0030 §2.3). Thrown by IRateLimitPolicy.acquire() when the
// caller declared `fail-fast` mode and any class is below the call's cost,
// OR when an `await`-mode caller's `maxWaitMs` budget elapses, OR when the
// limiter is currently frozen under a 429/418 backoff window (ADR §2.6).
//
// The execution layer treats this as a first-class "miss" outcome — never as
// a transient error to retry. ccxt's own retry-on-network-error path MUST NOT
// rewrap and retry this exception (it would amplify a 418 ban).
export class ExchangeRateLimitExhaustedException extends DomainException {
    constructor(
        readonly failingClass: string,
        readonly remainingTokens: number,
        readonly retryAfterMs: number | null,
    ) {
        super(
            'EXCHANGE_RATE_LIMIT_EXHAUSTED',
            `Rate-limit class ${failingClass} exhausted (remaining=${remainingTokens}, retryAfterMs=${retryAfterMs ?? 'n/a'})`,
        );
    }
}

// ADR 0030 §2.4 — distinct subclass so the strategy logs the cause correctly
// ("this symbol is throttled" vs "the whole UID is throttled").
export class SymbolRateLimitExhaustedException extends ExchangeRateLimitExhaustedException {
    constructor(
        readonly symbol: string,
        failingClass: string,
        remainingTokens: number,
    ) {
        super(`${failingClass}:${symbol}`, remainingTokens, null);
    }
}
