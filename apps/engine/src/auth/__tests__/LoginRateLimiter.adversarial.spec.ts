/**
 * Adversarial tests for LoginRateLimiter persistence (M11a W1.9).
 *
 * Covers: boot hydration preserves throttled IPs, write-through upsert is
 * fire-and-forget (hot path is sync), persistence failure does not crash,
 * counters reset on the original cadences (persistence does not extend windows).
 */

import { HttpException } from '@nestjs/common';

import { LoginRateLimiter } from '../LoginRateLimiter';
import { LOGIN_PER_IP_BURST_MAX, LOGIN_PER_IP_BURST_WINDOW_MS, LOGIN_PER_IP_SUSTAINED_MAX, LOGIN_PER_IP_SUSTAINED_WINDOW_MS } from '../const/authConsts';

// ─── helpers ──────────────────────────────────────────────────────────────────

interface IFakePersistence {
    loadAll: jest.Mock<Promise<{ sourceIp: string; scope: string; timestampsMs: number[] }[]>, []>;
    upsert: jest.Mock<Promise<void>, [unknown, Date]>;
    deleteByKey: jest.Mock<Promise<void>, [string, string]>;
}

function buildPersistence(rows: { sourceIp: string; scope: string; timestampsMs: number[] }[] = []): IFakePersistence {
    return {
        loadAll: jest.fn<Promise<{ sourceIp: string; scope: string; timestampsMs: number[] }[]>, []>().mockResolvedValue(rows),
        upsert: jest.fn<Promise<void>, [unknown, Date]>().mockResolvedValue(undefined),
        deleteByKey: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    };
}

function buildLimiter(persistence: IFakePersistence): LoginRateLimiter {
    const alerts = { publish: jest.fn().mockResolvedValue(undefined) };
    return new LoginRateLimiter(alerts as never, persistence as never);
}

function dateAt(ms: number): Date {
    return new Date(ms);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('LoginRateLimiter — persistence adversarial (M11a W1.9)', () => {
    // ── Boot hydration preserves throttled IPs ────────────────────────────────

    describe('boot hydration from persistence', () => {
        it('a throttled IP stays throttled after restart (hydration from persisted burst window)', async () => {
            // BUILD — simulate a previously-persisted burst that is already full
            const ip = '1.2.3.4';
            const nowMs = Date.now();
            // Fill the burst window with LOGIN_PER_IP_BURST_MAX timestamps all within the window
            const burstTimestamps = Array.from({ length: LOGIN_PER_IP_BURST_MAX }, (_, i) => nowMs - (LOGIN_PER_IP_BURST_WINDOW_MS - 100 - i * 10));

            const persistence = buildPersistence([{ sourceIp: ip, scope: 'burst', timestampsMs: burstTimestamps }]);
            const limiter = buildLimiter(persistence);
            await limiter.onModuleInit();

            // OPERATE — one more attempt should trip the burst limit
            expect(() => limiter.enforce(ip, dateAt(nowMs))).toThrow(HttpException);
        });

        it('hydrated timestamps outside the window do not trigger throttling (stale rows do not persist throttle)', async () => {
            // BUILD — old timestamps outside the burst window (should be pruned on enforce)
            const ip = '5.6.7.8';
            const nowMs = Date.now();
            const staleTimestamps = Array.from({ length: LOGIN_PER_IP_BURST_MAX + 1 }, (_, i) => nowMs - LOGIN_PER_IP_BURST_WINDOW_MS - 1000 - i);

            const persistence = buildPersistence([{ sourceIp: ip, scope: 'burst', timestampsMs: staleTimestamps }]);
            const limiter = buildLimiter(persistence);
            await limiter.onModuleInit();

            // OPERATE + CHECK — stale timestamps are pruned; first attempt should pass
            expect(() => limiter.enforce(ip, dateAt(nowMs))).not.toThrow();
        });
    });

    // ── Write-through upsert is fire-and-forget ───────────────────────────────

    describe('write-through upsert is async (hot path remains synchronous)', () => {
        it('enforce() returns synchronously even when upsert is slow', async () => {
            // BUILD — upsert hangs indefinitely
            const resolvers: Array<() => void> = [];
            const slowPersistence = buildPersistence();
            slowPersistence.upsert.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        resolvers.push(resolve);
                    }),
            );

            const limiter = buildLimiter(slowPersistence);
            await limiter.onModuleInit();

            const ip = '10.0.0.1';
            const nowMs = Date.now();

            // OPERATE — enforce must complete without waiting for upsert
            let completed = false;
            const enforcePromise = new Promise<void>((resolve) => {
                try {
                    limiter.enforce(ip, dateAt(nowMs));
                } catch {
                    // ignore any throttle throws
                }
                completed = true;
                resolve();
            });

            await enforcePromise;

            // CHECK — enforce completed synchronously (before upsert resolved)
            expect(completed).toBe(true);
            // At least one upsert was called (fire-and-forget — still pending)
            expect(slowPersistence.upsert).toHaveBeenCalled();

            // Clean up — resolve all pending upserts
            for (const resolve of resolvers) resolve();
        });

        it('calls persistence.upsert on each enforce() call', async () => {
            // BUILD
            const persistence = buildPersistence();
            const limiter = buildLimiter(persistence);
            await limiter.onModuleInit();

            const ip = '9.8.7.6';
            const nowMs = Date.now();

            // OPERATE
            try {
                limiter.enforce(ip, dateAt(nowMs));
            } catch {
                // ignore throttle
            }

            // Flush micro-tasks for the fire-and-forget promise
            await new Promise((resolve) => setImmediate(resolve));

            // CHECK — upsert should be called for burst + sustained + global (3 scopes)
            expect(persistence.upsert).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: ip, scope: 'burst' }), expect.any(Date));
        });
    });

    // ── Persistence failure does not crash ────────────────────────────────────

    describe('persistence failure is handled gracefully', () => {
        it('does not throw when persistence.upsert rejects', async () => {
            // BUILD — upsert always fails
            const failingPersistence = buildPersistence();
            failingPersistence.upsert.mockRejectedValue(new Error('DB connection lost'));

            const limiter = buildLimiter(failingPersistence);
            await limiter.onModuleInit();

            // OPERATE + CHECK
            expect(() => limiter.enforce('1.1.1.1', new Date())).not.toThrow(Error);

            // Drain micro-tasks; the rejection must be swallowed
            await new Promise((resolve) => setImmediate(resolve));
        });

        it('does not crash when persistence.loadAll fails at boot', async () => {
            // BUILD
            const failingPersistence = buildPersistence();
            failingPersistence.loadAll.mockRejectedValue(new Error('DB unavailable'));

            const limiter = buildLimiter(failingPersistence);

            // OPERATE + CHECK — onModuleInit must not throw
            await expect(limiter.onModuleInit()).resolves.toBeUndefined();
        });

        it('starts with empty state after boot hydration failure', async () => {
            // BUILD
            const failingPersistence = buildPersistence();
            failingPersistence.loadAll.mockRejectedValue(new Error('DB unavailable'));

            const limiter = buildLimiter(failingPersistence);
            await limiter.onModuleInit();

            // OPERATE — should be a fresh limiter (no prior state)
            expect(() => limiter.enforce('2.2.2.2', new Date())).not.toThrow();
        });
    });

    // ── Counters reset on original cadences ───────────────────────────────────

    describe('counters reset on original burst cadence (persistence does not extend window)', () => {
        it('burst limit resets after the burst window expires, not longer', async () => {
            // BUILD
            const persistence = buildPersistence();
            const limiter = buildLimiter(persistence);
            await limiter.onModuleInit();

            const ip = '3.3.3.3';
            const startMs = Date.now();

            // Saturate the burst window
            for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i++) {
                limiter.enforce(ip, dateAt(startMs + i));
            }

            // Verify it's now throttled
            expect(() => limiter.enforce(ip, dateAt(startMs + LOGIN_PER_IP_BURST_MAX))).toThrow(HttpException);

            // OPERATE — advance past the burst window
            const afterWindowMs = startMs + LOGIN_PER_IP_BURST_WINDOW_MS + 100;

            // CHECK — should not be throttled after window expires
            expect(() => limiter.enforce(ip, dateAt(afterWindowMs))).not.toThrow();
        });

        it('sustained limit resets after the sustained window expires', async () => {
            // BUILD
            const persistence = buildPersistence();
            const limiter = buildLimiter(persistence);
            await limiter.onModuleInit();

            const ip = '4.4.4.4';
            const startMs = Date.now();

            // Spread attempts across many burst windows to avoid burst throttle
            // while saturating the sustained window
            for (let i = 0; i < LOGIN_PER_IP_SUSTAINED_MAX; i++) {
                // Advance by burst window each attempt so burst never triggers
                const attemptMs = startMs + i * (LOGIN_PER_IP_BURST_WINDOW_MS + 1);
                limiter.enforce(ip, dateAt(attemptMs));
            }

            const lastAttemptMs = startMs + LOGIN_PER_IP_SUSTAINED_MAX * (LOGIN_PER_IP_BURST_WINDOW_MS + 1);

            // Verify it's now throttled on sustained
            expect(() => limiter.enforce(ip, dateAt(lastAttemptMs))).toThrow(HttpException);

            // OPERATE — advance past the sustained window from the earliest timestamp
            const afterWindowMs = startMs + LOGIN_PER_IP_SUSTAINED_WINDOW_MS + LOGIN_PER_IP_BURST_WINDOW_MS + 1000;

            // CHECK — sustained window has expired for all earlier attempts
            expect(() => limiter.enforce(ip, dateAt(afterWindowMs))).not.toThrow();
        });
    });
});
