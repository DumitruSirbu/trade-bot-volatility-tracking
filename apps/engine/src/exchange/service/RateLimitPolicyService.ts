import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import { ALERT_SINK, IAlertSink } from '../../alert/sink/AlertSinkModule';
import { CLOCK, IClock } from '../../common/clock/Clock';
import { AppConfigService } from '../../config/service';
import {
    OPERATION_REQUEST_WEIGHTS,
    ORDERS_10S_PUBLISHED_LIMIT,
    ORDERS_10S_WINDOW_MS,
    ORDERS_1M_PUBLISHED_LIMIT,
    ORDERS_1M_WINDOW_MS,
    PER_SYMBOL_ORDERS_SHARE,
    RATE_LIMIT_418_DEFAULT_FREEZE_MS,
    RATE_LIMIT_429_DEFAULT_FREEZE_MS,
    RATE_LIMIT_DRIFT_LOG_COALESCE_MS,
    RATE_LIMIT_DRIFT_THRESHOLD_FRACTION,
    RATE_LIMIT_FREEZE_CAP_MS,
    RATE_LIMIT_FREEZE_DECAY_FACTOR,
    RATE_LIMIT_SAFETY_MARGIN,
    RAW_REQUESTS_5M_PUBLISHED_LIMIT,
    RAW_REQUESTS_5M_WINDOW_MS,
    REQUEST_WEIGHT_1M_PUBLISHED_LIMIT,
    REQUEST_WEIGHT_1M_WINDOW_MS,
} from '../const/rateLimitConsts';
import { ExchangeRateLimitExhaustedException, RateLimitConfigInvariantException, SymbolRateLimitExhaustedException } from '../exception';
import { IRateLimitHaltPort, RATE_LIMIT_HALT_PORT } from '../interface/IRateLimitHaltPort';
import { IRateLimitClassSnapshot, IRateLimitHeaders, IRateLimitPolicy, IRateLimitSnapshot, IRateLimitedCall } from '../interface/IRateLimitPolicy';

// M11a W1.4 (ADR 0030). In-process multi-class token-bucket limiter.
//
// Four buckets per ADR 0030 §2.1 (REQUEST_WEIGHT_1M, ORDERS_10S, ORDERS_1M,
// RAW_REQUESTS_5M) + per-symbol sub-buckets on the ORDERS classes (§2.4).
// Token cost = call.requestWeight (REQUEST_WEIGHT_1M) or 1 (others). Refill is
// continuous (capacity / windowSeconds per second).
//
// `acquire()` honours the caller-declared mode:
//   - fail-fast: any class below cost throws immediately. Used by createOrder /
//     cancel — a silently delayed order is worse than a rejected one.
//   - await:     waits for refill, capped by maxWaitMs. Used by reconciliation,
//     funding, market-data REST fallbacks.
//
// `reconcileFromHeaders()` overrides local accounting upward (never relaxes)
// to absorb header-feedback lag — see ADR 0030 §2.5.
//
// 429/418 path (ADR 0030 §2.6): every bucket drains to zero, a freeze window
// suspends refill for `Retry-After` seconds, the caller gets an
// `ExchangeRateLimitExhaustedException` so it never retries, AND the
// kill-switch port (when wired) engages a programmatic halt with
// `reason='RATE_LIMIT_BAN'`. Auto-clear fires when the freeze elapses without
// further 429/418 — writes a `RATE_LIMIT_HALT_AUTO_CLEARED` audit row.

interface IBucket {
    readonly className: string;
    capacity: number;
    currentTokens: number;
    readonly windowMs: number;
    readonly refillPerMs: number;
    lastRefillMs: number;
}

@Injectable()
export class RateLimitPolicyService implements IRateLimitPolicy, OnModuleInit {
    private readonly logger = new Logger(RateLimitPolicyService.name);

    private readonly requestWeight1m: IBucket;
    private readonly orders10s: IBucket;
    private readonly orders1m: IBucket;
    private readonly rawRequests5m: IBucket;

    // Per-symbol ORDERS_* sub-buckets keyed by `${className}:${symbol}` — ADR §2.4.
    private readonly perSymbol = new Map<string, IBucket>();

    private frozenUntilMs: number | null = null;
    private currentFreezeMs: number = 0;
    // Wall-clock ms at which the most recent freeze window EXPIRED. Used by
    // the decay rule in §2.6.5 — a fresh 429/418 within
    // (currentFreezeMs × RATE_LIMIT_FREEZE_DECAY_FACTOR) of the prior expiry
    // keeps the escalation chain alive; beyond it the escalation resets to
    // the base duration.
    private lastFreezeExpiredAtMs: number | null = null;
    private lastDriftPct: number | null = null;
    private lastDriftAlertAtMs: number = 0;
    private autoClearTimer: NodeJS.Timeout | null = null;

    constructor(
        @Inject(CLOCK) private readonly clock: IClock,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        @Optional() @Inject(RATE_LIMIT_HALT_PORT) private readonly haltPort: IRateLimitHaltPort | null = null,
        @Optional() private readonly appConfig: AppConfigService | null = null,
    ) {
        const nowMs = this.clock.now().getTime();

        this.requestWeight1m = makeBucket('REQUEST_WEIGHT_1M', REQUEST_WEIGHT_1M_PUBLISHED_LIMIT, REQUEST_WEIGHT_1M_WINDOW_MS, nowMs);
        this.orders10s = makeBucket('ORDERS_10S', ORDERS_10S_PUBLISHED_LIMIT, ORDERS_10S_WINDOW_MS, nowMs);
        this.orders1m = makeBucket('ORDERS_1M', ORDERS_1M_PUBLISHED_LIMIT, ORDERS_1M_WINDOW_MS, nowMs);
        this.rawRequests5m = makeBucket('RAW_REQUESTS_5M', RAW_REQUESTS_5M_PUBLISHED_LIMIT, RAW_REQUESTS_5M_WINDOW_MS, nowMs);
    }

    // M11a W1.4 (ADR 0030 §2.4). Boot-time invariant: the per-symbol ORDERS
    // share × MAX_OPEN_POSITIONS must not exceed 1.0 — otherwise N symbols
    // could each claim a >1/N fraction of the account-wide ORDERS bucket and
    // starve each other. `MAX_OPEN_POSITIONS` lives in EnvironmentVariables /
    // AppConfigService (see apps/engine/src/config/EnvironmentVariables.ts:113
    // and apps/engine/src/config/service/AppConfigService.ts:149). When
    // AppConfigService is not wired (pure-unit-test harnesses) the assertion
    // is skipped — production wiring always injects it via AppConfigModule.
    onModuleInit(): void {
        if (this.appConfig === null) {
            this.logger.warn('rateLimit.bootAssertion.skipped — AppConfigService not injected (test harness only)');

            return;
        }

        const maxOpenPositions = this.appConfig.maxOpenPositions;
        const product = maxOpenPositions * PER_SYMBOL_ORDERS_SHARE;

        if (product > 1.0) {
            throw new RateLimitConfigInvariantException(maxOpenPositions, PER_SYMBOL_ORDERS_SHARE);
        }
    }

    async acquire(call: IRateLimitedCall): Promise<void> {
        const deadlineMs = call.mode === 'await' && call.maxWaitMs !== null ? this.clock.now().getTime() + call.maxWaitMs : null;

        // Outer loop allows await-mode callers to retry after a short sleep.
        // Each iteration refills, checks every class, and either resolves,
        // throws (fail-fast / freeze / budget exceeded), or sleeps to the
        // next plausible refill instant. Bounded by `deadline` so a wedged
        // refill cannot spin forever.
        while (true) {
            const nowMs = this.clock.now().getTime();

            this.checkFrozen(nowMs);
            this.refillAll(nowMs);

            const insufficient = this.findInsufficientClass(call);

            if (insufficient === null) {
                this.debitAll(call);

                return;
            }

            this.handleInsufficient(call, insufficient, nowMs, deadlineMs);

            await this.sleepUntilNextTick(insufficient, call, nowMs, deadlineMs);
        }
    }

    reconcileFromHeaders(headers: IRateLimitHeaders): void {
        const responseStatus = headers.responseStatus ?? 0;

        if (responseStatus === 429 || responseStatus === 418) {
            this.engageFreeze(headers);

            return;
        }

        this.reconcileClass(this.requestWeight1m, headers.usedWeight1m);
        this.reconcileClass(this.orders10s, headers.orderCount10s);
        this.reconcileClass(this.orders1m, headers.orderCount1m);
    }

    snapshot(): IRateLimitSnapshot {
        const classes: IRateLimitClassSnapshot[] = this.allBuckets.map((bucket) => ({
            className: bucket.className,
            capacity: bucket.capacity,
            currentTokens: bucket.currentTokens,
            windowMs: bucket.windowMs,
        }));

        return {
            classes,
            frozenUntilMs: this.frozenUntilMs,
            lastDriftPct: this.lastDriftPct,
        };
    }

    // -----------------------------------------------------------------------
    // Acquisition helpers
    // -----------------------------------------------------------------------

    // Throws if a freeze window is active. Single early-exit so the acquire()
    // loop body stays compact.
    private checkFrozen(nowMs: number): void {
        if (this.frozenUntilMs !== null && nowMs < this.frozenUntilMs) {
            throw new ExchangeRateLimitExhaustedException('FROZEN', 0, this.frozenUntilMs - nowMs);
        }
    }

    // Dispatch under bucket exhaustion: fail-fast mode throws immediately;
    // await mode throws once the deadline is past; otherwise the loop sleeps
    // and retries. Keeps acquire()'s body small enough to read top-to-bottom.
    private handleInsufficient(call: IRateLimitedCall, insufficient: string, nowMs: number, deadlineMs: number | null): void {
        if (call.mode === 'fail-fast') {
            this.throwExhausted(insufficient, call);
        }

        if (deadlineMs !== null && nowMs >= deadlineMs) {
            this.throwExhausted(insufficient, call);
        }
    }

    private findInsufficientClass(call: IRateLimitedCall): string | null {
        const weightCost = call.requestWeight;

        if (weightCost > 0 && this.requestWeight1m.currentTokens < weightCost) {
            return this.requestWeight1m.className;
        }

        if (this.rawRequests5m.currentTokens < 1) {
            return this.rawRequests5m.className;
        }

        if (!call.isOrderOp) {
            return null;
        }

        if (this.orders10s.currentTokens < 1) {
            return this.orders10s.className;
        }

        if (this.orders1m.currentTokens < 1) {
            return this.orders1m.className;
        }

        return this.findInsufficientSymbolBucket(call);
    }

    // Returns the failing per-symbol sub-bucket's class name (e.g.
    // 'ORDERS_10S:BTCUSDT') so the caller — acquire() — can route through
    // its mode='fail-fast' vs mode='await' dispatch. Returns null when no
    // sub-bucket is insufficient. Previously threw a
    // `SymbolRateLimitExhaustedException` directly from here, which bypassed
    // the mode dispatch — today no await-mode caller carries a symbol so it
    // was masked, but any future await-mode call with a symbol (e.g.
    // `fetchOpenOrders(symbol)`) would have silently fail-fasted. The
    // throw-on-fail-fast happens in throwExhausted() instead, which raises
    // the same exception subclass when the failing class string contains
    // ':' (i.e. is a per-symbol sub-bucket).
    private findInsufficientSymbolBucket(call: IRateLimitedCall): string | null {
        if (call.symbol === null) {
            return null;
        }

        const nowMs = this.clock.now().getTime();
        const bucket10s = this.getOrCreateSymbolBucket('ORDERS_10S', call.symbol, this.orders10s);
        const bucket1m = this.getOrCreateSymbolBucket('ORDERS_1M', call.symbol, this.orders1m);

        this.refillBucket(bucket10s, nowMs);
        this.refillBucket(bucket1m, nowMs);

        if (bucket10s.currentTokens < 1) {
            return bucket10s.className;
        }

        if (bucket1m.currentTokens < 1) {
            return bucket1m.className;
        }

        return null;
    }

    private debitAll(call: IRateLimitedCall): void {
        if (call.requestWeight > 0) {
            this.requestWeight1m.currentTokens -= call.requestWeight;
        }

        this.rawRequests5m.currentTokens -= 1;

        if (!call.isOrderOp) {
            return;
        }

        this.orders10s.currentTokens -= 1;
        this.orders1m.currentTokens -= 1;

        if (call.symbol !== null) {
            this.debitSymbolBuckets(call.symbol);
        }
    }

    private debitSymbolBuckets(symbol: string): void {
        const bucket10s = this.getOrCreateSymbolBucket('ORDERS_10S', symbol, this.orders10s);
        const bucket1m = this.getOrCreateSymbolBucket('ORDERS_1M', symbol, this.orders1m);

        bucket10s.currentTokens -= 1;
        bucket1m.currentTokens -= 1;
    }

    private async sleepUntilNextTick(failingClass: string, call: IRateLimitedCall, nowMs: number, deadlineMs: number | null): Promise<void> {
        // Sleep just long enough for one token to refill in the failing class.
        const bucket = this.findBucketByName(failingClass);
        const tokensNeeded = call.requestWeight > 0 && failingClass === this.requestWeight1m.className ? call.requestWeight - bucket.currentTokens : 1;
        const sleepMs = Math.max(10, Math.ceil(tokensNeeded / bucket.refillPerMs));
        const bounded = deadlineMs !== null ? Math.min(sleepMs, Math.max(1, deadlineMs - nowMs)) : sleepMs;

        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, bounded);

            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        });
    }

    private throwExhausted(className: string, call: IRateLimitedCall): never {
        // Per-symbol sub-buckets are keyed as `${parentClass}:${symbol}` —
        // raise the distinct SymbolRateLimitExhaustedException so the strategy
        // logs the cause correctly (ADR 0030 §2.4).
        const colonIndex = className.indexOf(':');

        if (colonIndex !== -1 && call.symbol !== null) {
            const parentClass = className.slice(0, colonIndex);
            const bucket = this.perSymbol.get(className);
            const remaining = bucket?.currentTokens ?? 0;
            this.logger.warn(`rateLimit.exhausted class=${className} operation=${call.operation} remaining=${remaining}`);

            throw new SymbolRateLimitExhaustedException(call.symbol, parentClass, remaining);
        }

        const bucket = this.findBucketByName(className);
        this.logger.warn(`rateLimit.exhausted class=${className} operation=${call.operation} remaining=${bucket.currentTokens}`);

        throw new ExchangeRateLimitExhaustedException(className, bucket.currentTokens, null);
    }

    // -----------------------------------------------------------------------
    // Refill / reconcile helpers
    // -----------------------------------------------------------------------

    // Single bucket-array accessor (DRY, ADR 0030 §2.1). Order matches the
    // table in §2.1 so snapshots render deterministically.
    private get allBuckets(): readonly IBucket[] {
        return [this.requestWeight1m, this.orders10s, this.orders1m, this.rawRequests5m];
    }

    private refillAll(nowMs: number): void {
        for (const bucket of this.allBuckets) {
            this.refillBucket(bucket, nowMs);
        }
    }

    private refillBucket(bucket: IBucket, nowMs: number): void {
        if (this.frozenUntilMs !== null && nowMs < this.frozenUntilMs) {
            // ADR §2.6: refill is SUSPENDED during the freeze window.
            return;
        }

        const elapsed = nowMs - bucket.lastRefillMs;

        if (elapsed <= 0) {
            return;
        }

        const refilled = bucket.currentTokens + elapsed * bucket.refillPerMs;
        bucket.currentTokens = Math.min(bucket.capacity, refilled);
        bucket.lastRefillMs = nowMs;
    }

    private reconcileClass(bucket: IBucket, headerUsed: number | null): void {
        if (headerUsed === null) {
            return;
        }

        const localUsed = bucket.capacity - bucket.currentTokens;
        // Only an UNDER-count is dangerous: Binance has counted more than we have,
        // so we may be approaching a 429 we cannot see. local > header is the SAFE
        // (conservative) direction and must stay silent — see ADR 0030 §2.5.
        const underCountFraction = (headerUsed - localUsed) / bucket.capacity;

        if (underCountFraction >= RATE_LIMIT_DRIFT_THRESHOLD_FRACTION) {
            this.lastDriftPct = underCountFraction;
            this.maybeFireDriftAlert(bucket, localUsed, headerUsed, underCountFraction);
        }

        if (headerUsed > localUsed) {
            // Server has counted more than we have — trust it (conservative).
            bucket.currentTokens = Math.max(0, bucket.capacity - headerUsed);
        }
    }

    private maybeFireDriftAlert(bucket: IBucket, localUsed: number, headerUsed: number, underCountFraction: number): void {
        const nowMs = this.clock.now().getTime();

        if (nowMs - this.lastDriftAlertAtMs < RATE_LIMIT_DRIFT_LOG_COALESCE_MS) {
            return;
        }

        this.lastDriftAlertAtMs = nowMs;
        this.logger.warn(
            `rateLimit.underCount class=${bucket.className} localUsed=${localUsed} headerUsed=${headerUsed} underCountFraction=${underCountFraction.toFixed(3)}`,
        );

        const body =
            `Local-used ${localUsed}/${bucket.capacity} vs header-used ${headerUsed}/${bucket.capacity}: ` +
            `engine is under-counting vs Binance by ${(underCountFraction * 100).toFixed(1)}% and may be approaching a 429.`;

        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.WARN,
            occurredAt: new Date(nowMs).toISOString(),
            title: `Rate-limit UNDER-COUNT detected (${bucket.className}) — approaching limit`,
            body,
            data: { className: bucket.className, driftPct: underCountFraction.toFixed(3) },
        };

        void this.alerts.publish(payload).catch((cause) => {
            this.logger.warn(`alert.publish.failed type=${payload.type} cause=${(cause as Error).message}`);
        });
    }

    // -----------------------------------------------------------------------
    // 429/418 freeze
    // -----------------------------------------------------------------------

    // ADR 0030 §2.6.5 escalation:
    //   - Within an active freeze window: double currentFreezeMs (capped).
    //   - Within `RATE_LIMIT_FREEZE_DECAY_FACTOR × previous baseMs` of a
    //     prior expiry: ALSO double — the chain is alive.
    //   - Otherwise: reset to base duration from headers / defaults.
    private engageFreeze(headers: IRateLimitHeaders): void {
        const nowMs = this.clock.now().getTime();
        const baseMs = this.resolveFreezeDuration(headers);
        const doubledMs = this.computeFreezeDuration(nowMs, baseMs);

        this.currentFreezeMs = doubledMs;
        this.frozenUntilMs = nowMs + doubledMs;

        for (const bucket of this.allBuckets) {
            bucket.currentTokens = 0;
        }

        this.logger.error(`rateLimit.frozen status=${headers.responseStatus} freezeMs=${doubledMs}`);
        this.fireFreezeAlert(headers, doubledMs);
        this.engageHaltViaPort(headers, doubledMs, nowMs);
        this.scheduleAutoClear(doubledMs);
    }

    private computeFreezeDuration(nowMs: number, baseMs: number): number {
        if (this.frozenUntilMs !== null && nowMs < this.frozenUntilMs) {
            // Still within an active freeze — escalate.
            return Math.min(this.currentFreezeMs * 2, RATE_LIMIT_FREEZE_CAP_MS);
        }

        if (this.lastFreezeExpiredAtMs !== null && this.currentFreezeMs > 0) {
            const decayDeadlineMs = this.lastFreezeExpiredAtMs + this.currentFreezeMs * RATE_LIMIT_FREEZE_DECAY_FACTOR;

            if (nowMs < decayDeadlineMs) {
                // Within the decay window — chain still alive, escalate.
                return Math.min(this.currentFreezeMs * 2, RATE_LIMIT_FREEZE_CAP_MS);
            }
        }

        return baseMs;
    }

    private resolveFreezeDuration(headers: IRateLimitHeaders): number {
        if (headers.retryAfterSec !== null && headers.retryAfterSec > 0) {
            return Math.min(headers.retryAfterSec * 1000, RATE_LIMIT_FREEZE_CAP_MS);
        }

        if (headers.responseStatus === 418) {
            return RATE_LIMIT_418_DEFAULT_FREEZE_MS;
        }

        return RATE_LIMIT_429_DEFAULT_FREEZE_MS;
    }

    private fireFreezeAlert(headers: IRateLimitHeaders, freezeMs: number): void {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: this.clock.now().toISOString(),
            title: `Binance rate-limit triggered (HTTP ${headers.responseStatus ?? 'n/a'})`,
            body: `New orders halted for ${Math.ceil(freezeMs / 1000)}s. Retry-After=${headers.retryAfterSec ?? 'n/a'}.`,
            data: { code: String(headers.responseStatus ?? 0), freezeMs: String(freezeMs) },
        };

        void this.alerts.publish(payload).catch((cause) => {
            this.logger.warn(`alert.publish.failed type=${payload.type} cause=${(cause as Error).message}`);
        });
    }

    // ADR 0030 §2.6.2. Engage the canonical halt-state machine via the port so
    // the risk gate, dashboard, and audit consumers see the rate-limit halt.
    // Fire-and-forget: a port failure is logged but never propagated into the
    // bucket-freeze path.
    private engageHaltViaPort(headers: IRateLimitHeaders, freezeMs: number, nowMs: number): void {
        if (this.haltPort === null) {
            return;
        }

        const reason = `code=${headers.responseStatus ?? 'n/a'} freezeMs=${freezeMs} retryAfter=${headers.retryAfterSec ?? 'n/a'}`;

        void this.haltPort.engage({ reason, occurredAt: new Date(nowMs) }).catch((cause) => {
            this.logger.error(`rateLimitHaltPort.engage.failed cause=${(cause as Error).message}`);
        });
    }

    // ADR 0030 §2.6.2. At freeze expiry the policy attempts to auto-clear the
    // halt and write a `RATE_LIMIT_HALT_AUTO_CLEARED` audit row. A subsequent
    // 429/418 within the window clears the pending timer and reschedules off
    // the new (doubled) expiry.
    private scheduleAutoClear(freezeMs: number): void {
        if (this.autoClearTimer !== null) {
            clearTimeout(this.autoClearTimer);
            this.autoClearTimer = null;
        }

        const timer = setTimeout(() => this.runAutoClear(), freezeMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.autoClearTimer = timer;
    }

    private runAutoClear(): void {
        const nowMs = this.clock.now().getTime();
        // Defensive: if a fresh freeze has extended the window, abort.

        if (this.frozenUntilMs !== null && nowMs < this.frozenUntilMs) {
            return;
        }

        const previousFreezeMs = this.currentFreezeMs;
        this.frozenUntilMs = null;
        this.lastFreezeExpiredAtMs = nowMs;
        this.autoClearTimer = null;

        if (this.haltPort === null) {
            return;
        }

        const reason = `auto-cleared after freezeMs=${previousFreezeMs}`;

        void this.haltPort.autoClear({ reason, occurredAt: new Date(nowMs) }).catch((cause) => {
            this.logger.error(`rateLimitHaltPort.autoClear.failed cause=${(cause as Error).message}`);
        });
    }

    // -----------------------------------------------------------------------
    // Bucket lookup helpers
    // -----------------------------------------------------------------------

    private findBucketByName(className: string): IBucket {
        if (className === this.requestWeight1m.className) {
            return this.requestWeight1m;
        }

        if (className === this.orders10s.className) {
            return this.orders10s;
        }

        if (className === this.orders1m.className) {
            return this.orders1m;
        }

        return this.rawRequests5m;
    }

    private getOrCreateSymbolBucket(parentClass: 'ORDERS_10S' | 'ORDERS_1M', symbol: string, parent: IBucket): IBucket {
        const key = `${parentClass}:${symbol}`;
        const existing = this.perSymbol.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const subCapacity = Math.max(1, Math.floor(parent.capacity * PER_SYMBOL_ORDERS_SHARE));
        const bucket: IBucket = {
            className: key,
            capacity: subCapacity,
            currentTokens: subCapacity,
            windowMs: parent.windowMs,
            refillPerMs: subCapacity / parent.windowMs,
            lastRefillMs: this.clock.now().getTime(),
        };
        this.perSymbol.set(key, bucket);

        return bucket;
    }
}

// Resolves the per-call descriptor from a ccxt operation name. Unknown
// operations throw — the limiter never silently lets a new call site bypass
// rate-limit accounting (ADR 0030 §2.2).
export function buildRateLimitedCall(input: {
    operation: string;
    isOrderOp: boolean;
    symbol: string | null;
    mode: 'fail-fast' | 'await';
    maxWaitMs: number | null;
}): IRateLimitedCall {
    const weight = OPERATION_REQUEST_WEIGHTS[input.operation];

    if (weight === undefined) {
        throw new Error(`No REQUEST_WEIGHT entry for ccxt operation '${input.operation}' — add to OPERATION_REQUEST_WEIGHTS.`);
    }

    return {
        operation: input.operation,
        requestWeight: weight,
        isOrderOp: input.isOrderOp,
        symbol: input.symbol,
        mode: input.mode,
        maxWaitMs: input.maxWaitMs,
    };
}

function makeBucket(className: string, publishedLimit: number, windowMs: number, nowMs: number): IBucket {
    const capacity = Math.floor(publishedLimit * RATE_LIMIT_SAFETY_MARGIN);

    return {
        className,
        capacity,
        currentTokens: capacity,
        windowMs,
        refillPerMs: capacity / windowMs,
        lastRefillMs: nowMs,
    };
}
