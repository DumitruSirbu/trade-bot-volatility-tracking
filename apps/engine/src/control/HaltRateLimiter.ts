import { HttpException, Injectable, Logger } from '@nestjs/common';

// M9 W3 (ADR 0021 §2.2). Per-`sub` sliding-window rate limit for the
// kill-switch endpoints — **5 toggles per 60 seconds**, sliding. Bypass for
// `scope=admin` is explicitly NOT granted: the admin scope is for
// revocation/rotation, not control-plane spam.
//
// In-memory and single-process by design — ADR 0021 §2.2 notes that a
// Redis-backed shared limiter is a future M11 concern (multi-operator). For
// the current single-engine deployment the in-memory window is correct.
//
// The first 5 toggles in any 60s window land unthrottled (the operator's
// panic-button presses are never rate-limited up-front). The 6th hits 429.

const WINDOW_MS = 60_000;
const MAX_TOGGLES_PER_WINDOW = 5;
// Periodic GC keeps the sub-map bounded. Each tick drops `sub` entries whose
// most-recent timestamp is older than `WINDOW_MS` so abandoned operators
// don't accumulate memory.
const GC_INTERVAL_MS = 5 * WINDOW_MS;

// Failure shape returned in the 429 body. Mirrors the `IAuthFailure` envelope
// (`error` + `reason`) so the dashboard's error-handling branch can stay
// uniform. `error: 'RATE_LIMITED'` distinguishes throttle from auth-failure
// in log triage.
export interface IRateLimitFailure {
    error: 'RATE_LIMITED';
    reason: 'TOO_MANY_HALT_TOGGLES';
    retryAfterSec: number;
}

@Injectable()
export class HaltRateLimiter {
    private readonly logger = new Logger(HaltRateLimiter.name);

    // Per-sub deque of toggle timestamps (ms). Oldest at index 0; bounded at
    // MAX_TOGGLES_PER_WINDOW * 2 entries via prune-on-touch + periodic GC.
    private readonly windows = new Map<string, number[]>();

    private lastGcAt = 0;

    // Pure function over an injected clock — adversarial tests pin `now` to
    // exercise the boundary (last-toggle at t=0 vs t=59_999 vs t=60_000).
    enforce(sub: string, now: Date): void {
        const nowMs = now.getTime();

        this.maybeGc(nowMs);

        const recent = this.pruneOlderThan(sub, nowMs - WINDOW_MS);

        if (recent.length >= MAX_TOGGLES_PER_WINDOW) {
            const oldest = recent[0];
            const retryAfterMs = WINDOW_MS - (nowMs - oldest);
            const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1_000));

            this.logger.warn(`halt.rate_limited sub=${sub} retryAfterSec=${retryAfterSec}`);

            const body: IRateLimitFailure = {
                error: 'RATE_LIMITED',
                reason: 'TOO_MANY_HALT_TOGGLES',
                retryAfterSec,
            };

            // HTTP 429; the response body matches `IRateLimitFailure`. Header
            // `Retry-After` is set by the controller from the same value so
            // RFC-conforming clients (curl, dashboard) can back off.
            throw new HttpException(body, 429);
        }

        recent.push(nowMs);
        this.windows.set(sub, recent);
    }

    // Test seam: drop all in-memory state.
    reset(): void {
        this.windows.clear();
        this.lastGcAt = 0;
    }

    private pruneOlderThan(sub: string, threshold: number): number[] {
        const current = this.windows.get(sub) ?? [];
        const fresh = current.filter((ts) => ts > threshold);

        return fresh;
    }

    private maybeGc(nowMs: number): void {
        if (nowMs - this.lastGcAt < GC_INTERVAL_MS) {
            return;
        }

        this.lastGcAt = nowMs;
        const threshold = nowMs - WINDOW_MS;

        for (const [sub, timestamps] of this.windows.entries()) {
            const fresh = timestamps.filter((ts) => ts > threshold);

            if (fresh.length === 0) {
                this.windows.delete(sub);
                continue;
            }

            this.windows.set(sub, fresh);
        }
    }
}

