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
//
// **M37 W1 (D1.1/D1.2) — read `shadow_decisions`, reconciled on `event_id`.**
// Before M37 the paired-diff CTE read ONLY `decisions`/`positions`, so a pair
// where either side is a `shadow`-status version produced zero paired events
// (shadow rows never land in `decisions`). M37 selects each side's source by
// the version's `strategy_versions.status`: the active version pairs from
// `decisions`/`positions`; a shadow version pairs from `shadow_decisions`
// (`action='open'`, keyed on the shared `event_id`). The active-vs-shadow
// precedence rule (D1.2) means a version that appears in BOTH tables is read
// from exactly one stream — its status-selected source — and never
// double-counted. The table choice is a structural selection between two fixed
// SQL fragments, NOT value interpolation; values stay positional ($1..$4).
//
// A shadow side counts an event as "traded" only when its `simulated_fill` is
// non-hollow (`missed=false AND exitPrice IS NOT NULL`). Shadow-side PnL is
// computed from the fill JSONB using `trade_side` and `qty` to sign the delta.
// The D1.6 fill simulator uses a causal same-bar approximation so most fills
// produce ~0 gross PnL — the honest result until a retroactive replay job
// provides real forward-bar fills. `pairedEventCount`/`pairedTradedEventCount`
// are the most reliable metrics today; `meanPnlDeltaUsd` is suppressed below
// the sample floor by the `belowSampleFloor` flag.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';
import type { IVersionComparisonResult } from '@bot/shared';
import { MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN, MAX_FORCE_CLOSE_FRACTION } from '@bot/shared';

import { STRATEGY_STATUS_ACTIVE } from '../const/index.js';
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

// Active-version paired side. The canonical pairing target is the OPEN decision
// — by ADR 0017, a "paired event" pairs the OPEN decisions, not SKIPs.
// why: a strategy can write >1 decision per event_id (re-classification, retry,
// replay) AND may write a SKIP before any OPEN. Earlier this CTE ordered by
// ts ASC, which picked SKIP rows (position_id=NULL) when a SKIP preceded the
// OPEN for the same event_id, silently undercounting paired-traded events.
// Filter `action = 'open' AND position_id IS NOT NULL` so DISTINCT ON resolves
// to the OPEN decision that actually anchored a position. The `position_id IS
// NOT NULL` clause is also defence-in-depth: if `action` is ever extended
// (e.g. ADD treated as an open-equivalent), the join can still find the row
// linked to the position record. `realized_pnl` is sourced via a LEFT JOIN to
// the CLOSED position bounded by the window upper bound ($4): a still-open
// trade or one closing after $4 yields NULL `realized_pnl` and so is not
// counted as traded.
function buildActiveSideCte(name: string, versionParam: string): string {
    return `
    ${name} AS (
        SELECT
            d.event_id,
            pos.realized_pnl AS realized_pnl,
            (pos.realized_pnl IS NOT NULL) AS traded
        FROM (
            SELECT DISTINCT ON (d.event_id) d.event_id, d.position_id
            FROM decisions d
            WHERE d.strategy_version_id = ${versionParam}
              AND d.ts >= $3
              AND d.ts <  $4
              AND d.action = 'open'
              AND d.position_id IS NOT NULL
            ORDER BY d.event_id, d.ts ASC
        ) d
        LEFT JOIN positions pos ON pos.positions_id = d.position_id AND pos.state = 'closed' AND pos.closed_at < $4
    )`;
}

// Shadow-version paired side (M37 W1). Shadow rows live in `shadow_decisions`,
// keyed on the same `event_id` the active stream uses (ADR 0017 / ADR 0029
// §2.2). The UNIQUE(shadow_version, event_id) constraint means there is at most
// one row per (version, event), so no DISTINCT ON is needed. An event is
// "traded" only when its `simulated_fill` is non-hollow
// (`missed=false AND exitPrice IS NOT NULL`). `realized_pnl` is computed from
// the fill JSONB: (exitPrice - entryPrice) × qty for LONG, reversed for SHORT.
// Note: D1.6 uses a causal same-bar approximation (entry and exit at bar close),
// so most fills produce ~0 gross PnL — the honest result given the architectural
// constraint (next bar unavailable at live evaluation time).
function buildShadowSideCte(name: string, versionParam: string): string {
    return `
    ${name} AS (
        SELECT
            sd.event_id,
            CASE
                WHEN (sd.simulated_fill->>'missed')::boolean = false
                 AND sd.simulated_fill->>'exitPrice' IS NOT NULL
                 AND sd.simulated_fill->>'entryPrice' IS NOT NULL
                 AND sd.simulated_fill->>'entryPrice' != '0'
                THEN
                    CASE sd.trade_side
                        WHEN 'long'  THEN (CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC)
                                           - CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC))
                                          * sd.qty::NUMERIC
                                          - COALESCE(CAST(sd.simulated_fill->>'feeUsdtEntry' AS NUMERIC), 0)
                                          - COALESCE(CAST(sd.simulated_fill->>'feeUsdtExit' AS NUMERIC), 0)
                        WHEN 'short' THEN (CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC)
                                           - CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC))
                                          * sd.qty::NUMERIC
                                          - COALESCE(CAST(sd.simulated_fill->>'feeUsdtEntry' AS NUMERIC), 0)
                                          - COALESCE(CAST(sd.simulated_fill->>'feeUsdtExit' AS NUMERIC), 0)
                        ELSE NULL
                    END
                ELSE NULL
            END AS realized_pnl,
            (
                (sd.simulated_fill->>'missed')::boolean = false
                AND sd.simulated_fill->>'exitPrice' IS NOT NULL
                AND sd.simulated_fill->>'entryPrice' IS NOT NULL
                AND sd.simulated_fill->>'entryPrice' != '0'
            ) AS traded
        FROM shadow_decisions sd
        WHERE sd.strategy_version_id = ${versionParam}
          AND sd.action = 'open'
          AND sd.created_at >= $3
          AND sd.created_at <  $4
          AND sd.event_id IS NOT NULL
    )`;
}

// Builds the full paired-diff query for a given (A-status, B-status) pair. Each
// side's CTE is selected structurally (active vs shadow); values stay positional
// ($1=A version, $2=B version, $3=from, $4=to). The paired CTE joins on the
// shared `event_id`; an event counts as paired-traded only when BOTH sides traded.
// The PnL delta sums `a.realized_pnl - b.realized_pnl` only where both are
// non-null. Shadow-side PnL is computed from the fill JSONB (see buildShadowSideCte);
// force_close fills produce ~0 gross PnL, so meanPnlDeltaUsd is near-zero until a
// retroactive replay job provides real forward-bar fills.
// Source selection uses the version's CURRENT status, not point-in-time; a version
// that transitioned active→shadow mid-window loses its earlier active-stream history.
// This is a known approximation; a full point-in-time union is deferred.
// why: Postgres `AVG(NUMERIC)` returns a heuristic scale that varies across
// PG versions and can drop sub-cent precision. We return SUM / COUNT only and
// compute the mean in JS via shared decimal context.
function buildPairedDiffSql(aStatus: string, bStatus: string): string {
    const sideA = aStatus === STRATEGY_STATUS_ACTIVE ? buildActiveSideCte('side_a', '$1') : buildShadowSideCte('side_a', '$1');
    const sideB = bStatus === STRATEGY_STATUS_ACTIVE ? buildActiveSideCte('side_b', '$2') : buildShadowSideCte('side_b', '$2');

    return `
    WITH${sideA},${sideB},
    paired AS (
        SELECT
            a.realized_pnl AS a_realized_pnl,
            b.realized_pnl AS b_realized_pnl,
            (a.traded AND b.traded) AS both_traded
        FROM side_a a
        INNER JOIN side_b b USING (event_id)
    )
    SELECT
        COUNT(*)::text AS paired_event_count,
        COUNT(*) FILTER (WHERE both_traded)::text AS paired_traded_event_count,
        COALESCE(
            SUM((a_realized_pnl - b_realized_pnl)) FILTER (WHERE a_realized_pnl IS NOT NULL AND b_realized_pnl IS NOT NULL),
            0
        )::text AS net_pnl_delta_usd
    FROM paired
`;
}

export async function compareVersions(ds: DataSource, params: ICompareVersionsParams): Promise<IVersionComparisonResult> {
    validateVersionPairOrThrow(params.aVersionId, params.bVersionId);
    validateDateRangeOrThrow(params.from, params.to);

    // Per-version metrics reuse `getPerformance` (same SQL, same window
    // semantics) so a future change to the per-version aggregation propagates
    // to comparison without drift. `getPerformance` returns each version's
    // `status`, which also selects the paired-diff source per side (active →
    // `decisions`/`positions`; shadow → `shadow_decisions`).
    const [aPerformance, bPerformance] = await Promise.all([
        getPerformance(ds, { versionId: params.aVersionId, from: params.from, to: params.to }),
        getPerformance(ds, { versionId: params.bVersionId, from: params.from, to: params.to }),
    ]);

    const pairedDiffSql = buildPairedDiffSql(aPerformance.status, bPerformance.status);
    const rows: IPairedDiffRow[] = await ds.query(pairedDiffSql, [params.aVersionId, params.bVersionId, params.from.toISOString(), params.to.toISOString()]);

    const row = rows[0];
    const pairedEventCount = row !== undefined ? Number(row.paired_event_count) : 0;
    const pairedTradedEventCount = row !== undefined ? Number(row.paired_traded_event_count) : 0;
    const rawNetPnlDelta = row !== undefined && row.net_pnl_delta_usd !== null ? row.net_pnl_delta_usd : '0';
    // why: wrap the raw `::text` cast through shared decimalMath so the
    // surface shape matches engine's `Money.toFixed()` exit point — same
    // numeric value, identical string form.
    const netPnlDeltaUsd = formatMoneyString(rawNetPnlDelta);
    const belowSampleFloor = pairedTradedEventCount < MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN;

    // M39 W2 (D3 gate): a shadow side dominated by same-bar force_close fills
    // (≈ −fees placeholders) cannot support a trustworthy mean-PnL comparison.
    // Abstain when EITHER side's force-close fraction exceeds the threshold. A
    // null fraction (active version — no shadow fills) contributes no abstain
    // signal. When abstaining, suppress the mean (same pattern as belowSampleFloor)
    // so a placeholder-heavy comparison cannot read as "edge".
    const forceCloseAbstain = exceedsForceCloseThreshold(aPerformance.forceCloseFraction) || exceedsForceCloseThreshold(bPerformance.forceCloseFraction);

    // why: compute the mean in application code (SUM / COUNT) rather than
    // letting Postgres `AVG(NUMERIC)` choose its own scale — keeps precision
    // deterministic across PG versions. Suppress the result below the sample
    // floor OR when the force-close guard abstains: neither a single-sample
    // mean nor a placeholder-dominated mean can read as "edge". The sum
    // (netPnlDeltaUsd) is still exposed — totals are not misleading the way
    // suppressed averages are.
    // why: route the mean through `formatMoneyString` so it lands on the same
    // canonical `decimal.js .toFixed()` surface the engine's `Money.toFixed()`
    // exit point produces (matches `netPnlDeltaUsd` above). Direct
    // `.dividedBy().toFixed()` can emit up-to-20-decimal-place strings for
    // non-terminating quotients — formatMoneyString re-normalises through the
    // same Decimal pipeline the rest of the surface uses.
    const meanPnlDeltaUsd =
        !belowSampleFloor && !forceCloseAbstain && pairedTradedEventCount > 0
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
            forceCloseAbstain,
        },
    };
}

// M39 W2: a shadow side "exceeds the threshold" when its force-close fraction is
// non-null AND strictly greater than MAX_FORCE_CLOSE_FRACTION. A null fraction
// (active version, or a shadow with zero traded fills) is NOT an abstain signal.
// Compared as Decimal values to honour the money-is-Decimal invariant.
function exceedsForceCloseThreshold(forceCloseFraction: string | null): boolean {
    if (forceCloseFraction === null) {
        return false;
    }

    return new Decimal(forceCloseFraction).greaterThan(new Decimal(MAX_FORCE_CLOSE_FRACTION));
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
