import { clsx, type ClassValue } from 'clsx';
import Decimal from 'decimal.js-light';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

// Decimal-safe addition for money strings (per CLAUDE.md "money is decimal,
// never float"). Null/undefined parts are skipped. Returns null when no
// usable parts. On a malformed numeric part the function returns the first
// usable raw string — we never silently fabricate a number from garbage input.
export const addMoneyStrings = (...parts: (string | null | undefined)[]): string | null => {
    const usable = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);

    if (usable.length === 0) {
        return null;
    }

    try {
        const total = usable.reduce((acc, raw) => acc.plus(new Decimal(raw)), new Decimal(0));

        return total.toFixed();
    } catch {
        return usable[0];
    }
};

// Money helper. Server emits decimal-safe strings; never parse to Number.
// Pure string formatting: grouping separators for the integer part, fixed
// trailing decimals (configurable), preserves sign. Returns the input as-is
// when it does not match a plain decimal shape so we never silently corrupt
// an unexpected payload (e.g. "Infinity" or "NaN" from a bug upstream).
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

export const formatMoneyString = (value: string | null | undefined, fractionDigits = 2): string => {
    if (value === null || value === undefined || value === '') {
        return '—';
    }

    if (!DECIMAL_PATTERN.test(value)) {
        return value;
    }

    const isNegative = value.startsWith('-');
    const unsigned = isNegative ? value.slice(1) : value;
    const [rawInt, rawFrac = ''] = unsigned.split('.');
    const groupedInt = rawInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = (rawFrac + '0'.repeat(fractionDigits)).slice(0, fractionDigits);
    const body = fractionDigits > 0 ? `${groupedInt}.${frac}` : groupedInt;

    return isNegative ? `-${body}` : body;
};

const MILLIS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

// Hold-duration formatter for closed positions. Pure: derives the elapsed span
// between two ISO instants with no reference to the wall clock. Returns "—" when
// the position has no close instant, and "0s" when the close is at/before the
// open (same-millisecond close or minor clock skew) — never a negative string.
export const formatDurationMs = (openedAt: string, closedAt: string | null): string => {
    if (closedAt === null) {
        return '—';
    }

    const deltaMs = new Date(closedAt).getTime() - new Date(openedAt).getTime();

    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
        return '0s';
    }

    const totalSeconds = Math.floor(deltaMs / MILLIS_PER_SECOND);
    const days = Math.floor(totalSeconds / SECONDS_PER_DAY);
    const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
    const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = totalSeconds % SECONDS_PER_MINUTE;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
};

export const formatAgeMs = (fromIso: string, nowMs: number = Date.now()): string => {
    const startMs = Date.parse(fromIso);

    if (!Number.isFinite(startMs)) {
        return '—';
    }

    const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / MILLIS_PER_SECOND));
    const days = Math.floor(elapsedSec / SECONDS_PER_DAY);
    const hours = Math.floor((elapsedSec % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
    const minutes = Math.floor((elapsedSec % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = elapsedSec % SECONDS_PER_MINUTE;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
};
