export interface IRateLimitFailure {
    error: 'RATE_LIMITED';
    reason: 'TOO_MANY_HALT_TOGGLES' | 'TOO_MANY_LOGIN_ATTEMPTS';
    retryAfterSec: number;
}
