// M52 D3 (ADR 0051 §6 / §6.1) — `getRetryAttribution` query function.
//
// The paper-soak measurement surface for the xmom force_close slot-recovery retry. It answers the
// data questions the D4 go/no-go bar needs, over CLOSED positions for one strategy version in a
// [from, to) window. Per the amended measurement contract (ADR 0051 §6.1) the metrics draw from TWO
// distinct row sources that must NOT share a single fenced query:
//
//   metric 1 — survival rate (gate b): of retries that fired, how many survived the fill-acceptance
//     guard vs force_close'd again. Sourced from RETRY_ALL_SQL, which KEEPS force_close retry legs
//     (a force_close IS the numerator of the survival rate).
//
//   metric 2 — matched-control forward return (gate a, the HARD gate): retry entries vs ATTEMPT-1
//     entries matched on (coin_tier, ATR%-of-price band). Sourced from MATCHED_ENTRIES_SQL, which
//     EXCLUDES force_close legs from BOTH arms — a force_close's realized_pnl is a ~$0.20 unwind
//     artifact, not a forward return, and leaving it in the attempt-1 arm dilutes the baseline with
//     near-zero rows for exactly the coins that got retried (§6.1). The comparison is a size-invariant
//     RETURN ON ENTRY NOTIONAL (`realized_pnl / entry_notional`), not raw dollar PnL: sizing is
//     ATR-risk-normalized, so a risen post-drift ATR shrinks the retry's notional and a raw-dollar
//     compare would make a genuinely-worse-per-unit retry look benign (§6.1). Each cell also reports
//     per-arm count + population stddev of the return and the standard error of the delta, so a
//     thin-cell single-trade artifact is distinguishable from genuine adverse selection.
//
//   metric 5 — counterfactual PnL: SUM(realized_pnl) over retry entries (RETRY_ALL_SQL, force_close
//     legs KEPT — a force-closed retry's unwind cost is a real cost of the mechanism vs an empty
//     slot). A retried slot that never fired would have contributed $0, so the retry set's net
//     realized PnL IS the counterfactual delta vs leaving the slots empty. realized_pnl is already
//     fee/funding-net; see the flat-fill-sim caveat below.
//
//   metric 3 — drift distribution: a histogram of force_close_atr_units_drift over ALL force_close
//     rows, so D4 can calibrate MOMENTUM_RETRY_MAX_ATR_DRIFT from where the stale-reference cluster
//     ends. The histogram is an eyeballing aid only; the final threshold is set from the RAW column.
//
//   metric 4 (realized slippage) is deliberately NOT computed here (ADR 0051 §6.1): it is blocked on
//     a slippage-aware fill simulator, not on query design — under the flat-fill sim it would report
//     a circular constant, not a measurement.
//
// Flat-fill-sim caveat (M51 carry-over, ADR 0051 §D3): if the paper fill simulator fills flat at
// best-quote with zero slippage, the counterfactual PnL (metric 5) and any slippage read are
// PIPELINE-VALIDATION ONLY, not edge. The matched-control forward comparison (metric 2) is less
// sensitive but must still be read with the caveat. It is surfaced on the report as `flatFillSimCaveat`.
//
// SQL is parameterized via positional bindings ($1, $2, $3). String interpolation of a BOUND value is
// banned by the boundary lint (R0); the only interpolated tokens are fixed @bot/shared enum literals
// (never user input), matching the established getPerformance precedent.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';
import { ExitReasonEnum, RebalanceTriggerSourceEnum } from '@bot/shared';

import { RETRY_ATR_PCT_BUCKET_EDGES, RETRY_DRIFT_BUCKET_EDGES, RETRY_FLAT_FILL_SIM_CAVEAT } from '../const/index.js';
import { validateDateRangeOrThrow, validateVersionIdOrThrow } from '../util/analysisValidation.js';

export interface IGetRetryAttributionParams {
    readonly versionId: number;
    readonly from: Date;
    readonly to: Date;
}

export interface IRetrySurvival {
    readonly firedCount: number;
    readonly survivedCount: number;
    readonly forceClosedAgainCount: number;
    readonly survivalRate: string; // 1 − forceClosedAgainCount / firedCount
}

export interface IRetryCounterfactual {
    readonly retryEntryCount: number;
    readonly retryWinCount: number;
    readonly retryNetPnlUsd: string; // metric 5 primary — SUM(realized_pnl) over retry entries
}

export interface IMatchedControlCell {
    readonly coinTier: string;
    readonly atrPctBucket: string; // e.g. '[0.01,0.02)'
    readonly retryCount: number;
    readonly retryAvgReturnOnNotional: string;
    readonly retryReturnStdDev: string;
    readonly attempt1Count: number;
    readonly attempt1AvgReturnOnNotional: string;
    readonly attempt1ReturnStdDev: string;
    readonly avgReturnDelta: string; // retry − attempt1 (negative ⇒ adverse selection)
    readonly deltaStdErr: string; // sqrt(s²_retry/n_retry + s²_attempt1/n_attempt1)
}

export interface IDriftDistributionBucket {
    readonly label: string; // '[0,0.25)' etc
    readonly count: number;
}

export interface IRetryAttributionReport {
    readonly strategyVersionId: string;
    readonly windowFrom: string;
    readonly windowTo: string;
    readonly survival: IRetrySurvival;
    readonly counterfactual: IRetryCounterfactual;
    readonly matchedControl: readonly IMatchedControlCell[];
    readonly driftDistribution: readonly IDriftDistributionBucket[];
    readonly flatFillSimCaveat: string;
}

interface IMatchedEntryRow {
    readonly realized_pnl: string | null;
    readonly entry_notional: string | null;
    readonly coin_tier: string | null;
    readonly atr_at_entry: string | null;
    readonly entry_price: string | null;
}

interface IRetryAllRow {
    readonly realized_pnl: string | null;
    readonly exit_reason: string | null;
}

interface IDriftRow {
    readonly drift: string | null;
}

// metric 2 row source — closed entries for one version in-window, split by is_retry_entry, with
// force_close legs EXCLUDED from BOTH arms (§6.1): a force_close's realized_pnl is a ~$0.20 unwind
// artifact, not a forward return. Manual (operator smoke-test / ad-hoc) rebalances are fenced out of
// both arms (M50c precedent). `$4` distinguishes the retry arm (true) from the attempt-1 arm.
const MATCHED_ENTRIES_SQL = `
    SELECT
        p.realized_pnl::text    AS realized_pnl,
        p.entry_notional::text  AS entry_notional,
        p.coin_tier             AS coin_tier,
        p.atr_at_entry::text    AS atr_at_entry,
        p.entry_price::text     AS entry_price
    FROM positions p
    WHERE p.strategy_version_id = $1
      AND p.state = 'closed'
      AND p.closed_at >= $2
      AND p.closed_at <  $3
      AND p.realized_pnl IS NOT NULL
      AND p.exit_reason IS DISTINCT FROM '${ExitReasonEnum.FORCE_CLOSE}'
      AND (p.trigger_source IS NULL OR p.trigger_source <> '${RebalanceTriggerSourceEnum.MANUAL}')
      AND (CASE WHEN $4 THEN p.is_retry_entry = true ELSE (p.is_retry_entry IS NULL OR p.is_retry_entry = false) END)
`;

// metrics 1 + 5 row source — ALL closed retry entries for one version in-window, KEEPING force_close
// legs (a force-closed retry's unwind cost is a real cost vs an empty slot, and it is the numerator of
// the survival rate — §6.1). Manual rebalances are fenced out. `exit_reason` drives the survival split.
const RETRY_ALL_SQL = `
    SELECT
        p.realized_pnl::text  AS realized_pnl,
        p.exit_reason         AS exit_reason
    FROM positions p
    WHERE p.strategy_version_id = $1
      AND p.state = 'closed'
      AND p.closed_at >= $2
      AND p.closed_at <  $3
      AND p.realized_pnl IS NOT NULL
      AND p.is_retry_entry = true
      AND (p.trigger_source IS NULL OR p.trigger_source <> '${RebalanceTriggerSourceEnum.MANUAL}')
`;

// All force_close rows for one version in-window that carry a measured anchor drift (metric 3).
// Manual (operator smoke-test) rebalances are fenced out, matching the entry queries, so an operator
// pnpm rebalance:trigger run cannot contaminate the threshold-calibration histogram.
const DRIFT_SQL = `
    SELECT
        p.force_close_atr_units_drift::text AS drift
    FROM positions p
    WHERE p.strategy_version_id = $1
      AND p.exit_reason = '${ExitReasonEnum.FORCE_CLOSE}'
      AND p.force_close_atr_units_drift IS NOT NULL
      AND (p.trigger_source IS NULL OR p.trigger_source <> '${RebalanceTriggerSourceEnum.MANUAL}')
      AND p.closed_at >= $2
      AND p.closed_at <  $3
`;

export async function getRetryAttribution(ds: DataSource, params: IGetRetryAttributionParams): Promise<IRetryAttributionReport> {
    validateVersionIdOrThrow(params.versionId);
    validateDateRangeOrThrow(params.from, params.to);

    const binds = [params.versionId, params.from.toISOString(), params.to.toISOString()];
    const matchedRetryRows: IMatchedEntryRow[] = await ds.query(MATCHED_ENTRIES_SQL, [...binds, true]);
    const matchedAttempt1Rows: IMatchedEntryRow[] = await ds.query(MATCHED_ENTRIES_SQL, [...binds, false]);
    const retryAllRows: IRetryAllRow[] = await ds.query(RETRY_ALL_SQL, binds);
    const driftRows: IDriftRow[] = await ds.query(DRIFT_SQL, binds);

    return {
        strategyVersionId: String(params.versionId),
        windowFrom: params.from.toISOString(),
        windowTo: params.to.toISOString(),
        survival: computeSurvival(retryAllRows),
        counterfactual: computeCounterfactual(retryAllRows),
        matchedControl: computeMatchedControl(matchedRetryRows, matchedAttempt1Rows),
        driftDistribution: computeDriftDistribution(driftRows),
        flatFillSimCaveat: RETRY_FLAT_FILL_SIM_CAVEAT,
    };
}

// metric 1 — survival rate. Split the retry row set on exit_reason: a force_close retry leg did not
// survive its own fill-acceptance guard. survivalRate = 1 − forceClosedAgainCount / firedCount.
function computeSurvival(retryRows: readonly IRetryAllRow[]): IRetrySurvival {
    const firedCount = retryRows.length;
    let forceClosedAgainCount = 0;

    for (const row of retryRows) {
        if (row.exit_reason === ExitReasonEnum.FORCE_CLOSE) {
            forceClosedAgainCount += 1;
        }
    }

    const survivedCount = firedCount - forceClosedAgainCount;
    const survivalRate = firedCount === 0 ? '0' : new Decimal(1).minus(new Decimal(forceClosedAgainCount).dividedBy(firedCount)).toFixed();

    return { firedCount, survivedCount, forceClosedAgainCount, survivalRate };
}

// metric 5 — the retry set's net realized PnL IS the counterfactual vs leaving those slots empty.
// Force_close retry legs are KEPT (their unwind cost is a real cost of the mechanism).
function computeCounterfactual(retryRows: readonly IRetryAllRow[]): IRetryCounterfactual {
    let netPnl = new Decimal(0);
    let winCount = 0;

    for (const row of retryRows) {
        const pnl = new Decimal(row.realized_pnl ?? '0');
        netPnl = netPnl.plus(pnl);

        if (pnl.greaterThan(0)) {
            winCount += 1;
        }
    }

    return {
        retryEntryCount: retryRows.length,
        retryWinCount: winCount,
        retryNetPnlUsd: netPnl.toFixed(),
    };
}

interface ICellAccumulator {
    readonly coinTier: string;
    readonly atrPctBucket: string;
    retryReturnSum: Decimal;
    retryReturnSqSum: Decimal;
    retryCount: number;
    attempt1ReturnSum: Decimal;
    attempt1ReturnSqSum: Decimal;
    attempt1Count: number;
}

interface IPopulationStats {
    readonly mean: Decimal;
    readonly variance: Decimal;
    readonly stdDev: Decimal;
}

// metric 2 — matched-control on RETURN ON NOTIONAL. Bucket both arms by (coin_tier, ATR%-band); emit
// a cell only when BOTH arms populated it, so the comparison is a matched control rather than a naive
// whole-basket average. Reports per-arm dispersion + the delta's standard error (§6.1).
function computeMatchedControl(retryRows: readonly IMatchedEntryRow[], attempt1Rows: readonly IMatchedEntryRow[]): IMatchedControlCell[] {
    const cells = new Map<string, ICellAccumulator>();

    for (const row of retryRows) {
        accumulate(cells, row, true);
    }

    for (const row of attempt1Rows) {
        accumulate(cells, row, false);
    }

    const matched: IMatchedControlCell[] = [];

    for (const cell of cells.values()) {
        if (cell.retryCount === 0 || cell.attempt1Count === 0) {
            continue;
        }

        const retryStats = populationStats(cell.retryReturnSum, cell.retryReturnSqSum, cell.retryCount);
        const attempt1Stats = populationStats(cell.attempt1ReturnSum, cell.attempt1ReturnSqSum, cell.attempt1Count);
        const deltaStdErr = retryStats.variance.dividedBy(cell.retryCount).plus(attempt1Stats.variance.dividedBy(cell.attempt1Count)).sqrt();

        matched.push({
            coinTier: cell.coinTier,
            atrPctBucket: cell.atrPctBucket,
            retryCount: cell.retryCount,
            retryAvgReturnOnNotional: retryStats.mean.toFixed(),
            retryReturnStdDev: retryStats.stdDev.toFixed(),
            attempt1Count: cell.attempt1Count,
            attempt1AvgReturnOnNotional: attempt1Stats.mean.toFixed(),
            attempt1ReturnStdDev: attempt1Stats.stdDev.toFixed(),
            avgReturnDelta: retryStats.mean.minus(attempt1Stats.mean).toFixed(),
            deltaStdErr: deltaStdErr.toFixed(),
        });
    }

    return matched.sort((left, right) => buildCellKey(left.coinTier, left.atrPctBucket).localeCompare(buildCellKey(right.coinTier, right.atrPctBucket)));
}

// Population moments over a cell arm: mean, variance = E[x²] − E[x]², stddev = sqrt(variance). The
// variance is floored at 0 to absorb the tiny negative that decimal rounding can produce when every
// sample is identical (variance is mathematically 0 there).
function populationStats(sum: Decimal, sqSum: Decimal, count: number): IPopulationStats {
    const mean = sum.dividedBy(count);
    const meanOfSquares = sqSum.dividedBy(count);
    const variance = Decimal.max(0, meanOfSquares.minus(mean.times(mean)));

    return { mean, variance, stdDev: variance.sqrt() };
}

function accumulate(cells: Map<string, ICellAccumulator>, row: IMatchedEntryRow, isRetry: boolean): void {
    const returnOnNotional = resolveReturnOnNotional(row);

    if (returnOnNotional === null) {
        return;
    }

    const coinTier = row.coin_tier ?? 'unknown';
    const atrPctBucket = resolveAtrPctBucketLabel(row);
    const cell = ensureCell(cells, coinTier, atrPctBucket);
    const returnSquared = returnOnNotional.times(returnOnNotional);

    if (isRetry) {
        cell.retryReturnSum = cell.retryReturnSum.plus(returnOnNotional);
        cell.retryReturnSqSum = cell.retryReturnSqSum.plus(returnSquared);
        cell.retryCount += 1;

        return;
    }

    cell.attempt1ReturnSum = cell.attempt1ReturnSum.plus(returnOnNotional);
    cell.attempt1ReturnSqSum = cell.attempt1ReturnSqSum.plus(returnSquared);
    cell.attempt1Count += 1;
}

// Return on entry notional for a row, or null when notional is absent, zero, or non-finite (an
// uncomputable return — the row is dropped from the matched control, not bucketed as 'unknown').
function resolveReturnOnNotional(row: IMatchedEntryRow): Decimal | null {
    if (row.realized_pnl === null || row.entry_notional === null) {
        return null;
    }

    try {
        const entryNotional = new Decimal(row.entry_notional);

        if (!entryNotional.isFinite() || entryNotional.isZero()) {
            return null;
        }

        const returnOnNotional = new Decimal(row.realized_pnl).dividedBy(entryNotional);

        return returnOnNotional.isFinite() ? returnOnNotional : null;
    } catch {
        return null;
    }
}

function ensureCell(cells: Map<string, ICellAccumulator>, coinTier: string, atrPctBucket: string): ICellAccumulator {
    const key = buildCellKey(coinTier, atrPctBucket);
    const existing = cells.get(key);

    if (existing !== undefined) {
        return existing;
    }

    const created: ICellAccumulator = {
        coinTier,
        atrPctBucket,
        retryReturnSum: new Decimal(0),
        retryReturnSqSum: new Decimal(0),
        retryCount: 0,
        attempt1ReturnSum: new Decimal(0),
        attempt1ReturnSqSum: new Decimal(0),
        attempt1Count: 0,
    };
    cells.set(key, created);

    return created;
}

// The map key joins tier + band with a separator that appears in neither a coin_tier enum value
// ('tier_1'/'tier_2') nor a bucket label ('[0.01,0.02)'), so two distinct cells never collide.
function buildCellKey(coinTier: string, atrPctBucket: string): string {
    return `${coinTier}::${atrPctBucket}`;
}

// ATR%-of-price band label for a row, or 'unknown' when atr/price is absent or non-finite.
function resolveAtrPctBucketLabel(row: IMatchedEntryRow): string {
    if (row.atr_at_entry === null || row.entry_price === null) {
        return 'unknown';
    }

    let atrPct: Decimal;
    try {
        const entryPrice = new Decimal(row.entry_price);

        if (!entryPrice.isFinite() || entryPrice.lessThanOrEqualTo(0)) {
            return 'unknown';
        }

        atrPct = new Decimal(row.atr_at_entry).dividedBy(entryPrice);
    } catch {
        return 'unknown';
    }

    if (!atrPct.isFinite() || atrPct.lessThan(0)) {
        return 'unknown';
    }

    return bucketLabel(RETRY_ATR_PCT_BUCKET_EDGES, resolveBucketIndex(RETRY_ATR_PCT_BUCKET_EDGES, atrPct));
}

// metric 3 — force_close ATR-unit drift histogram.
function computeDriftDistribution(driftRows: readonly IDriftRow[]): IDriftDistributionBucket[] {
    const counts = new Array<number>(RETRY_DRIFT_BUCKET_EDGES.length - 1).fill(0);

    for (const row of driftRows) {
        if (row.drift === null) {
            continue;
        }

        let drift: Decimal;
        try {
            drift = new Decimal(row.drift);
        } catch {
            continue;
        }

        if (!drift.isFinite() || drift.lessThan(0)) {
            continue;
        }

        counts[resolveBucketIndex(RETRY_DRIFT_BUCKET_EDGES, drift)] += 1;
    }

    return counts.map((count, index) => ({ label: bucketLabel(RETRY_DRIFT_BUCKET_EDGES, index), count }));
}

// Half-open bucketing `[edge[i], edge[i+1])`; a value at/above the last finite edge lands in the final
// open-ended band. `value >= 0` is guaranteed by callers, so index 0 is the floor.
function resolveBucketIndex(edges: readonly number[], value: Decimal): number {
    for (let i = 1; i < edges.length - 1; i += 1) {
        if (value.lessThan(edges[i])) {
            return i - 1;
        }
    }

    return edges.length - 2;
}

function bucketLabel(edges: readonly number[], index: number): string {
    const lower = edges[index];
    const upper = edges[index + 1];

    if (upper === Number.POSITIVE_INFINITY) {
        return `[${lower},∞)`;
    }

    return `[${lower},${upper})`;
}
