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

import { ANALYSIS_MAX_RANGE_MS, MS_PER_DAY } from '../const/index.js';

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
