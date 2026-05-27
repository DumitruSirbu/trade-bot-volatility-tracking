// M12 W3 — Zod parameter schemas for the five read-only MCP tools.
//
// Canonical shapes per `docs/plans/M12-execution-plan.md` "Tool DTO shapes".
// Validation rejects: NaN/Infinity dates, reversed ranges, future-dated `to`
// beyond now, oversized ranges without an explicit `acknowledgedLargeRange`
// flag, malformed symbols, and oversized pagination limits.
//
// Boundary invariant (ADR 0033 §2.2): this file imports only `zod`. Response
// DTOs (IPerformanceByVersionView, IBacktestReport, etc.) live in
// `@bot/shared` and are not re-exported here — that contract is consumed by
// the tool handlers in W4, not by the param schemas.

import { z } from 'zod';

import {
    BACKTEST_HARD_RANGE_DAYS,
    DECISIONS_HARD_RANGE_DAYS,
    LIST_POSITIONS_MAX_LIMIT,
    READ_QUERY_HARD_RANGE_DAYS,
    READ_QUERY_SOFT_RANGE_DAYS,
    SYMBOL_REGEX,
} from '../const/index.js';

// Re-export the const surface so existing consumers (tests, tool handlers)
// continue to resolve through `dtos/index.ts`.
export {
    BACKTEST_HARD_RANGE_DAYS,
    DECISIONS_HARD_RANGE_DAYS,
    LIST_POSITIONS_MAX_LIMIT,
    READ_QUERY_HARD_RANGE_DAYS,
    READ_QUERY_SOFT_RANGE_DAYS,
    SYMBOL_REGEX,
} from '../const/index.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * ISO 8601 date string. Refines into a `Date` after parsing. Rejects NaN
 * (e.g. "not-a-date") and non-string inputs at the type guard.
 */
const isoDateString = z
    .string()
    .min(1, { message: 'ISO date string must be non-empty' })
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid ISO 8601 date string' });

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const symbolString = z.string().regex(SYMBOL_REGEX, {
    message: `Symbol must match ${SYMBOL_REGEX.source}`,
});

// ---- range-validation helper ----------------------------------------------

interface IRangeValidationOptions {
    readonly hardMaxDays: number;
    readonly softMaxDays?: number;
    readonly acknowledgedLargeRange?: boolean;
    /** Override `Date.now()` for deterministic tests. */
    readonly now?: number;
}

interface IDateRangeInput {
    readonly from: string;
    readonly to: string;
}

/**
 * Validates an ISO date range. Returns the parsed Date pair or throws a
 * `z.ZodError`-shaped message via `ctx.addIssue` at the call site.
 *
 * Rejection rules:
 *   - `to` < `from`
 *   - `to` > `now` (future-dated upper bound)
 *   - span > hardMaxDays
 *   - span > softMaxDays AND !acknowledgedLargeRange (only when softMax provided)
 */
function validateRange(input: IDateRangeInput, opts: IRangeValidationOptions, ctx: z.RefinementCtx): void {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);

    // isoDateString already rejected NaN individually, but if either parses
    // were skipped (unlikely) bail out without further checks.
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return;
    }

    if (toMs < fromMs) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Range reversed: 'to' (${input.to}) is earlier than 'from' (${input.from})`,
            path: ['to'],
        });
        return;
    }

    const nowMs = opts.now ?? Date.now();
    if (toMs > nowMs) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Range upper bound 'to' (${input.to}) is in the future`,
            path: ['to'],
        });
        return;
    }

    const spanDays = (toMs - fromMs) / MS_PER_DAY;
    if (spanDays > opts.hardMaxDays) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Range span ${spanDays.toFixed(2)}d exceeds hard cap of ${opts.hardMaxDays}d`,
            path: ['to'],
        });
        return;
    }

    if (typeof opts.softMaxDays === 'number' && spanDays > opts.softMaxDays && opts.acknowledgedLargeRange !== true) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Range span ${spanDays.toFixed(2)}d exceeds soft cap of ${opts.softMaxDays}d — set acknowledgedLargeRange=true to proceed`,
            path: ['acknowledgedLargeRange'],
        });
    }
}

// ---- GetPerformanceParams --------------------------------------------------

export const GetPerformanceParamsSchema = z
    .object({
        versionId: positiveInt,
        from: isoDateString,
        to: isoDateString,
        acknowledgedLargeRange: z.boolean().optional(),
    })
    .superRefine((val, ctx) => {
        validateRange(
            val,
            {
                hardMaxDays: READ_QUERY_HARD_RANGE_DAYS,
                softMaxDays: READ_QUERY_SOFT_RANGE_DAYS,
                acknowledgedLargeRange: val.acknowledgedLargeRange,
            },
            ctx,
        );
    });

export type GetPerformanceParams = z.infer<typeof GetPerformanceParamsSchema>;

// ---- CompareVersionsParams -------------------------------------------------

export const CompareVersionsParamsSchema = z
    .object({
        aVersionId: positiveInt,
        bVersionId: positiveInt,
        from: isoDateString,
        to: isoDateString,
        acknowledgedLargeRange: z.boolean().optional(),
    })
    .superRefine((val, ctx) => {
        if (val.aVersionId === val.bVersionId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'aVersionId and bVersionId must differ',
                path: ['bVersionId'],
            });
        }
        validateRange(
            val,
            {
                hardMaxDays: READ_QUERY_HARD_RANGE_DAYS,
                softMaxDays: READ_QUERY_SOFT_RANGE_DAYS,
                acknowledgedLargeRange: val.acknowledgedLargeRange,
            },
            ctx,
        );
    });

export type CompareVersionsParams = z.infer<typeof CompareVersionsParamsSchema>;

// ---- ListPositionsParams ---------------------------------------------------

export const ListPositionsParamsSchema = z
    .object({
        symbol: symbolString.optional(),
        versionId: positiveInt.optional(),
        status: z.enum(['open', 'closed']).optional(),
        from: isoDateString,
        to: isoDateString,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().positive().max(LIST_POSITIONS_MAX_LIMIT).optional(),
    })
    .superRefine((val, ctx) => {
        validateRange(
            val,
            {
                hardMaxDays: READ_QUERY_HARD_RANGE_DAYS,
                softMaxDays: READ_QUERY_SOFT_RANGE_DAYS,
            },
            ctx,
        );
    });

export type ListPositionsParams = z.infer<typeof ListPositionsParamsSchema>;

// ---- GetDecisionsParams ----------------------------------------------------

export const GetDecisionsParamsSchema = z
    .object({
        symbol: symbolString,
        from: isoDateString,
        to: isoDateString,
        includeSnapshot: z.boolean().optional().default(false),
    })
    .superRefine((val, ctx) => {
        validateRange(val, { hardMaxDays: DECISIONS_HARD_RANGE_DAYS }, ctx);
    });

export type GetDecisionsParams = z.infer<typeof GetDecisionsParamsSchema>;

// ---- RunBacktestParams -----------------------------------------------------

// why: the engine CLI operates on UTC calendar days, not arbitrary instants.
// Accepting non-midnight ISO timestamps silently truncated to YYYY-MM-DD
// widens the simulated window vs the requested one (a walk-forward fold
// boundary bug equivalent to look-ahead). Restrict to a single canonical
// shape: bare YYYY-MM-DD, or YYYY-MM-DDT00:00:00.000Z. Reject everything else.
const UTC_DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/u;

const utcCalendarDayString = z
    .string()
    .min(1, { message: 'date string must be non-empty' })
    .regex(UTC_DATE_ONLY_REGEX, {
        message: 'must be a UTC calendar day: YYYY-MM-DD or YYYY-MM-DDT00:00:00.000Z',
    })
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid calendar date' });

export const RunBacktestParamsSchema = z
    .object({
        versionId: positiveInt,
        from: utcCalendarDayString,
        to: utcCalendarDayString,
    })
    .superRefine((val, ctx) => {
        // Schema enforces the HARD cap only (180d). The 30d SOFT cap is a
        // W4-handler concern, gated by operator config — keeping it out of
        // the schema avoids a phantom `acknowledgedLargeRange` field on a
        // tool whose canonical params are `{ versionId, from, to }`.
        validateRange(val, { hardMaxDays: BACKTEST_HARD_RANGE_DAYS }, ctx);
    });

export type RunBacktestParams = z.infer<typeof RunBacktestParamsSchema>;
