import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';

import { ALERT_COALESCE_WINDOW_MS, ALERT_GLOBAL_CEILING_PER_MIN, ALERT_GLOBAL_WINDOW_MS } from './const/alertConsts';

// M9 W6 (ADR 0024 §2.4). In-process rate-limiter sitting between the listeners
// and the sink. Pure, clock-injected, no I/O.
//
// Two windows:
//   - GLOBAL: 30 messages / 60s sliding ceiling.
//   - PER-SYMBOL COALESCE: 10s window per (type, symbol) — repeats inside the
//     window are collapsed to the latest message with a "(coalesced N more)"
//     suffix appended on send.
//
// Severity rules:
//   - CRITICAL bypasses per-symbol coalescing. It STILL counts against the
//     global ceiling, BUT if the ceiling is hit with a CRITICAL pending we
//     evict the oldest INFO/WARN timestamp to make room (ADR 0024 §2.4 last
//     paragraph — criticals always land).
//   - INFO/WARN above the ceiling are dropped (return `null`) with the drop
//     counter incremented so the next admitted message can append a
//     `[N alerts suppressed]` line — the suppression count is exposed via
//     `consumeSuppressedCount()` so the sink can append the suffix.

// Re-exported so existing test imports (`from '../../src/alert/AlertRateLimiter'`)
// keep working without a mechanical bulk-rename. The single source of truth
// is `const/alertConsts.ts`.
export { ALERT_COALESCE_WINDOW_MS, ALERT_GLOBAL_CEILING_PER_MIN, ALERT_GLOBAL_WINDOW_MS };

interface ICoalesceBucket {
    firstAt: number;
    lastAt: number;
    count: number;
    latest: IAlertPayload;
}

export class AlertRateLimiter {
    private readonly globalTimestamps: number[] = [];
    private readonly coalesceBuckets = new Map<string, ICoalesceBucket>();
    private suppressedSinceLastSend = 0;

    constructor(private readonly clockMs: () => number) {}

    // Admit a payload. Returns the payload to send (possibly mutated with a
    // coalesce suffix), or `null` if the caller should drop it.
    admit(payload: IAlertPayload): IAlertPayload | null {
        const now = this.clockMs();

        this.evictExpiredGlobal(now);

        const coalesceKey = this.coalesceKeyOf(payload);
        const isCritical = payload.severity === AlertSeverityEnum.CRITICAL;

        if (coalesceKey !== null && !isCritical) {
            const coalesced = this.tryCoalesce(coalesceKey, payload, now);

            if (coalesced.suppress) {
                return null;
            }
        }

        if (this.globalTimestamps.length >= ALERT_GLOBAL_CEILING_PER_MIN) {
            if (!isCritical) {
                this.suppressedSinceLastSend += 1;
                return null;
            }

            // Critical and the ceiling is hit — evict the oldest slot so the
            // critical lands. Oldest slot is index 0 (sliding window is
            // append-only by `now`). R1 fix wave #6: do NOT increment the
            // suppressed counter here — the evicted INFO was already SENT,
            // not dropped; the suppressed counter must only reflect payloads
            // dropped at admit-time so the `[N alerts suppressed]` suffix is
            // accurate.
            this.globalTimestamps.shift();
        }

        this.globalTimestamps.push(now);

        // On admit, mark the window as "armed" so subsequent same-key
        // payloads inside the 10s window get suppressed. The bucket holds
        // count=0 (the admitted payload itself is the latest) and the
        // current `now` as the window anchor.
        if (coalesceKey !== null) {
            const existing = this.coalesceBuckets.get(coalesceKey);
            const suffixCount = existing !== undefined ? existing.count - 1 : 0;
            const annotated = appendCoalesceSuffix(payload, suffixCount);

            this.coalesceBuckets.set(coalesceKey, newCoalesceBucket(now, payload));
            return annotated;
        }

        return payload;
    }

    // Surfaces (and zeroes) the count of payloads dropped since the last
    // admit. The sink appends `[N alerts suppressed in last 60s]` to the
    // outbound text — keeping the count out-of-band of the IAlertPayload so
    // the redactor can't mangle it.
    consumeSuppressedCount(): number {
        const n = this.suppressedSinceLastSend;
        this.suppressedSinceLastSend = 0;
        return n;
    }

    private tryCoalesce(key: string, payload: IAlertPayload, now: number): { suppress: boolean } {
        const existing = this.coalesceBuckets.get(key);

        if (existing === undefined) {
            this.coalesceBuckets.set(key, newCoalesceBucket(now, payload));
            return { suppress: false };
        }

        const windowExpired = now - existing.firstAt >= ALERT_COALESCE_WINDOW_MS;

        if (windowExpired) {
            this.coalesceBuckets.set(key, newCoalesceBucket(now, payload));
            return { suppress: false };
        }

        existing.count += 1;
        existing.lastAt = now;
        existing.latest = payload;
        return { suppress: true };
    }

    private evictExpiredGlobal(now: number): void {
        const cutoff = now - ALERT_GLOBAL_WINDOW_MS;

        // R1 fix wave #6: rolling window is "messages within the LAST
        // ALERT_GLOBAL_WINDOW_MS ms" exclusive of the boundary — a timestamp
        // exactly equal to the cutoff is OUTSIDE the window and must be
        // evicted, otherwise the 31st message at exactly t=60000ms after the
        // first is wrongly rejected.
        while (this.globalTimestamps.length > 0 && this.globalTimestamps[0]! <= cutoff) {
            this.globalTimestamps.shift();
        }
    }

    private coalesceKeyOf(payload: IAlertPayload): string | null {
        if (!isPerSymbolCoalescing(payload.type)) {
            return null;
        }

        const symbol = payload.data?.symbol;

        if (symbol === undefined || symbol.length === 0) {
            return `${payload.type}:GLOBAL`;
        }

        return `${payload.type}:${symbol}`;
    }
}

// Private factory for the bucket struct. Extracted per Clean Code rule
// G-series "no DRY violations" — the same initialiser was open-coded in three
// admit/coalesce branches.
function newCoalesceBucket(now: number, payload: IAlertPayload): ICoalesceBucket {
    return { firstAt: now, lastAt: now, count: 1, latest: payload };
}

function isPerSymbolCoalescing(type: AlertTypeEnum): boolean {
    return type === AlertTypeEnum.ORDER_REJECTED_TERMINAL || type === AlertTypeEnum.RECONCILIATION_DRIFT_UNRESOLVED;
}

function appendCoalesceSuffix(payload: IAlertPayload, coalescedN: number): IAlertPayload {
    if (coalescedN <= 0) {
        return payload;
    }

    return {
        type: payload.type,
        severity: payload.severity,
        occurredAt: payload.occurredAt,
        title: payload.title,
        body: `${payload.body} (coalesced ${coalescedN} more in last 10s)`,
        data: payload.data,
    };
}
