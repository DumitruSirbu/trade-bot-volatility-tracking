import { LOG_CIRCULAR_REF, LOG_REDACT_CENSOR, LOG_SENSITIVE_KEYS } from '../const';

// Recursively replaces the value of any key in LOG_SENSITIVE_KEYS (matched
// case-insensitively) with the censor, at ANY depth and inside arrays. Used as
// pino's `formatters.log` hook so every log object is scrubbed before serialise,
// closing the gap left by pino's fixed-depth `redact` matcher.
//
// WeakSet guards against circular references (common in Express req/res and
// error objects). Non-object values pass through untouched.
export function deepRedactLog(logObject: Record<string, unknown>): Record<string, unknown> {
    return redactValue(logObject, new WeakSet()) as Record<string, unknown>;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (seen.has(value)) {
        return LOG_CIRCULAR_REF;
    }

    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, seen));
    }

    const result: Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
        const child = (value as Record<string, unknown>)[key];
        result[key] = isSensitiveKey(key) ? LOG_REDACT_CENSOR : redactValue(child, seen);
    }

    return result;
}

function isSensitiveKey(key: string): boolean {
    return LOG_SENSITIVE_KEYS.has(key.toLowerCase());
}
