import { HEADER_ORDER_COUNT_10S, HEADER_ORDER_COUNT_1M, HEADER_RETRY_AFTER, HEADER_USED_WEIGHT_1M } from '../const/rateLimitConsts';
import { IRateLimitHeaders } from '../interface/IRateLimitPolicy';

// M11a W1.4 (ADR 0030 §2.5). The single source of truth for header parsing.
// ccxt parks raw response headers under `last_response_headers` on success
// and on `httpHeaders` on the exception path. Both arrive here as a plain
// header bag; we normalise keys to lowercase and coerce numeric values
// through `parseHeaderInt` so a non-numeric or missing header collapses to
// `null` (never throws — the limiter's local accounting is the runtime gate
// when the header is absent).

export function parseRateLimitHeaders(rawHeaders: Readonly<Record<string, string | string[] | undefined>>, responseStatus: number | null): IRateLimitHeaders {
    const lowered = lowercaseKeys(rawHeaders);

    return {
        usedWeight1m: parseHeaderInt(lowered[HEADER_USED_WEIGHT_1M]),
        orderCount10s: parseHeaderInt(lowered[HEADER_ORDER_COUNT_10S]),
        orderCount1m: parseHeaderInt(lowered[HEADER_ORDER_COUNT_1M]),
        retryAfterSec: parseHeaderInt(lowered[HEADER_RETRY_AFTER]),
        responseStatus,
    };
}

function lowercaseKeys(raw: Readonly<Record<string, string | string[] | undefined>>): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {};

    for (const key of Object.keys(raw)) {
        out[key.toLowerCase()] = raw[key];
    }

    return out;
}

function parseHeaderInt(value: string | string[] | undefined): number | null {
    if (value === undefined) {
        return null;
    }

    const text = Array.isArray(value) ? value[0] : value;

    if (typeof text !== 'string' || text.length === 0) {
        return null;
    }

    const parsed = Number.parseInt(text, 10);

    if (Number.isNaN(parsed) || parsed < 0) {
        return null;
    }

    return parsed;
}
