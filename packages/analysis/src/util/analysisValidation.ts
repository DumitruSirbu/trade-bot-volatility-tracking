// M12 W6 fix wave 4b — shared analysis input-validation primitives.
//
// `AnalysisValidationError` and `validateDateRangeOrThrow` were originally
// defined inside `query/getPerformance.ts` (W1 file-budget convenience). The
// clean-code reviewer flagged the cross-module re-export pattern: the helpers
// are infrastructure consumed by every query function, so they belong in
// `util/`, not in a sibling query module. This file is the canonical home.
//
// Boundary invariant (ADR 0033 §2.2): no @bot/engine, no @bot/shared value
// imports — pure local infra.

import { ANALYSIS_MAX_RANGE_MS, FUNNEL_UTC_DATE_REGEX, MS_PER_DAY } from '../const/index.js';

export class AnalysisValidationError extends Error {
    readonly field: string;

    constructor(field: string, detail: string) {
        super(`analysis input invalid (${field}): ${detail}`);
        this.name = 'AnalysisValidationError';
        this.field = field;
    }
}

export function validateDateRangeOrThrow(from: Date, to: Date): void {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
        throw new AnalysisValidationError('from', 'must be a valid Date');
    }

    if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
        throw new AnalysisValidationError('to', 'must be a valid Date');
    }

    if (to.getTime() <= from.getTime()) {
        throw new AnalysisValidationError('range', `to (${to.toISOString()}) must be strictly after from (${from.toISOString()})`);
    }

    if (to.getTime() - from.getTime() > ANALYSIS_MAX_RANGE_MS) {
        throw new AnalysisValidationError('range', `window exceeds analysis hard cap of ${ANALYSIS_MAX_RANGE_MS / MS_PER_DAY} days`);
    }
}

export function validateUtcDateOrThrow(field: string, value: string): void {
    if (typeof value !== 'string' || !FUNNEL_UTC_DATE_REGEX.test(value)) {
        throw new AnalysisValidationError(field, `must be a 'YYYY-MM-DD' UTC date string, got "${String(value)}"`);
    }

    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) {
        throw new AnalysisValidationError(field, `is not a real calendar date: "${value}"`);
    }

    const roundTripped = new Date(parsed).toISOString().slice(0, 10);
    if (roundTripped !== value) {
        throw new AnalysisValidationError(field, `is not a real calendar date: "${value}"`);
    }
}

export function validateDateOrderOrThrow(fromDate: string, toDate: string): void {
    if (fromDate > toDate) {
        throw new AnalysisValidationError('range', `fromDate (${fromDate}) must be on or before toDate (${toDate})`);
    }
}

// M52 D3 — canonical home for the strategy-version-id validation every query function needs.
// getPerformance.ts and listPositions.ts each carry their own pre-existing local copy (out of this
// milestone's scope to consolidate); new query modules should import this one rather than adding a
// third copy.
export function validateVersionIdOrThrow(versionId: number): void {
    if (!Number.isInteger(versionId) || versionId <= 0 || versionId > Number.MAX_SAFE_INTEGER) {
        throw new AnalysisValidationError('versionId', `must be a positive integer ≤Number.MAX_SAFE_INTEGER, got ${String(versionId)}`);
    }
}
