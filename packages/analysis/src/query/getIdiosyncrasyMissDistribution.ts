// M30 D3 — `getIdiosyncrasyMissDistribution` query function.
//
// `no_eligible_slot` was the #3 reachable M29 reject. `getFunnelSummary` counts
// it but cannot show HOW FAR each rejected coin missed the idiosyncrasy gate.
// This query derives, per UTC day, a histogram of the miss distance:
//
//     missDistance = activeMinScore − idiosyncrasyScore
//
// bucketed into five equal-width bands `[0,0.1)`, `[0.1,0.2)`, `[0.2,0.3)`,
// `[0.3,0.4)`, `[0.4,0.5]` (the top band is closed on both ends so deep
// BTC-beta rejects near score=0 stay distinguishable from borderline misses).
//
// Purpose: answer "are most `no_eligible_slot` rejects deep BTC-beta (large
// miss, correctly filtered) or a cluster of marginal misses (small miss,
// future calibration candidate)?" — evidence for a SEPARATE threshold-move
// milestone, starting from the real 0.5 cut, not the WIP's stale 0.3.
//
// `activeMinScore` is passed in by the caller (resolved from
// `ACTIVE_STRATEGY_VERSION_ID` — the env-selected version, NOT the
// `status='active'` DB row which points to the v0 seed). The query has no
// engine config access. Typical value: '0.5'.
//
// A coin scoring exactly at the threshold passes the gate (missDistance = 0)
// and must never appear here — the boundary is exclusive at the bottom. A row
// with no `idiosyncrasy_score` in its snapshot is counted as unknown, never as
// a 0-score artifact.
//
// SQL is parameterized via positional bindings ($1, $2). String interpolation
// into SQL is banned by the boundary lint (R0) and the dev-qa-cycle invariant.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';

import { MISS_DISTANCE_BUCKET_EDGES } from '../const/index.js';
import { AnalysisValidationError, validateDateOrderOrThrow, validateUtcDateOrThrow } from '../util/analysisValidation.js';

const BUCKET_COUNT = MISS_DISTANCE_BUCKET_EDGES.length - 1;

export interface IMissDistributionBucket {
    readonly label: string; // '[0,0.1)' etc
    readonly count: number;
}

export interface IIdiosyncrasyMissDistributionRow {
    readonly utcDate: string; // 'YYYY-MM-DD'
    readonly buckets: IMissDistributionBucket[];
    readonly totalRejections: number;
    readonly unknownScoreCount: number; // rows with no idiosyncrasy_score in snapshot
}

export interface IIdiosyncrasyMissDistributionParams {
    readonly fromDate: string; // 'YYYY-MM-DD'
    readonly toDate: string; // 'YYYY-MM-DD'
    readonly activeMinScore: string; // decimal string, e.g. '0.5'
}

// One row per `no_eligible_slot` open decision in range. `idiosyncrasy_score`
// is the raw snapshot value (null when the snapshot predates score-stamping).
interface IRejectRow {
    readonly utc_date: string;
    readonly idiosyncrasy_score: string | null;
}

const MISS_DISTRIBUTION_SQL = `
    SELECT
        to_char(d.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')   AS utc_date,
        (d.market_snapshot->>'idiosyncrasy_score')       AS idiosyncrasy_score
    FROM decisions d
    WHERE d.action = 'open'
      AND d.reason = 'no_eligible_slot'
      AND (d.ts AT TIME ZONE 'UTC') >= ($1)::date
      AND (d.ts AT TIME ZONE 'UTC') <  (($2)::date + INTERVAL '1 day')
    ORDER BY d.ts ASC
`;

/**
 * Per-UTC-day miss-distance histogram for `no_eligible_slot` open decisions
 * over an inclusive UTC date range. Both ends inclusive; the SQL spans
 * `[fromDate 00:00 UTC, toDate+1 day 00:00 UTC)` on `ts`.
 */
export async function getIdiosyncrasyMissDistribution(
    ds: DataSource,
    params: IIdiosyncrasyMissDistributionParams,
): Promise<IIdiosyncrasyMissDistributionRow[]> {
    validateUtcDateOrThrow('fromDate', params.fromDate);
    validateUtcDateOrThrow('toDate', params.toDate);
    validateDateOrderOrThrow(params.fromDate, params.toDate);
    const activeMinScore = parseActiveMinScoreOrThrow(params.activeMinScore);

    const rows: IRejectRow[] = await ds.query(MISS_DISTRIBUTION_SQL, [params.fromDate, params.toDate]);

    return aggregateByDay(rows, activeMinScore);
}

function aggregateByDay(rows: IRejectRow[], activeMinScore: Decimal): IIdiosyncrasyMissDistributionRow[] {
    const perDay = new Map<string, IDayAccumulator>();

    for (const row of rows) {
        const day = ensureDay(perDay, row.utc_date);
        day.totalRejections += 1;

        if (row.idiosyncrasy_score === null) {
            day.unknownScoreCount += 1;
            continue;
        }

        let idiosyncrasyScoreDecimal: Decimal;
        try {
            idiosyncrasyScoreDecimal = new Decimal(row.idiosyncrasy_score);
        } catch {
            day.unknownScoreCount += 1;
            continue;
        }

        if (!idiosyncrasyScoreDecimal.isFinite()) {
            day.unknownScoreCount += 1;
            continue;
        }

        const missDistance = activeMinScore.minus(idiosyncrasyScoreDecimal);
        const bucketIndex = resolveBucketIndex(missDistance);

        // missDistance ≤ 0 means the coin scored at or above the gate — it
        // passed and must never appear in this distribution (boundary guard).
        if (bucketIndex !== null) {
            day.bucketCounts[bucketIndex] += 1;
        }
    }

    return toSortedRows(perDay);
}

interface IDayAccumulator {
    totalRejections: number;
    unknownScoreCount: number;
    readonly bucketCounts: number[];
}

function ensureDay(perDay: Map<string, IDayAccumulator>, utcDate: string): IDayAccumulator {
    const existing = perDay.get(utcDate);

    if (existing !== undefined) {
        return existing;
    }

    const created: IDayAccumulator = {
        totalRejections: 0,
        unknownScoreCount: 0,
        bucketCounts: new Array(BUCKET_COUNT).fill(0),
    };
    perDay.set(utcDate, created);

    return created;
}

// Resolves the miss distance to a bucket index, or null when it falls outside
// the [0,0.5] range. Lower edge is exclusive (a gate-passer at distance 0 is
// dropped); the final band [0.4,0.5] is closed on both ends.
function resolveBucketIndex(missDistance: Decimal): number | null {
    if (missDistance.lessThanOrEqualTo(0)) {
        return null;
    }

    for (let i = 0; i < BUCKET_COUNT; i += 1) {
        const upperEdge = new Decimal(MISS_DISTANCE_BUCKET_EDGES[i + 1]);
        const isLastBucket = i === BUCKET_COUNT - 1;

        if (isLastBucket) {
            if (missDistance.lessThanOrEqualTo(upperEdge)) {
                return i;
            }

            return null;
        }

        if (missDistance.lessThan(upperEdge)) {
            return i;
        }
    }

    return null;
}

function toSortedRows(perDay: Map<string, IDayAccumulator>): IIdiosyncrasyMissDistributionRow[] {
    const utcDates = [...perDay.keys()].sort();

    return utcDates.map((utcDate) => {
        const day = perDay.get(utcDate) as IDayAccumulator;

        return {
            utcDate,
            buckets: day.bucketCounts.map((count, index) => ({ label: bucketLabel(index), count })),
            totalRejections: day.totalRejections,
            unknownScoreCount: day.unknownScoreCount,
        };
    });
}

function bucketLabel(index: number): string {
    const lower = MISS_DISTANCE_BUCKET_EDGES[index];
    const upper = MISS_DISTANCE_BUCKET_EDGES[index + 1];
    const isLastBucket = index === BUCKET_COUNT - 1;
    const closingBracket = isLastBucket ? ']' : ')';

    return `[${lower},${upper}${closingBracket}`;
}

function parseActiveMinScoreOrThrow(raw: string): Decimal {
    let value: Decimal;

    try {
        value = new Decimal(raw);
    } catch {
        throw new AnalysisValidationError('activeMinScore', `must be a decimal string, got "${String(raw)}"`);
    }

    if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
        throw new AnalysisValidationError('activeMinScore', `must be a positive finite decimal, got "${String(raw)}"`);
    }

    return value;
}
