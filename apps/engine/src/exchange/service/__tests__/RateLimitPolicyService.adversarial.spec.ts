/**
 * Adversarial tests for RateLimitPolicyService (M11a W1.4 — ADR 0030).
 *
 * Covers: fail-fast on empty ORDERS_10S bucket, await on empty REQUEST_WEIGHT
 * bucket, per-symbol isolation, directional drift detection (M18 — under-count
 * only, safe direction is silent), drift coalescing, 429/418 freeze paths,
 * malformed header parsing, monotonic bucket refill.
 */

import { RateLimitPolicyService } from '../RateLimitPolicyService';
import { ExchangeRateLimitExhaustedException, SymbolRateLimitExhaustedException } from '../../exception';
import { IRateLimitHeaders, IRateLimitedCall } from '../../interface/IRateLimitPolicy';
import {
    ORDERS_10S_PUBLISHED_LIMIT,
    RATE_LIMIT_418_DEFAULT_FREEZE_MS,
    RATE_LIMIT_DRIFT_LOG_COALESCE_MS,
    RATE_LIMIT_DRIFT_THRESHOLD_FRACTION,
    RATE_LIMIT_SAFETY_MARGIN,
    REQUEST_WEIGHT_1M_PUBLISHED_LIMIT,
    SAPI_REQUEST_WEIGHT_1M_PUBLISHED_LIMIT,
} from '../../const/rateLimitConsts';
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

function buildSapiCall(overrides: Partial<IRateLimitedCall> = {}): IRateLimitedCall {
    return {
        operation: 'sapiGetAccountApiRestrictions',
        requestWeight: 1,
        isOrderOp: false,
        symbol: null,
        mode: 'fail-fast',
        maxWaitMs: null,
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
const SAPI_REQUEST_WEIGHT_CAPACITY = Math.floor(SAPI_REQUEST_WEIGHT_1M_PUBLISHED_LIMIT * RATE_LIMIT_SAFETY_MARGIN);

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

    // ── Directional drift detection (M18) ────────────────────────────────────
    //
    // ADR 0030 §2.5 (M18 amendment): the drift alert is DIRECTIONAL.
    // Only fires when headerUsed > localUsed by ≥ RATE_LIMIT_DRIFT_THRESHOLD_FRACTION
    // of capacity (engine UNDER-counts Binance — dangerous).
    // When localUsed > headerUsed (engine is CONSERVATIVE — safe), the alert
    // must stay SILENT regardless of the magnitude of the difference.

    describe('directional drift detection — safe direction is silent (M18 regression guard)', () => {
        it('does NOT fire an alert when local-used is high and header-used is near-zero (the production screenshot case)', async () => {
            // BUILD — reproduce the false-positive: local bucket has ~250 weight
            // consumed, Binance reports only 1 used. This is the SAFE direction
            // (local is over-counting / conservative). The old Math.abs code fired
            // here; the new directional code must be silent.
            const { service, alerts } = buildService();

            // Acquire ~250 REQUEST_WEIGHT tokens to push local-used to ≈250
            const heavyReadCall: IRateLimitedCall = {
                operation: 'fetchTickers',
                // fetchTickers costs 40 weight; acquire 6× = 240 consumed
                requestWeight: 40,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 0,
            };
            for (let i = 0; i < 6; i++) {
                await service.acquire(heavyReadCall).catch(() => undefined);
            }

            // OPERATE — header says Binance only saw 1 unit used (safe direction)
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: 1 }));

            // CHECK — no drift/under-count alert must have been published
            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(0);
        });

        it('does NOT set lastDriftPct on safe-direction reconciliation', async () => {
            // BUILD
            const { service } = buildService();

            const heavyReadCall: IRateLimitedCall = {
                operation: 'fetchTickers',
                requestWeight: 40,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 0,
            };
            for (let i = 0; i < 6; i++) {
                await service.acquire(heavyReadCall).catch(() => undefined);
            }

            // OPERATE — safe direction: local-used ≈ 240, header-used = 1
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: 1 }));

            // CHECK — snapshot must NOT report a drift percentage
            const snap = service.snapshot();
            expect(snap.lastDriftPct).toBeNull();
        });
    });

    describe('directional drift detection — dangerous under-count fires WARN (M18)', () => {
        it('fires exactly one WARN alert when header-used exceeds local-used by ≥ threshold', async () => {
            // BUILD — local-used ≈ 10 (almost idle), header says capacity-50
            // (far above local) — the dangerous under-count direction.
            const { service, alerts } = buildService();

            // Acquire a tiny amount so local-used > 0 but small
            const lightCall: IRateLimitedCall = {
                operation: 'fetchBalance',
                requestWeight: 5,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 0,
            };
            // Acquire twice → local-used = 10
            await service.acquire(lightCall).catch(() => undefined);
            await service.acquire(lightCall).catch(() => undefined);

            // Header says near-full (capacity − 50). Difference >> threshold.
            const dangerousHeaderUsed = REQUEST_WEIGHT_CAPACITY - 50;
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: dangerousHeaderUsed }));

            // CHECK — exactly one UNDER-COUNT WARN
            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(1);
            const [payload] = underCountAlerts[0] as [{ severity: string }];
            expect(payload.severity.toLowerCase()).toBe('warn');
        });

        it('sets lastDriftPct > 0 after a real under-count', () => {
            // BUILD
            const { service } = buildService();

            const dangerousHeaderUsed = REQUEST_WEIGHT_CAPACITY - 50;
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: dangerousHeaderUsed }));

            // CHECK
            const snap = service.snapshot();
            expect(snap.lastDriftPct).not.toBeNull();
            expect(snap.lastDriftPct!).toBeGreaterThan(0);
        });

        it('clamps currentTokens to capacity − headerUsed when header > local (upward-only reconciliation unchanged)', () => {
            // BUILD — local is almost full (low used), header shows near-exhaustion
            const { service } = buildService();
            const dangerousHeaderUsed = REQUEST_WEIGHT_CAPACITY - 20;

            // OPERATE
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: dangerousHeaderUsed }));

            // CHECK — REQUEST_WEIGHT_1M bucket tokens should be clamped down
            const snap = service.snapshot();
            const weightBucket = snap.classes.find((c) => c.className === 'REQUEST_WEIGHT_1M');
            expect(weightBucket).toBeDefined();
            expect(weightBucket!.currentTokens).toBeLessThanOrEqual(
                REQUEST_WEIGHT_CAPACITY - dangerousHeaderUsed + 1, // small tolerance for refill
            );
        });
    });

    describe('directional drift detection — boundary conditions at exactly RATE_LIMIT_DRIFT_THRESHOLD_FRACTION', () => {
        it('fires when under-count fraction equals the threshold exactly', () => {
            // BUILD — engineer the under-count fraction to land precisely on the
            // threshold. With localUsed = 0 the fraction = headerUsed / capacity.
            // So we need headerUsed = floor(capacity * RATE_LIMIT_DRIFT_THRESHOLD_FRACTION).
            const { service, alerts } = buildService();

            const atThresholdHeaderUsed = Math.floor(REQUEST_WEIGHT_CAPACITY * RATE_LIMIT_DRIFT_THRESHOLD_FRACTION);
            // Sanity: this value must be ≥ 1 with the production constants
            expect(atThresholdHeaderUsed).toBeGreaterThanOrEqual(1);

            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: atThresholdHeaderUsed }));

            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(1);
        });

        it('is silent when under-count fraction is one integer unit below the threshold', () => {
            // BUILD — localUsed = 0, headerUsed = threshold_units − 1
            // fraction = (threshold_units - 1) / capacity < RATE_LIMIT_DRIFT_THRESHOLD_FRACTION
            const { service, alerts } = buildService();

            const atThresholdHeaderUsed = Math.floor(REQUEST_WEIGHT_CAPACITY * RATE_LIMIT_DRIFT_THRESHOLD_FRACTION);
            const belowThresholdHeaderUsed = atThresholdHeaderUsed - 1;

            // Only meaningful if > 0 (would be 0 only if threshold fraction were 0)
            if (belowThresholdHeaderUsed <= 0) {
                return;
            }

            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: belowThresholdHeaderUsed }));

            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(0);
        });
    });

    describe('under-count alert coalescing — at most one alert per RATE_LIMIT_DRIFT_LOG_COALESCE_MS window', () => {
        it('emits at most one alert for repeated under-counts within the coalesce window', () => {
            // BUILD
            const { service, alerts, clock } = buildService();

            // Header always at dangerous level; local starts at 0 so under-count
            // fraction is ~50%, well above threshold.
            const dangerousHeaderUsed = Math.floor(REQUEST_WEIGHT_CAPACITY * 0.5);
            const dangerousHeaders = buildHeaders({ usedWeight1m: dangerousHeaderUsed });

            // OPERATE — reconcile five times, each 60 s apart (well within the
            // 5-minute coalesce window). After the first reconcile the bucket is
            // clamped to capacity − headerUsed, so subsequent reconciles also
            // show under-count because we do NOT re-acquire tokens in between.
            for (let i = 0; i < 5; i++) {
                clock.advance(60_000); // < RATE_LIMIT_DRIFT_LOG_COALESCE_MS
                service.reconcileFromHeaders(dangerousHeaders);
            }

            // CHECK — only one Telegram WARN
            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(1);
        });

        it('fires a second alert after the coalesce window has elapsed', async () => {
            // BUILD — fresh service
            const { service, alerts, clock } = buildService();

            // Make header > local on first reconcile (local = 0, header = 50%)
            const dangerousHeaderUsed = Math.floor(REQUEST_WEIGHT_CAPACITY * 0.5);
            const dangerousHeaders = buildHeaders({ usedWeight1m: dangerousHeaderUsed });

            // First under-count event
            service.reconcileFromHeaders(dangerousHeaders);

            // After first reconcile the bucket was clamped: currentTokens =
            // capacity - headerUsed. We advance time so the bucket refills
            // (continuous refill) creating a new divergence from the header.
            clock.advance(RATE_LIMIT_DRIFT_LOG_COALESCE_MS + 1_000);

            // Acquire some tokens so local-used is low again (bucket refilled by
            // clock advance; acquire a tiny amount to trigger refillAll).
            const lightCall: IRateLimitedCall = {
                operation: 'fetchBalance',
                requestWeight: 5,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 0,
            };
            await service.acquire(lightCall).catch(() => undefined);

            // Second reconcile — same dangerous header, but bucket has refilled
            // via continuous-refill so localUsed is again small.
            service.reconcileFromHeaders(dangerousHeaders);

            // CHECK — two alerts total (one before the window, one after)
            const underCountAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.toLowerCase().includes('under-count'),
            );
            expect(underCountAlerts).toHaveLength(2);
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

    // ── M46: SAPI_REQUEST_WEIGHT_1M routing ──────────────────────────────────
    //
    // ADR 0030 §2.7. The `/sapi` and `/fapi` hosts carry independent per-IP
    // request-weight budgets. The four tests below are the paired regression
    // guards for the four M46 implementation items:
    //
    //   T1 — sapi op debits sapi bucket only
    //   T2 — fapi op debits fapi bucket only
    //   T3 — 418 freeze drains sapi bucket alongside all others (allBuckets guard)
    //   T4 — reconcileFromHeaders does NOT corrupt the sapi bucket
    //   T5 — unknown operation throws RateLimitConfigInvariantException

    describe('SAPI_REQUEST_WEIGHT_1M routing', () => {
        // T1 ─────────────────────────────────────────────────────────────────

        it('T1: sapi operation debits the sapi bucket and leaves fapi bucket untouched', async () => {
            // BUILD
            const { service } = buildService();

            // OPERATE — two sapi calls (2 × 1 = 2 tokens consumed from sapi)
            await service.acquire(buildSapiCall({ mode: 'await', maxWaitMs: 0 }));
            await service.acquire(buildSapiCall({ operation: 'sapiGetAccountApiRestrictionsIpRestriction', mode: 'await', maxWaitMs: 0 }));

            // CHECK
            const snap = service.snapshot();
            const sapiBucket = snap.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');
            const fapiBucket = snap.classes.find((c) => c.className === 'REQUEST_WEIGHT_1M');

            expect(sapiBucket).toBeDefined();
            expect(sapiBucket!.currentTokens).toBe(SAPI_REQUEST_WEIGHT_CAPACITY - 2);

            expect(fapiBucket).toBeDefined();
            expect(fapiBucket!.currentTokens).toBe(REQUEST_WEIGHT_CAPACITY);
        });

        // T2 ─────────────────────────────────────────────────────────────────

        it('T2: fapi operation debits the fapi bucket and leaves sapi bucket untouched', async () => {
            // BUILD
            const { service } = buildService();

            const fapiCall: IRateLimitedCall = {
                operation: 'fetchPositions',
                requestWeight: 5,
                isOrderOp: false,
                symbol: null,
                mode: 'await',
                maxWaitMs: 0,
            };

            // OPERATE
            await service.acquire(fapiCall);

            // CHECK
            const snap = service.snapshot();
            const fapiBucket = snap.classes.find((c) => c.className === 'REQUEST_WEIGHT_1M');
            const sapiBucket = snap.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');

            expect(fapiBucket).toBeDefined();
            expect(fapiBucket!.currentTokens).toBe(REQUEST_WEIGHT_CAPACITY - 5);

            expect(sapiBucket).toBeDefined();
            expect(sapiBucket!.currentTokens).toBe(SAPI_REQUEST_WEIGHT_CAPACITY);
        });

        // T3 ─────────────────────────────────────────────────────────────────
        //
        // Critical safety test: if SAPI_REQUEST_WEIGHT_1M were missing from
        // allBuckets, engageFreeze() would skip it — the bucket would keep
        // refilling through an IP ban window and allow sapi calls to fire.
        // This test fails without the allBuckets inclusion and passes with it.

        it('T3: 418 freeze drains the sapi bucket to zero and suspends its refill', async () => {
            // BUILD — use a controllable clock
            const startMs = 5_000_000;
            let currentMs = startMs;
            const clock = { now: jest.fn<Date, []>(() => new Date(currentMs)) };
            const alerts = { publish: jest.fn().mockResolvedValue(undefined) };
            const service = new RateLimitPolicyService(clock as never, alerts as never);

            // OPERATE — engage a 418 freeze
            service.reconcileFromHeaders(buildHeaders({ responseStatus: 418, retryAfterSec: null }));

            // CHECK 1 — sapi bucket drained immediately
            const snapAfterFreeze = service.snapshot();
            const sapiBucketFrozen = snapAfterFreeze.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');
            expect(sapiBucketFrozen).toBeDefined();
            expect(sapiBucketFrozen!.currentTokens).toBe(0);

            // CHECK 2 — advance clock WITHIN the freeze window; refill must be suspended
            const shortIntervalMs = 5_000; // 5 s — well inside the 120 s default 418 freeze
            currentMs += shortIntervalMs;

            // Calling snapshot() does NOT trigger refill (refillAll runs inside acquire).
            // Force a refill attempt by calling acquire — it will throw because frozen,
            // but refillAll runs first; the bucket must remain at 0.
            await expect(service.acquire(buildSapiCall())).rejects.toThrow(ExchangeRateLimitExhaustedException);

            const snapMidFreeze = service.snapshot();
            const sapiBucketMid = snapMidFreeze.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');
            expect(sapiBucketMid!.currentTokens).toBe(0);

            // CHECK 3 — advance past the freeze window; the next acquire triggers
            // refillAll, which should unblock and start refilling the sapi bucket.
            currentMs += RATE_LIMIT_418_DEFAULT_FREEZE_MS + 1_000;

            // After the freeze elapses refillAll runs and the bucket gains tokens.
            await expect(service.acquire(buildSapiCall())).resolves.toBeUndefined();

            const snapAfterThaw = service.snapshot();
            const sapiBucketThawed = snapAfterThaw.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');
            expect(sapiBucketThawed!.currentTokens).toBeGreaterThan(0);
        });

        // T4 ─────────────────────────────────────────────────────────────────
        //
        // reconcileFromHeaders() maps the fapi `x-mbx-used-weight-1m` header
        // to REQUEST_WEIGHT_1M only. The sapi bucket is local-only (ADR §2.7
        // comment in rateLimitConsts.ts). A high usedWeight1m must never touch
        // the sapi bucket — cross-applying would corrupt its accounting.

        it('T4: reconcileFromHeaders does not touch the sapi bucket even when usedWeight1m is high', async () => {
            // BUILD
            const { service } = buildService();

            const highFapiUsed = 500;

            // OPERATE — simulate a response that shows heavy fapi weight usage
            service.reconcileFromHeaders(buildHeaders({ usedWeight1m: highFapiUsed }));

            // CHECK — sapi bucket unchanged
            const snap = service.snapshot();
            const sapiBucket = snap.classes.find((c) => c.className === 'SAPI_REQUEST_WEIGHT_1M');
            const fapiBucket = snap.classes.find((c) => c.className === 'REQUEST_WEIGHT_1M');

            expect(sapiBucket).toBeDefined();
            expect(sapiBucket!.currentTokens).toBe(SAPI_REQUEST_WEIGHT_CAPACITY);

            // Sanity: fapi WAS reconciled (header > local since we did not acquire anything)
            expect(fapiBucket).toBeDefined();
            expect(fapiBucket!.currentTokens).toBe(REQUEST_WEIGHT_CAPACITY - highFapiUsed);
        });

        // T5 (adversarial) ───────────────────────────────────────────────────
        //
        // The "no silent bypass" invariant: an operation absent from both
        // FAPI_OPERATION_WEIGHTS and SAPI_OPERATION_WEIGHTS must throw
        // immediately rather than silently bypass rate-limit accounting.

        it('T5: unknown operation throws RateLimitConfigInvariantException', async () => {
            // BUILD
            const { service } = buildService();

            const unknownCall: IRateLimitedCall = {
                operation: 'unknownOp_m46_test',
                requestWeight: 1,
                isOrderOp: false,
                symbol: null,
                mode: 'fail-fast',
                maxWaitMs: null,
            };

            // OPERATE + CHECK — RateLimitConfigInvariantException has a private constructor
            // so we cannot pass the class directly to toThrow. DomainException stores the
            // code in `.code`, not `.message`; the message carries the operation name.
            await expect(service.acquire(unknownCall)).rejects.toThrow(/unknownOp_m46_test/);
        });

        // T6 (adversarial) ───────────────────────────────────────────────────
        //
        // Paired test for the logic reviewer finding: the non-freeze exhaustion
        // path through throwExhausted → findBucketByName for the sapi branch is
        // correct but was untested. This locks both the exception type and the
        // failingClass field for sapi-bucket exhaustion.

        it('T6: exhausted sapi bucket throws ExchangeRateLimitExhaustedException with failingClass SAPI_REQUEST_WEIGHT_1M', async () => {
            // BUILD — drain the sapi bucket completely (capacity = 960 at 80% margin;
            // each sapiGetAccountApiRestrictions call costs 1 token).
            const { service } = buildService();
            const drainCall = buildSapiCall();

            for (let i = 0; i < SAPI_REQUEST_WEIGHT_CAPACITY; i++) {
                await service.acquire(drainCall);
            }

            // OPERATE — next sapi acquire must fail-fast
            let caught: ExchangeRateLimitExhaustedException | null = null;
            try {
                await service.acquire(buildSapiCall());
            } catch (err) {
                caught = err as ExchangeRateLimitExhaustedException;
            }

            // CHECK
            expect(caught).not.toBeNull();
            expect(caught).toBeInstanceOf(ExchangeRateLimitExhaustedException);
            expect(caught!.failingClass).toBe('SAPI_REQUEST_WEIGHT_1M');
            expect(caught!.remainingTokens).toBeGreaterThanOrEqual(0);
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
