// M11a W1.4 (ADR 0030 §2.2). Contract owned by ExchangeModule. The concrete
// implementation (RateLimitPolicyService) ships in-process buckets per the
// four Binance Futures weight classes; M11b will swap the impl for a
// Redis-backed shared limiter behind the same interface.

export type RateLimitAcquisitionMode = 'fail-fast' | 'await';

// Stable per-call descriptor. The helper that builds this (in the exchange
// client) is the single point that maps ccxt operation names -> weight; an
// unknown operation throws so no call site can drift past the limiter.
export interface IRateLimitedCall {
    readonly operation: string;
    readonly requestWeight: number;
    readonly isOrderOp: boolean;
    readonly symbol: string | null;
    readonly mode: RateLimitAcquisitionMode;
    readonly maxWaitMs: number | null;
}

// Parsed Binance rate-limit headers (per ADR 0030 §2.5). Values are absolute
// per-window USED counts as reported by the venue. `null` means the venue
// did not return the header on this response.
export interface IRateLimitHeaders {
    readonly usedWeight1m: number | null;
    readonly orderCount10s: number | null;
    readonly orderCount1m: number | null;
    readonly retryAfterSec: number | null;
    readonly responseStatus: number | null;
}

// Snapshot returned by `snapshot()` for /v1/health and the read API. Per-class
// shape matches the bucket configuration.
export interface IRateLimitClassSnapshot {
    readonly className: string;
    readonly capacity: number;
    readonly currentTokens: number;
    readonly windowMs: number;
}

export interface IRateLimitSnapshot {
    readonly classes: ReadonlyArray<IRateLimitClassSnapshot>;
    readonly frozenUntilMs: number | null;
    readonly lastDriftPct: number | null;
}

export interface IRateLimitPolicy {
    // Reserve tokens for one call across every class the call counts against.
    // Returns when capacity is available; wait/reject behaviour is determined
    // by `call.mode` (ADR 0030 §2.3).
    acquire(call: IRateLimitedCall): Promise<void>;

    // Apply authoritative state from Binance response headers (ADR 0030 §2.5).
    // Called after every REST response — success and failure.
    reconcileFromHeaders(headers: IRateLimitHeaders): void;

    snapshot(): IRateLimitSnapshot;
}

// DI token — the interface is erased at runtime, so providers bind to this.
export const RATE_LIMIT_POLICY = Symbol('RATE_LIMIT_POLICY');
