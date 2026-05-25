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

export const formatAgeMs = (fromIso: string, nowMs: number = Date.now()): string => {
    const startMs = Date.parse(fromIso);

    if (!Number.isFinite(startMs)) {
        return '—';
    }

    const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    const days = Math.floor(elapsedSec / 86_400);
    const hours = Math.floor((elapsedSec % 86_400) / 3600);
    const minutes = Math.floor((elapsedSec % 3600) / 60);
    const seconds = elapsedSec % 60;

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
