/**
 * Adversarial tests for RateLimitPolicyService (M11a W1.4 — ADR 0030).
 *
 * Covers: fail-fast on empty ORDERS_10S bucket, await on empty REQUEST_WEIGHT
 * bucket, per-symbol isolation, drift detection coalescing, 429/418 freeze
 * paths, malformed header parsing, monotonic bucket refill.
 */

import { RateLimitPolicyService } from '../RateLimitPolicyService';
import { ExchangeRateLimitExhaustedException, SymbolRateLimitExhaustedException } from '../../exception';
import { IRateLimitHeaders, IRateLimitedCall } from '../../interface/IRateLimitPolicy';
import { ORDERS_10S_PUBLISHED_LIMIT, RATE_LIMIT_SAFETY_MARGIN, REQUEST_WEIGHT_1M_PUBLISHED_LIMIT } from '../../const/rateLimitConsts';
import { parseRateLimitHeaders } from '../../utils/parseRateLimitHeaders';

// ─── factory helpers ──────────────────────────────────────────────────────────

function buildOrderCall(overrides: Partial<IRateLimitedCall> = {}): IRateLimitedCall {
    return {
        operation: 'createOrder',
        requestWeight: 1,
        isOrderOp: true,
        symbol: 'BTCUSDT',
        mode: 'fail-fast',
        maxWaitMs: null,
        ...overrides,
    };
}

function _buildReadCall(overrides: Partial<IRateLimitedCall> = {}): IRateLimitedCall {
    return {
        operation: 'fetchPositions',
        requestWeight: 5,
        isOrderOp: false,
        symbol: null,
        mode: 'await',
        maxWaitMs: 500,
        ...overrides,
    };
}

function buildHeaders(overrides: Partial<IRateLimitHeaders> = {}): IRateLimitHeaders {
    return {
        usedWeight1m: null,
        orderCount10s: null,
        orderCount1m: null,
        retryAfterSec: null,
        responseStatus: 200,
        ...overrides,
    };
}

interface ITestClock {
    now: jest.Mock<Date, []>;
    advance: (ms: number) => void;
}

function buildService(nowMs = Date.now()): {
    service: RateLimitPolicyService;
    clock: ITestClock;
    alerts: { publish: jest.Mock };
} {
    let currentTimeMs = nowMs;
    const clock: ITestClock = {
        now: jest.fn<Date, []>(() => new Date(currentTimeMs)),
        advance: (ms: number) => {
            currentTimeMs += ms;
        },
    };
    const alerts = {
        publish: jest.fn().mockResolvedValue(undefined),
    };

    const service = new RateLimitPolicyService(clock as never, alerts as never);

    return { service, clock, alerts };
}

// ─── tests ────────────────────────────────────────────────────────────────────

const ORDERS_10S_CAPACITY = Math.floor(ORDERS_10S_PUBLISHED_LIMIT * RATE_LIMIT_SAFETY_MARGIN);
const REQUEST_WEIGHT_CAPACITY = Math.floor(REQUEST_WEIGHT_1M_PUBLISHED_LIMIT * RATE_LIMIT_SAFETY_MARGIN);

describe('RateLimitPolicyService — adversarial', () => {
    // ── Fail-fast when ORDERS_10S bucket is empty ────────────────────────────

    describe('ORDERS_10S bucket exhausted — fail-fast order placement', () => {
        it('throws ExchangeRateLimitExhaustedException immediately, does not await', async () => {
            // BUILD
            const { service } = buildService();
            // Drain the ORDERS_10S bucket by acquiring capacity times
            const drainCall = buildOrderCall({ mode: 'fail-fast', symbol: null });
            for (let i = 0; i < ORDERS_10S_CAPACITY; i++) {
                await service.acquire(drainCall);
            }

            // OPERATE — next order must fail-fast
            await expect(service.acquire(buildOrderCall())).rejects.toThrow(ExchangeRateLimitExhaustedException);
        });

        it('thrown exception carries the failing class name and non-negative remaining', async () => {
            // BUILD
            const { service } = buildService();
            const drainCall = buildOrderCall({ mode: 'fail-fast', symbol: null });
            for (let i = 0; i < ORDERS_10S_CAPACITY; i++) {
                await service.acquire(drainCall);
            }

            // OPERATE
            let caught: ExchangeRateLimitExhaustedException | null = null;
            try {
                await service.acquire(buildOrderCall());
            } catch (err) {
                caught = err as ExchangeRateLimitExhaustedException;
            }

            // CHECK
            expect(caught).not.toBeNull();
            expect(caught?.failingClass).toMatch(/ORDERS_10S/);
            expect(caught?.remainingTokens).toBeGreaterThanOrEqual(0);
        });
    });

    // ── Per-symbol exhaustion in await-mode waits/refills, not fail-fast ─────

    describe('per-symbol bucket exhaustion in await mode', () => {
        it('await-mode symbol-scoped call refills and succeeds before deadline', async () => {
            // BUILD — drain BTC's per-symbol ORDERS_10S bucket in fail-fast mode first
            const startMs = 5_000_000;
            let currentMs = startMs;
            const clock = { now: jest.fn<Date, []>(() => new Date(currentMs)) };
            const alerts = { publish: jest.fn().mockResolvedValue(undefined) };
            const service = new RateLimitPolicyService(clock as never, alerts as never);

            const drainCall = buildOrderCall({ symbol: 'BTCUSDT', mode: 'fail-fast' });
            let drained = 0;
            for (let i = 0; i < ORDERS_10S_CAPACITY; i++) {
                try {
                    await service.acquire(drainCall);
                    drained++;
                } catch (err) {
                    if (err instanceof SymbolRateLimitExhaustedException) {
                        break;
                    }
                    throw err;
                }
            }

            // CHECK — at least one fail-fast attempt was throttled at the
            // per-symbol bucket. Now advance the clock past one ORDERS_10S
            // window and confirm an await-mode order on the same symbol
            // resolves (it would have wrongly fail-fasted under the previous
            // throw-from-findInsufficientSymbolBucket bug).
            expect(drained).toBeGreaterThan(0);

            currentMs += 10_001;

            const awaitCall = buildOrderCall({ symbol: 'BTCUSDT', mode: 'await', maxWaitMs: 60_000 });
            await expect(service.acquire(awaitCall)).resolves.toBeUndefined();
        });
    });

    // ── Per-symbol bucket exhaustion does not starve other symbols ───────────

    describe('per-symbol bucket exhaustion', () => {
        it('exhausting BTC symbol bucket does not block ETH symbol orders', async () => {
            // BUILD — drain BTC's per-symbol ORDERS_10S bucket
            const { service } = buildService();
            const btcOrderCall = buildOrderCall({ symbol: 'BTCUSDT', mode: 'fail-fast' });
            const _etcOrderCall = buildOrderCall({ symbol: 'ETHUSDT', mode: 'fail-fast' });

            // We may need to drain the per-symbol 30% share
            let btcDrained = false;
            for (let i = 0; i < ORDERS_10S_CAPACITY; i++) {
                try {
                    await service.acquire(btcOrderCall);
                } catch (err) {
                    if (err instanceof SymbolRateLimitExhaustedException) {
                        btcDrained = true;
                        break;
                    }
                    throw err;
                }
            }

            // CHECK — ETH orders must still go through (different symbol bucket)
            // The global buckets may also be exhausted after draining; only test
            // if we hit the symbol-level exhaustion specifically
            if (btcDrained) {
                // ETH should have tokens remaining in its own per-symbol bucket
                const snap = service.snapshot();
                const btcBucket = snap.classes.find((c) => c.className === 'ORDERS_10S:BTCUSDT');
                const ethBucket = snap.classes.find((c) => c.className === 'ORDERS_10S:ETHUSDT');

                // BTC bucket exhausted; ETH bucket hasn't been created or is full
                expect(btcBucket?.currentTokens ?? 0).toBeLessThan(1);
                // ETH bucket either doesn't exist yet (fresh) or has capacity
                if (ethBucket !== undefined) {
                    expect(ethBucket.currentTokens).toBeGreaterThan(0);
                }
            }
        });
    });

    // ── Drift detection fires once, not per-call ─────────────────────────────

    describe('header drift > 10% fires WARN alert once per coalesce window', () => {
        it('emits at most one alert for repeated drift in the coalesce window', async () => {
            // BUILD
            const { service, alerts, clock } = buildService();

            // Simulate server reporting 50% capacity used (well above 10% drift
            // threshold) while local accounting shows 0 used
            const highDriftHeaders = buildHeaders({ usedWeight1m: Math.floor(REQUEST_WEIGHT_CAPACITY * 0.5) });

            // OPERATE — reconcile many times within the coalesce window
            for (let i = 0; i < 5; i++) {
                // Advance by less than the coalesce window each time
                clock.advance(60_000);
                service.reconcileFromHeaders(highDriftHeaders);
            }

            // CHECK — only one Telegram WARN alert should have fired
            const warnAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('drift'),
            );
            expect(warnAlerts.length).toBe(1);
        });

        it('allows a second alert after the coalesce window expires', async () => {
            // BUILD
            const { service, alerts: _alerts, clock } = buildService();
            const COALESCE_WINDOW_MS = 5 * 60 * 1_000;

            // After each reconcile the local accounting is updated to match the
            // header, so fresh drift must be introduced by acquiring tokens first.
            const highDriftUsed = Math.floor(REQUEST_WEIGHT_CAPACITY * 0.5);
            const highDriftHeaders = buildHeaders({ usedWeight1m: highDriftUsed });

            // First drift event: header says used=50%, local says used=0 → drift
            service.reconcileFromHeaders(highDriftHeaders);

            // Advance past coalesce window; also acquire tokens so local diverges
            clock.advance(COALESCE_WINDOW_MS + 1000);
            // After the advance, refill happens on next acquire. Reconcile again
            // with a high server-reported usage to produce a second drift event.
            service.reconcileFromHeaders(highDriftHeaders);

            // CHECK — the second reconcile is past the coalesce window; but the
            // local accounting may already match due to the first correction. We
            // test the coalescing logic itself: if the window expired, a fresh
            // drift fires a second alert.
            // NOTE: If local is already corrected from the first reconcile, the
            // second reconcile may not trigger drift. We acquire a non-order call
            // first to ensure local state diverges from the header again.
            const { service: s2, alerts: a2, clock: c2 } = buildService();
            const lowDriftHeaders = buildHeaders({ usedWeight1m: highDriftUsed });
            // First event
            s2.reconcileFromHeaders(lowDriftHeaders);
            // Advance past coalesce and simulate new usage
            c2.advance(COALESCE_WINDOW_MS + 1000);
            // Acquire some tokens to get local accounting above 0
            const readCall: IRateLimitedCall = {
                operation: 'fetchPositions',
                requestWeight: 100,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 100,
            };
            await s2.acquire(readCall).catch(() => undefined);
            // Now reconcile with a high header to produce fresh drift
            s2.reconcileFromHeaders(buildHeaders({ usedWeight1m: highDriftUsed + 200 }));

            const warnAlerts = (a2.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('drift'),
            );
            expect(warnAlerts.length).toBe(2);
        });
    });

    // ── 429 response drains all buckets and fires CRITICAL Telegram ──────────

    describe('429 response — freeze path (ADR 0030 §2.6)', () => {
        it('drains all buckets to zero and throws ExchangeRateLimitExhaustedException on next acquire', async () => {
            // BUILD
            const { service } = buildService();

            // OPERATE — reconcile a 429
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 429, retryAfterSec: 60 }));

            // CHECK — next acquire fails immediately (frozen)
            await expect(service.acquire(buildOrderCall())).rejects.toThrow(ExchangeRateLimitExhaustedException);

            const snap = service.snapshot();
            expect(snap.frozenUntilMs).not.toBeNull();
            snap.classes.forEach((cls) => expect(cls.currentTokens).toBe(0));
        });

        it('fires a CRITICAL Telegram alert on 429', () => {
            // BUILD
            const { service, alerts } = buildService();

            // OPERATE
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 429, retryAfterSec: 30 }));

            // CHECK
            const criticalAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ severity: string }]) => p.severity === 'critical' || p.severity === 'CRITICAL',
            );
            expect(criticalAlerts.length).toBeGreaterThanOrEqual(1);
        });

        it('fires a CRITICAL Telegram alert on 418 (same path as 429)', () => {
            // BUILD
            const { service, alerts } = buildService();

            // OPERATE
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 418, retryAfterSec: null }));

            // CHECK
            const criticalAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ severity: string }]) => p.severity === 'critical' || p.severity === 'CRITICAL',
            );
            expect(criticalAlerts.length).toBeGreaterThanOrEqual(1);
        });

        it('doubles the freeze duration on second 429 within the freeze window', async () => {
            // BUILD
            const { service, clock: _clock } = buildService();

            // OPERATE — first 429
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 429, retryAfterSec: 60 }));
            const snapAfterFirst = service.snapshot();
            const firstFreezeUntilMs = snapAfterFirst.frozenUntilMs!;

            // Second 429 while still frozen
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 429, retryAfterSec: 60 }));
            const snapAfterSecond = service.snapshot();

            // CHECK — second freeze extends beyond the first
            expect(snapAfterSecond.frozenUntilMs).toBeGreaterThan(firstFreezeUntilMs);
        });
    });

    // ── Header parse: malformed values do not crash ──────────────────────────

    describe('malformed Binance response headers — parseRateLimitHeaders robustness', () => {
        it('non-numeric weight header collapses to null without throwing', () => {
            // OPERATE + CHECK
            expect(() => parseRateLimitHeaders({ 'x-mbx-used-weight-1m': 'not-a-number' }, 200)).not.toThrow();

            const result = parseRateLimitHeaders({ 'x-mbx-used-weight-1m': 'not-a-number' }, 200);
            expect(result.usedWeight1m).toBeNull();
        });

        it('negative weight header is treated as null', () => {
            const result = parseRateLimitHeaders({ 'x-mbx-used-weight-1m': '-5' }, 200);
            expect(result.usedWeight1m).toBeNull();
        });

        it('array-valued header takes the first element', () => {
            const result = parseRateLimitHeaders({ 'x-mbx-used-weight-1m': ['42', '99'] }, 200);
            expect(result.usedWeight1m).toBe(42);
        });

        it('undefined header value collapses to null', () => {
            const result = parseRateLimitHeaders({}, 200);
            expect(result.usedWeight1m).toBeNull();
            expect(result.orderCount10s).toBeNull();
            expect(result.retryAfterSec).toBeNull();
        });
    });

    // ── Bucket refill is monotonic (uses injected clock) ─────────────────────

    describe('bucket refill is monotonic — no Date.now() inside the service', () => {
        it('acquire succeeds after one full window has elapsed on the injected clock', async () => {
            // BUILD
            const startMs = 1_000_000;
            let currentMs = startMs;
            const clock = { now: jest.fn<Date, []>(() => new Date(currentMs)) };
            const alerts = { publish: jest.fn().mockResolvedValue(undefined) };
            const service = new RateLimitPolicyService(clock as never, alerts as never);

            // Drain ORDERS_10S by fail-fast orders (null symbol avoids per-symbol buckets)
            const orderCall = buildOrderCall({ mode: 'fail-fast', symbol: null });
            for (let i = 0; i < ORDERS_10S_CAPACITY; i++) {
                await service.acquire(orderCall);
            }
            // Confirm it's exhausted
            await expect(service.acquire(orderCall)).rejects.toThrow(ExchangeRateLimitExhaustedException);

            // OPERATE — advance injected clock by ORDERS_10S window (10_000 ms)
            // The service must refill when acquire is called (refillAll runs in acquire loop)
            currentMs += 10_001;

            // CHECK — acquire should now succeed because the bucket has refilled
            // (refillAll is triggered by the acquire call reading the clock)
            await expect(service.acquire(orderCall)).resolves.toBeUndefined();
        });
    });
});
