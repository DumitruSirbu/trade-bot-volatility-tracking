// M29 W2 — `getFunnelSummary` query function.
//
// Rolls up `decisions` rows where `action = 'open'` into a per-UTC-date funnel
// so the paper-soak diagnosis can see, day by day, how many open intents were
// approved by the gate, rejected by the gate, or never gate-evaluated (legacy
// pre-M27 rows whose `gate_allowed` is NULL). The funnel is the observability
// surface for the M29 "zero-trades" diagnosis (ADR 0042 / docs/plans/M29).
//
// Decisions-only (NO position/closed join). R-multiples are intentionally
// deferred: the R denominator is `effectiveRiskUsdt` (the new M29 sizing field),
// which only exists on post-M29 positions — pre-M29 rows have no comparable
// denominator. A positions-linked R-multiple rollup is a separate future
// surface; mixing the two here would silently compute R off a stale or absent
// denominator.
//
// `gate_allowed` is three-valued: true (approved), false (gate rejected), NULL
// (pre-M27, never gate-evaluated). NULL MUST NOT be folded into "rejected" — a
// row the gate never saw is `unknown`, not a rejection.
//
// `sl_outside_liquidation` sub-cause split (quant MEDIUM #1): the reject reason
// alone does not say WHY the stop sat outside liquidation. We re-derive the
// sub-cause from columns already persisted on the decision row (M27 trade
// geometry) so no schema change is needed. The CASE ladder uses a diagnostic
// priority order (wrong-side first) that intentionally differs from the engine's
// own short-circuit order (over-levered first in clampStopInsideLiquidation).
// This surfaces the wrong-side geometry signal even when over-leverage
// co-occurs; rows that are solely over-levered or solely non-positive-liq are
// still correctly attributed. This is a re-prioritization for diagnosis, not a
// mirror of the engine's evaluation order.
//
// Entry-price proxy for the wrong-side check: a `sl_outside_liquidation` row is
// a REJECT — no position is opened, so `position_id` is NULL and there is no
// `entry_price` column to join. The signal-time entry proxy persisted on the
// row is `market_snapshot->>'vwap_session'` (the only labelled decimal price in
// the snapshot). It is a proxy, not the exact `intent.entryPrice` the gate used
// (that value is not persisted on a reject) — the wrong-side bucket is therefore
// best-effort, while over-levered and non-positive-liquidation-fraction are
// exact (they depend only on `leverage`, a persisted column, and a constant).
//
// SQL is parameterized via positional bindings ($1–$4). String interpolation
// into SQL is banned by the boundary lint (R0) and the dev-qa-cycle invariant.

import { DataSource } from 'typeorm';

import { FUNNEL_MAINTENANCE_MARGIN_RATE, FUNNEL_MAX_LEVERAGE, FUNNEL_UTC_DATE_REGEX } from '../const/analysisFunnelConsts.js';
import { AnalysisValidationError } from '../util/analysisValidation.js';

export type GateAllowedBucket = 'approved' | 'rejected' | 'unknown';

export type SlSubCause = 'wrong_side_stop' | 'over_levered' | 'non_positive_liq_fraction' | null;

export interface IFunnelSummaryRow {
    readonly utcDate: string; // 'YYYY-MM-DD'
    readonly reason: string; // gate reject reason, halt leg, skip reason, or 'approved'
    readonly gateAllowedBucket: GateAllowedBucket;
    readonly isHalted: boolean; // true when reason = 'global_halt'
    readonly count: number;
    // R-multiples are NOT computed here — deferred to a future positions-linked
    // rollup keyed on `effectiveRiskUsdt` (post-M29 sizing field).
    readonly slSubCause: SlSubCause;
}

interface IFunnelRollupRow {
    readonly utc_date: string;
    readonly reason: string | null;
    readonly gate_allowed: boolean | null;
    readonly sl_sub_cause: string | null;
    readonly row_count: string;
}

// Diagnostic CASE ladder for sl_outside_liquidation rows. Priority: wrong-side
// first so geometry errors are surfaced even when over-leverage co-occurs.
// `vwap_session` is the entry-price proxy (exact entryPrice is not persisted on
// a reject row). Over-levered and liq-fraction branches are exact (column only).
const FUNNEL_SUMMARY_SQL = `
    WITH open_decisions AS (
        SELECT
            to_char(d.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_date,
            d.reason                                       AS reason,
            d.gate_allowed                                 AS gate_allowed,
            CASE
                WHEN d.reason <> 'sl_outside_liquidation' THEN NULL
                WHEN d.trade_side = 'LONG'
                     AND d.stop_loss IS NOT NULL
                     AND (d.market_snapshot->>'vwap_session') IS NOT NULL
                     AND d.stop_loss::numeric >= (d.market_snapshot->>'vwap_session')::numeric
                    THEN 'wrong_side_stop'
                WHEN d.trade_side = 'SHORT'
                     AND d.stop_loss IS NOT NULL
                     AND (d.market_snapshot->>'vwap_session') IS NOT NULL
                     AND d.stop_loss::numeric <= (d.market_snapshot->>'vwap_session')::numeric
                    THEN 'wrong_side_stop'
                WHEN d.leverage IS NULL
                     OR d.leverage::numeric <= 0
                     OR d.leverage::numeric > $3
                    THEN 'over_levered'
                WHEN (1.0 / NULLIF(d.leverage::numeric, 0)) - $4 <= 0
                    THEN 'non_positive_liq_fraction'
                ELSE NULL
            END AS sl_sub_cause
        FROM decisions d
        WHERE d.action = 'open'
          AND (d.ts AT TIME ZONE 'UTC') >= ($1)::date
          AND (d.ts AT TIME ZONE 'UTC') <  (($2)::date + INTERVAL '1 day')
    )
    SELECT
        utc_date                AS utc_date,
        reason                  AS reason,
        gate_allowed            AS gate_allowed,
        sl_sub_cause            AS sl_sub_cause,
        COUNT(*)::text          AS row_count
    FROM open_decisions
    GROUP BY utc_date, reason, gate_allowed, sl_sub_cause
    ORDER BY utc_date ASC, reason ASC NULLS FIRST, gate_allowed ASC NULLS FIRST, sl_sub_cause ASC NULLS FIRST
`;

/**
 * Funnel rollup of `action='open'` decisions over an inclusive UTC date range.
 * `fromDate` / `toDate` are 'YYYY-MM-DD'; both ends are inclusive (the SQL spans
 * `[fromDate 00:00 UTC, toDate+1 day 00:00 UTC)`).
 */
export async function getFunnelSummary(ds: DataSource, fromDate: string, toDate: string): Promise<IFunnelSummaryRow[]> {
    validateUtcDateOrThrow('fromDate', fromDate);
    validateUtcDateOrThrow('toDate', toDate);
    validateDateOrderOrThrow(fromDate, toDate);

    const rows: IFunnelRollupRow[] = await ds.query(FUNNEL_SUMMARY_SQL, [fromDate, toDate, FUNNEL_MAX_LEVERAGE, FUNNEL_MAINTENANCE_MARGIN_RATE]);

    return rows.map(mapRowToFunnelSummaryRow);
}

function mapRowToFunnelSummaryRow(row: IFunnelRollupRow): IFunnelSummaryRow {
    const reason = row.reason ?? '';

    // Approved rows carry the strategy signal reason in `reason`, not a gate
    // verdict label. The funnel surface normalizes them to 'approved' so callers
    // can group by bucket without filtering on gate_allowed themselves.
    return {
        utcDate: row.utc_date,
        reason: row.gate_allowed === true ? 'approved' : reason,
        gateAllowedBucket: toGateAllowedBucket(row.gate_allowed),
        isHalted: reason === 'global_halt',
        count: Number(row.row_count),
        slSubCause: toSlSubCause(row.sl_sub_cause),
    };
}

function toGateAllowedBucket(gateAllowed: boolean | null): GateAllowedBucket {
    if (gateAllowed === true) {
        return 'approved';
    }

    if (gateAllowed === false) {
        return 'rejected';
    }

    return 'unknown';
}

function toSlSubCause(raw: string | null): SlSubCause {
    if (raw === 'wrong_side_stop' || raw === 'over_levered' || raw === 'non_positive_liq_fraction') {
        return raw;
    }

    return null;
}

function validateUtcDateOrThrow(field: string, value: string): void {
    if (typeof value !== 'string' || !FUNNEL_UTC_DATE_REGEX.test(value)) {
        throw new AnalysisValidationError(field, `must be a 'YYYY-MM-DD' UTC date string, got "${String(value)}"`);
    }

    // Date.parse silently overflows invalid dates (e.g. Feb-29 on a non-leap year → March 1).
    // Re-format the parsed timestamp back to YYYY-MM-DD and compare to catch the overflow.
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) {
        throw new AnalysisValidationError(field, `is not a real calendar date: "${value}"`);
    }

    const roundTripped = new Date(parsed).toISOString().slice(0, 10);
    if (roundTripped !== value) {
        throw new AnalysisValidationError(field, `is not a real calendar date: "${value}"`);
    }
}

function validateDateOrderOrThrow(fromDate: string, toDate: string): void {
    if (fromDate > toDate) {
        throw new AnalysisValidationError('range', `fromDate (${fromDate}) must be on or before toDate (${toDate})`);
    }
}
