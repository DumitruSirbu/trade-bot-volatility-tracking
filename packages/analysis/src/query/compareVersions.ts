// M12 W1 — `compareVersions` query function.
//
// Computes per-version performance for two strategy versions over the same
// window AND a paired-diff summary joined on `decisions.event_id`. The paired
// semantics match ADR 0017 (block-bootstrap of paired same-event expectancy)
// and ADR 0018 (12-criterion promotion gate): a "paired event" is one where
// both versions wrote a decision against the same VWAP trigger
// (`decisions.event_id`), and the paired-diff numerator is the realized PnL
// difference per event when both versions actually traded that event.
//
// **Shared-DTO surface (M12 W4 fix wave 4a):** comparison DTOs now live in
// `packages/shared/` (`IVersionComparisonResult`, `IPairedDiffSummary`).
// This module re-exports them for backward compatibility with existing analysis
// imports; the constant `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` is also in shared.
//
// SQL is parameterized; range validation matches `getPerformance`.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';
import type { IVersionComparisonResult } from '@bot/shared';
import { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN } from '@bot/shared';

import { AnalysisValidationError, validateDateRangeOrThrow } from '../util/analysisValidation.js';
import { formatMoneyString, getPerformance } from './getPerformance.js';

export interface ICompareVersionsParams {
    readonly aVersionId: number;
    readonly bVersionId: number;
    readonly from: Date;
    readonly to: Date;
}

interface IPairedDiffRow {
    readonly paired_event_count: string;
    readonly paired_traded_event_count: string;
    readonly net_pnl_delta_usd: string | null;
}

// Joins decisions A vs B on event_id within the window, then LEFT-joins each
// side's matching position (the canonical pairing target is the OPEN decision
// — by ADR 0017, a "paired event" pairs the OPEN decisions, not SKIPs).
// why: a strategy can write >1 decision per event_id (re-classification, retry,
// replay) AND may write a SKIP before any OPEN. Earlier this CTE ordered by
// ts ASC, which picked SKIP rows (position_id=NULL) when a SKIP preceded the
// OPEN for the same event_id, silently undercounting paired-traded events.
// Filter `action = 'open' AND position_id IS NOT NULL` so DISTINCT ON resolves
// to the OPEN decision that actually anchored a position. The `position_id IS
// NOT NULL` clause is also defence-in-depth: if `action` is ever extended
// (e.g. ADD treated as an open-equivalent), the join can still find the row
// linked to the position record.
const PAIRED_DIFF_SQL = `
    WITH decisions_a AS (
        SELECT DISTINCT ON (d.event_id) d.event_id, d.position_id
        FROM decisions d
        WHERE d.strategy_version_id = $1
          AND d.ts >= $3
          AND d.ts <  $4
          AND d.action = 'open'
          AND d.position_id IS NOT NULL
        ORDER BY d.event_id, d.ts ASC
    ),
    decisions_b AS (
        SELECT DISTINCT ON (d.event_id) d.event_id, d.position_id
        FROM decisions d
        WHERE d.strategy_version_id = $2
          AND d.ts >= $3
          AND d.ts <  $4
          AND d.action = 'open'
          AND d.position_id IS NOT NULL
        ORDER BY d.event_id, d.ts ASC
    ),
    paired AS (
        SELECT
            a.event_id,
            a.position_id AS a_position_id,
            b.position_id AS b_position_id
        FROM decisions_a a
        INNER JOIN decisions_b b USING (event_id)
    ),
    paired_with_pnl AS (
        -- Both versions' positions must have closed inside the window. Without
        -- the closed_at upper-bound, a still-open trade or one closing after
        -- $4 would contribute a NULL realized_pnl on one side and skew the
        -- paired-diff sum semantics ("PnL delta over events both closed in
        -- the window").
        SELECT
            p.event_id,
            pa.realized_pnl AS a_realized_pnl,
            pb.realized_pnl AS b_realized_pnl
        FROM paired p
        LEFT JOIN positions pa ON pa.positions_id = p.a_position_id AND pa.state = 'closed' AND pa.closed_at < $4
        LEFT JOIN positions pb ON pb.positions_id = p.b_position_id AND pb.state = 'closed' AND pb.closed_at < $4
    )
    SELECT
        COUNT(*)::text AS paired_event_count,
        COUNT(*) FILTER (WHERE a_realized_pnl IS NOT NULL AND b_realized_pnl IS NOT NULL)::text AS paired_traded_event_count,
        COALESCE(
            SUM((a_realized_pnl - b_realized_pnl)) FILTER (WHERE a_realized_pnl IS NOT NULL AND b_realized_pnl IS NOT NULL),
            0
        )::text AS net_pnl_delta_usd
    FROM paired_with_pnl
`;
// why: Postgres `AVG(NUMERIC)` returns a heuristic scale that varies across
// PG versions and can drop sub-cent precision. Compute the mean in JS via
// shared decimal context instead — SUM / COUNT are deterministic and the
// division uses the same precision the engine uses for money math.

export async function compareVersions(ds: DataSource, params: ICompareVersionsParams): Promise<IVersionComparisonResult> {
    validateVersionPairOrThrow(params.aVersionId, params.bVersionId);
    validateDateRangeOrThrow(params.from, params.to);

    // Per-version metrics reuse `getPerformance` (same SQL, same window
    // semantics) so a future change to the per-version aggregation propagates
    // to comparison without drift.
    const [aPerformance, bPerformance] = await Promise.all([
        getPerformance(ds, { versionId: params.aVersionId, from: params.from, to: params.to }),
        getPerformance(ds, { versionId: params.bVersionId, from: params.from, to: params.to }),
    ]);

    const rows: IPairedDiffRow[] = await ds.query(PAIRED_DIFF_SQL, [params.aVersionId, params.bVersionId, params.from.toISOString(), params.to.toISOString()]);

    const row = rows[0];
    const pairedEventCount = row !== undefined ? Number(row.paired_event_count) : 0;
    const pairedTradedEventCount = row !== undefined ? Number(row.paired_traded_event_count) : 0;
    const rawNetPnlDelta = row !== undefined && row.net_pnl_delta_usd !== null ? row.net_pnl_delta_usd : '0';
    // why: wrap the raw `::text` cast through shared decimalMath so the
    // surface shape matches engine's `Money.toFixed()` exit point — same
    // numeric value, identical string form.
    const netPnlDeltaUsd = formatMoneyString(rawNetPnlDelta);
    const belowSampleFloor = pairedTradedEventCount < MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN;
    // why: compute the mean in application code (SUM / COUNT) rather than
    // letting Postgres `AVG(NUMERIC)` choose its own scale — keeps precision
    // deterministic across PG versions. Suppress the result below the
    // sample floor: a single-sample mean cannot read as "edge". The sum
    // (netPnlDeltaUsd) is still exposed — totals are not misleading the way
    // single-sample averages are.
    // why: route the mean through `formatMoneyString` so it lands on the same
    // canonical `decimal.js .toFixed()` surface the engine's `Money.toFixed()`
    // exit point produces (matches `netPnlDeltaUsd` above). Direct
    // `.dividedBy().toFixed()` can emit up-to-20-decimal-place strings for
    // non-terminating quotients — formatMoneyString re-normalises through the
    // same Decimal pipeline the rest of the surface uses.
    const meanPnlDeltaUsd =
        !belowSampleFloor && pairedTradedEventCount > 0
            ? formatMoneyString(new Decimal(rawNetPnlDelta).dividedBy(new Decimal(pairedTradedEventCount)).toFixed())
            : null;

    return {
        aPerformance,
        bPerformance,
        pairedDiff: {
            pairedEventCount,
            pairedTradedEventCount,
            netPnlDeltaUsd,
            meanPnlDeltaUsd,
            belowSampleFloor,
        },
    };
}

function validateVersionPairOrThrow(aVersionId: number, bVersionId: number): void {
    if (!Number.isInteger(aVersionId) || aVersionId <= 0 || aVersionId > Number.MAX_SAFE_INTEGER) {
        throw new AnalysisValidationError('aVersionId', `must be a positive integer ≤Number.MAX_SAFE_INTEGER, got ${String(aVersionId)}`);
    }

    if (!Number.isInteger(bVersionId) || bVersionId <= 0 || bVersionId > Number.MAX_SAFE_INTEGER) {
        throw new AnalysisValidationError('bVersionId', `must be a positive integer ≤Number.MAX_SAFE_INTEGER, got ${String(bVersionId)}`);
    }

    if (aVersionId === bVersionId) {
        throw new AnalysisValidationError('versionPair', 'aVersionId and bVersionId must differ');
    }
}
