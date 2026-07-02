// M30 D2 — `getIdiosyncraticEdgeReport` query function (the slot-C go/no-go instrument).
//
// Reads the closed-trade expectancy of the IDIOSYNCRATIC leg over a UTC date
// range and reports whether the ADR 0004 §8a sample-size floors are met. This
// is the executable form of the slot-C gate: the operator runs one query and
// reads `slotCGateOpen` instead of asserting "≥20 trades" in prose.
//
// **Denominator is reconstructed, NOT read (F1).** `effectiveRiskUsdt` lives
// only on the engine-internal `IIntentSizing` and is never persisted on any
// row (`StrategyService.buildGateGeometry` persists qty/notional/leverage
// only). M30 therefore reconstructs the realized per-trade risk denominator
// from fill-anchored `positions` columns:
//
//     reconstructedEffectiveRiskUsdt = qty × |entry_price − stop_loss_price|
//
// A trade where ANY of qty/entry_price/stop_loss_price is null → null
// R-multiple → excluded from the expectancy aggregate (never a target-based
// fallback).
//
// **Open-decision join is a LATERAL time-join (F3).** `decisions.position_id`
// exists but is never stamped on open, so the BTC-move sub-split snapshot is
// recovered by joining each closed position to the most-recent matching open
// decision on `(strategy_version_id, symbol, ts ≤ opened_at)` — not via the
// (null) position_id foreign key.
//
// **`slotCGateOpen` is sample-readiness, NOT edge-positive (ADR 0004 §8b).**
// It means "enough closed trades to evaluate" = meetsClosedTradeFloor AND
// meetsTradingDayFloor. A measured negative expectancy with the gate open is
// actionable data ("decide"), not a build signal. `regimeRobustnessPasses` is
// advisory and is NOT AND'd into the gate.
//
// All PnL / R-multiple arithmetic is decimal (`decimal.js`) at the query
// boundary — the SQL returns raw per-trade rows and TypeScript does the final
// mean / stddev / standard-error aggregation to avoid float precision drift.
//
// SQL is parameterized via positional bindings ($1, $2). String interpolation
// into SQL is banned by the boundary lint (R0) and the dev-qa-cycle invariant.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';
import { RebalanceTriggerSourceEnum } from '@bot/shared';

import { BTC_REGIME_PARTITION_PCT, MIN_CLOSED_TRADES_FOR_EDGE_VERDICT, MIN_TRADING_DAYS_FOR_EDGE_VERDICT, REGIME_BUCKET_MIN_N } from '../const/index.js';
import { AnalysisValidationError, validateDateOrderOrThrow, validateUtcDateOrThrow } from '../util/analysisValidation.js';

export interface IRegimeBucket {
    readonly n: number;
    readonly meanRMultiple: string | null; // decimal string or null when n=0
}

export interface IIdiosyncraticEdgeReport {
    readonly n: number;
    readonly distinctTradingDays: number;
    readonly meanRMultiple: string | null; // decimal string
    readonly rMultipleStdError: string | null; // null when n < 2
    readonly clampedTradeCount: number;
    readonly clampedTradeFraction: string; // decimal string '0.00'–'1.00'
    readonly meetsClosedTradeFloor: boolean;
    readonly meetsTradingDayFloor: boolean;
    readonly btc5mUp: IRegimeBucket;
    readonly btc5mDown: IRegimeBucket;
    readonly btc5mFlat: IRegimeBucket;
    readonly regimeRobustnessPasses: boolean; // advisory; NOT in slotCGateOpen
    readonly slotCGateOpen: boolean; // = meetsClosedTradeFloor AND meetsTradingDayFloor
}

export interface IIdiosyncraticEdgeReportParams {
    readonly fromDate: string; // 'YYYY-MM-DD'
    readonly toDate: string; // 'YYYY-MM-DD'
    readonly riskPerTradeUsdt: string; // decimal string, e.g. '15.00'
}

// One row per closed idiosyncratic position in range. The reconstructed risk
// denominator and R-multiple are computed in SQL with CASE WHEN ... ELSE NULL
// so any null reconstruction column propagates a null R-multiple (excluded in
// TypeScript). `btc_5m_move_pct` comes from the LATERAL open-decision snapshot.
interface IEdgeTradeRow {
    readonly utc_date: string;
    readonly realized_pnl: string | null;
    readonly reconstructed_risk_usdt: string | null;
    readonly r_multiple: string | null;
    readonly btc_5m_move_pct: string | null;
}

const EDGE_REPORT_SQL = `
    SELECT
        to_char(p.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')                                  AS utc_date,
        p.realized_pnl::text                                                                   AS realized_pnl,
        CASE
            WHEN p.qty IS NOT NULL AND p.entry_price IS NOT NULL AND p.stop_loss_price IS NOT NULL
                THEN (p.qty::numeric * ABS(p.entry_price::numeric - p.stop_loss_price::numeric))::text
            ELSE NULL
        END                                                                                    AS reconstructed_risk_usdt,
        CASE
            WHEN p.qty IS NOT NULL AND p.entry_price IS NOT NULL AND p.stop_loss_price IS NOT NULL
                 AND p.realized_pnl IS NOT NULL
                 AND (p.qty::numeric * ABS(p.entry_price::numeric - p.stop_loss_price::numeric)) <> 0
                THEN (p.realized_pnl::numeric / (p.qty::numeric * ABS(p.entry_price::numeric - p.stop_loss_price::numeric)))::text
            ELSE NULL
        END                                                                                    AS r_multiple,
        (latest_open_decision.market_snapshot->>'btc_5m_move_pct')                             AS btc_5m_move_pct
    FROM positions p
    LEFT JOIN LATERAL (
        SELECT d.market_snapshot
        FROM decisions d
        WHERE d.strategy_version_id = p.strategy_version_id
          AND d.symbol = p.symbol
          AND d.action = 'open'
          AND d.gate_allowed = true
          AND d.ts <= p.opened_at
        ORDER BY d.ts DESC
        LIMIT 1
    ) latest_open_decision ON true
    WHERE p.correlation_mode = 'idiosyncratic'
      AND p.state = 'closed'
      -- M50c (ADR 0048 amendment): fence manual (operator smoke-test / ad-hoc) rebalances out
      -- of the idiosyncratic-edge expectancy sample, mirroring getPerformance/compareVersions.
      -- Momentum opens are hard-coded idiosyncratic and always carry a stop-loss, so a manual
      -- trade would otherwise leak into this report and bias the exact expectancy the fence
      -- protects. NULL rows (VWAP + pre-existing) are legitimate history and are retained. The
      -- literal derives from RebalanceTriggerSourceEnum.MANUAL (a fixed enum member, not user
      -- input), so interpolation carries no bound value into the SQL.
      AND (p.trigger_source IS NULL OR p.trigger_source <> '${RebalanceTriggerSourceEnum.MANUAL}')
      AND (p.opened_at AT TIME ZONE 'UTC') >= ($1)::date
      AND (p.opened_at AT TIME ZONE 'UTC') <  (($2)::date + INTERVAL '1 day')
    ORDER BY p.opened_at ASC
`;

/**
 * Closed-trade expectancy + sample-size gate for the idiosyncratic leg over an
 * inclusive UTC date range. Both ends are inclusive; the SQL spans
 * `[fromDate 00:00 UTC, toDate+1 day 00:00 UTC)` on `opened_at`.
 */
export async function getIdiosyncraticEdgeReport(ds: DataSource, params: IIdiosyncraticEdgeReportParams): Promise<IIdiosyncraticEdgeReport> {
    validateUtcDateOrThrow('fromDate', params.fromDate);
    validateUtcDateOrThrow('toDate', params.toDate);
    validateDateOrderOrThrow(params.fromDate, params.toDate);
    const riskPerTradeUsdt = parseRiskPerTradeOrThrow(params.riskPerTradeUsdt);

    const rows: IEdgeTradeRow[] = await ds.query(EDGE_REPORT_SQL, [params.fromDate, params.toDate]);

    return aggregateEdgeReport(rows, riskPerTradeUsdt);
}

function aggregateEdgeReport(rows: IEdgeTradeRow[], riskPerTradeUsdt: Decimal): IIdiosyncraticEdgeReport {
    const eligible = rows.filter((row) => row.r_multiple !== null);
    const rMultiples = eligible.map((row) => new Decimal(row.r_multiple as string));

    const n = rMultiples.length;
    const distinctTradingDays = countDistinctTradingDays(eligible);
    const meanRMultiple = computeMean(rMultiples);
    const rMultipleStdError = computeStandardError(rMultiples, meanRMultiple);
    const clampedTradeCount = countClampedTrades(eligible, riskPerTradeUsdt);
    const clampedTradeFraction = computeClampedFraction(clampedTradeCount, n);

    const meetsClosedTradeFloor = n >= MIN_CLOSED_TRADES_FOR_EDGE_VERDICT;
    const meetsTradingDayFloor = distinctTradingDays >= MIN_TRADING_DAYS_FOR_EDGE_VERDICT;

    const btc5mUp = buildRegimeBucket(eligible, rMultiples, 'up');
    const btc5mDown = buildRegimeBucket(eligible, rMultiples, 'down');
    const btc5mFlat = buildRegimeBucket(eligible, rMultiples, 'flat');

    const regimeRobustnessPasses = computeRegimeRobustness(meanRMultiple, [btc5mUp, btc5mDown, btc5mFlat]);

    return {
        n,
        distinctTradingDays,
        meanRMultiple: meanRMultiple === null ? null : meanRMultiple.toFixed(),
        rMultipleStdError: rMultipleStdError === null ? null : rMultipleStdError.toFixed(),
        clampedTradeCount,
        clampedTradeFraction,
        meetsClosedTradeFloor,
        meetsTradingDayFloor,
        btc5mUp,
        btc5mDown,
        btc5mFlat,
        regimeRobustnessPasses,
        slotCGateOpen: meetsClosedTradeFloor && meetsTradingDayFloor,
    };
}

function countDistinctTradingDays(eligible: IEdgeTradeRow[]): number {
    const days = new Set<string>();

    for (const row of eligible) {
        days.add(row.utc_date);
    }

    return days.size;
}

function computeMean(values: Decimal[]): Decimal | null {
    if (values.length === 0) {
        return null;
    }

    const sum = values.reduce((acc, value) => acc.plus(value), new Decimal(0));

    return sum.dividedBy(values.length);
}

// Standard error of the mean = sampleStdDev / sqrt(n), using the unbiased
// (n − 1) sample variance. Returns null when n < 2 — a single trade has no
// dispersion, and returning 0 would imply false certainty.
function computeStandardError(values: Decimal[], mean: Decimal | null): Decimal | null {
    const n = values.length;

    if (n < 2 || mean === null) {
        return null;
    }

    const sumSquaredDeviations = values.reduce((acc, value) => {
        const deviation = value.minus(mean);

        return acc.plus(deviation.times(deviation));
    }, new Decimal(0));

    const variance = sumSquaredDeviations.dividedBy(n - 1);
    const stdDev = variance.sqrt();

    return stdDev.dividedBy(new Decimal(n).sqrt());
}

// A trade is "clamped" when its reconstructed realized risk fell below the
// per-trade risk target (the per-coin cap was binding). Its dollar PnL then
// produces a larger R than an unclamped trade, so the aggregate mixes two risk
// regimes — the fraction discloses how much of the mean is clamp-distorted.
function countClampedTrades(eligible: IEdgeTradeRow[], riskPerTradeUsdt: Decimal): number {
    let clamped = 0;

    for (const row of eligible) {
        const risk = new Decimal(row.reconstructed_risk_usdt as string);

        if (risk.lessThan(riskPerTradeUsdt)) {
            clamped += 1;
        }
    }

    return clamped;
}

function computeClampedFraction(clampedTradeCount: number, n: number): string {
    if (n === 0) {
        return new Decimal(0).toFixed(2);
    }

    return new Decimal(clampedTradeCount).dividedBy(n).toFixed(2);
}

type RegimeBucketKind = 'up' | 'down' | 'flat';

function buildRegimeBucket(eligible: IEdgeTradeRow[], rMultiples: Decimal[], kind: RegimeBucketKind): IRegimeBucket {
    const bucketRMultiples: Decimal[] = [];

    for (let i = 0; i < eligible.length; i += 1) {
        if (classifyBtcRegime(eligible[i].btc_5m_move_pct) === kind) {
            bucketRMultiples.push(rMultiples[i]);
        }
    }

    const mean = computeMean(bucketRMultiples);

    return {
        n: bucketRMultiples.length,
        meanRMultiple: mean === null ? null : mean.toFixed(),
    };
}

// Per-bar BTC 5m move label (NOT a regime classifier). A row whose open
// decision carries no btc_5m_move_pct snapshot is treated as 'flat' (it cannot
// be attributed to a directional bucket) so it never inflates up/down counts.
function classifyBtcRegime(btc5mMovePct: string | null): RegimeBucketKind {
    if (btc5mMovePct === null) {
        return 'flat';
    }

    let move: Decimal;
    try {
        move = new Decimal(btc5mMovePct);
    } catch {
        return 'flat';
    }

    if (!move.isFinite()) {
        return 'flat';
    }

    const boundary = new Decimal(BTC_REGIME_PARTITION_PCT);

    if (move.greaterThanOrEqualTo(boundary)) {
        return 'up';
    }

    if (move.lessThanOrEqualTo(boundary.negated())) {
        return 'down';
    }

    return 'flat';
}

// Advisory only. True when every bucket with n ≥ REGIME_BUCKET_MIN_N has a mean
// R-multiple whose sign agrees with the aggregate mean. Buckets below the
// minimum n do not participate. NOT part of slotCGateOpen.
function computeRegimeRobustness(meanRMultiple: Decimal | null, buckets: IRegimeBucket[]): boolean {
    if (meanRMultiple === null) {
        return false;
    }

    const aggregateSign = signOf(meanRMultiple);

    for (const bucket of buckets) {
        if (bucket.n < REGIME_BUCKET_MIN_N || bucket.meanRMultiple === null) {
            continue;
        }

        if (signOf(new Decimal(bucket.meanRMultiple)) !== aggregateSign) {
            return false;
        }
    }

    return true;
}

function signOf(value: Decimal): number {
    if (value.greaterThan(0)) {
        return 1;
    }

    if (value.lessThan(0)) {
        return -1;
    }

    return 0;
}

function parseRiskPerTradeOrThrow(raw: string): Decimal {
    let value: Decimal;

    try {
        value = new Decimal(raw);
    } catch {
        throw new AnalysisValidationError('riskPerTradeUsdt', `must be a decimal string, got "${String(raw)}"`);
    }

    if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
        throw new AnalysisValidationError('riskPerTradeUsdt', `must be a positive finite decimal, got "${String(raw)}"`);
    }

    return value;
}
