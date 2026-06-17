// M12 W1 — `getPerformance` query function.
//
// Aggregates closed positions over a date window for a single strategy
// version into the shared `IPerformanceByVersionView` shape. Mirrors the
// engine's MetricsController projection (winRate semantics, money-string
// formatting) row-for-row off the same source rows.
//
// **M37 W1 (D1.1/D1.2) — active-vs-shadow precedence.** A strategy version is
// either the live `active` version (its realized trades live in `positions`) or
// a `shadow` version (its counterfactual fills live in `shadow_decisions`). The
// active version can ALSO carry `shadow_decisions` rows for a window it was
// concurrently shadowed (ADR 0029 M37 amendment) — to avoid double-counting,
// this function reads `positions` for the active version and `shadow_decisions`
// for shadow versions, never both, keyed off `strategy_versions.status`. A
// shadow trade counts as "traded" only when its `simulated_fill` is non-hollow
// (`missed=false AND exitPrice IS NOT NULL`). PnL is computed from the fill JSONB
// using `trade_side` and `qty` to sign the gross delta. Note: the D1.6 fill
// simulator uses a causal same-bar approximation (entry and exit at bar close),
// so gross PnL is ~0 for force_close rows — the honest result until a retroactive
// replay job provides real forward-bar fills.
//
// **Window-semantics divergence vs the engine's MetricsController.** This
// surface is the *historical-window* form: callers pass an explicit
// `[from, to)` half-open range and the SQL filters
// `closed_at >= from AND closed_at < to`. The engine's
// `/v1/performance/by-version` is the *trailing-window* form: callers pass
// `windowDays` and the SQL filters `closed_at >= since` with no upper cap.
// The two surfaces are intentionally NOT numerically identical when the
// caller's `to` is in the past — the engine surface always includes "now-ish"
// closures, this surface respects the explicit upper bound. When a caller
// wants engine parity for a "last N days" view, it should pass
// `to = new Date()` and accept that any closures landing between the SQL
// snapshot and the response render at the engine surface but not here.
//
// Range/row-cap policy (ADR 0034 §2.4): this layer enforces *malformed-input*
// rejection only — reversed/future/NaN ranges throw `AnalysisValidationError`.
// The ≤90d soft / ≤365d hard cap (`acknowledgedLargeRange`) is enforced at
// the MCP tool layer in W4, not here — backtests, CI jobs, and operator
// scripts may legitimately need uncapped windows over closed data.
//
// SQL is parameterized via positional bindings (`$1`, `$2`, `$3`). String
// interpolation into SQL is banned by the boundary lint (R0) and by the
// dev-qa-cycle SQL-injection invariant.

import { Decimal } from 'decimal.js';
import { DataSource } from 'typeorm';
import type { IPerformanceByVersionView } from '@bot/shared';

import { MS_PER_DAY, STRATEGY_STATUS_ACTIVE } from '../const/index.js';
import { AnalysisValidationError, validateDateRangeOrThrow } from '../util/analysisValidation.js';

export interface IGetPerformanceParams {
    readonly versionId: number;
    readonly from: Date;
    readonly to: Date;
}

interface IPerformanceRow {
    readonly trade_count: string;
    readonly win_count: string;
    readonly net_pnl_usd: string | null;
    readonly force_close_fraction: string | null;
    readonly miss_rate: string | null;
    readonly label: string | null;
    readonly status: string | null;
}

const PERFORMANCE_SQL = `
    SELECT
        COUNT(p.positions_id)::text                                                    AS trade_count,
        COALESCE(SUM(CASE WHEN p.realized_pnl > 0 THEN 1 ELSE 0 END), 0)::text         AS win_count,
        COALESCE(SUM(p.realized_pnl), 0)::text                                         AS net_pnl_usd,
        NULL::text                                                                    AS force_close_fraction,
        NULL::text                                                                    AS miss_rate,
        MAX(sv.name || '@v' || sv.version::text)                                       AS label,
        MAX(sv.status)                                                                 AS status
    FROM positions p
    INNER JOIN strategy_versions sv ON sv.strategy_versions_id = p.strategy_version_id
    WHERE p.strategy_version_id = $1
      AND p.state = 'closed'
      AND p.closed_at >= $2
      AND p.closed_at <  $3
`;

// M37 W1 (D1.1/D1.2) — shadow-version aggregation. A shadow version has no
// `positions` rows; its counterfactual fills live in `shadow_decisions`. A row
// counts as "traded" only when its `simulated_fill` is non-hollow:
// `missed=false AND exitPrice IS NOT NULL`. PnL is computed from the fill JSONB:
// (exitPrice - entryPrice) × qty for LONG; (entryPrice - exitPrice) × qty for SHORT.
// The window uses `created_at` (the shadow row's recording time) — shadow rows have no
// `closed_at`; the simulated close timestamp lives inside the JSONB and is not the
// windowing key for this decision-recording surface.
// Note: force_close exits at bar close (≈ entry price), so gross PnL is ~0 for most
// rows in live evaluation where no post-entry SL/TP breach occurs. This is the honest
// result given the architectural constraint (next bar unavailable at evaluation time).
const SHADOW_PERFORMANCE_SQL = `
    SELECT
        COUNT(*) FILTER (
            WHERE (sd.simulated_fill->>'missed')::boolean = false
              AND sd.simulated_fill->>'exitPrice' IS NOT NULL
              AND sd.simulated_fill->>'entryPrice' IS NOT NULL
              AND sd.simulated_fill->>'entryPrice' != '0'
        )::text                                                                        AS trade_count,
        COALESCE(SUM(CASE
            WHEN (sd.simulated_fill->>'missed')::boolean = false
             AND sd.simulated_fill->>'exitPrice' IS NOT NULL
             AND sd.simulated_fill->>'entryPrice' IS NOT NULL
             AND sd.simulated_fill->>'entryPrice' != '0'
             AND (
                CASE sd.trade_side
                    WHEN 'long'  THEN (CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC)
                                       - CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC))
                                      * sd.qty::NUMERIC
                    WHEN 'short' THEN (CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC)
                                       - CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC))
                                      * sd.qty::NUMERIC
                    ELSE 0
                END
                - COALESCE(CAST(sd.simulated_fill->>'feeUsdtEntry' AS NUMERIC), 0)
                - COALESCE(CAST(sd.simulated_fill->>'feeUsdtExit' AS NUMERIC), 0)
             ) > 0
            THEN 1 ELSE 0
        END), 0)::text                                                                 AS win_count,
        COALESCE(SUM(CASE
            WHEN (sd.simulated_fill->>'missed')::boolean = false
             AND sd.simulated_fill->>'exitPrice' IS NOT NULL
             AND sd.simulated_fill->>'entryPrice' IS NOT NULL
             AND sd.simulated_fill->>'entryPrice' != '0'
            THEN
                CASE sd.trade_side
                    WHEN 'long'  THEN (CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC)
                                       - CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC))
                                      * sd.qty::NUMERIC
                    WHEN 'short' THEN (CAST(sd.simulated_fill->>'entryPrice' AS NUMERIC)
                                       - CAST(sd.simulated_fill->>'exitPrice' AS NUMERIC))
                                      * sd.qty::NUMERIC
                    ELSE 0
                END
                - COALESCE(CAST(sd.simulated_fill->>'feeUsdtEntry' AS NUMERIC), 0)
                - COALESCE(CAST(sd.simulated_fill->>'feeUsdtExit' AS NUMERIC), 0)
            ELSE 0
        END), 0)::text                                                                 AS net_pnl_usd,
        (
            COALESCE(SUM(CASE
                WHEN (sd.simulated_fill->>'missed')::boolean = false
                 AND sd.simulated_fill->>'exitPrice' IS NOT NULL
                 AND sd.simulated_fill->>'entryPrice' IS NOT NULL
                 AND sd.simulated_fill->>'entryPrice' != '0'
                 AND sd.simulated_fill->>'closeReason' = 'force_close'
                THEN 1 ELSE 0
            END), 0)::NUMERIC
            / NULLIF(COUNT(*) FILTER (
                WHERE (sd.simulated_fill->>'missed')::boolean = false
                  AND sd.simulated_fill->>'exitPrice' IS NOT NULL
                  AND sd.simulated_fill->>'entryPrice' IS NOT NULL
                  AND sd.simulated_fill->>'entryPrice' != '0'
            ), 0)::NUMERIC
        )::NUMERIC(10,8)::text                                                        AS force_close_fraction,
        (
            (COUNT(*) FILTER (WHERE (sd.simulated_fill->>'missed')::boolean = true))::NUMERIC
            / NULLIF(COUNT(*), 0)::NUMERIC
        )::NUMERIC(10,8)::text                                                        AS miss_rate,
        MAX(sv.name || '@v' || sv.version::text)                                       AS label,
        MAX(sv.status)                                                                 AS status
    FROM shadow_decisions sd
    INNER JOIN strategy_versions sv ON sv.strategy_versions_id = sd.strategy_version_id
    WHERE sd.strategy_version_id = $1
      AND sd.action = 'open'
      AND sd.created_at >= $2
      AND sd.created_at <  $3
`;

// why: the aggregation SQL above INNER JOINs through `positions`, so a window
// with zero closed positions yields a `label=null, status=null` row even for a
// version that genuinely exists. Without this fallback the surface emitted
// `unknown@v<id>` for a real active version, which an LLM agent reads as "the
// version doesn't exist." A 1-row probe against `strategy_versions` resolves
// the canonical label/status when the aggregation is empty, and surfaces a
// validation error when the version truly does not exist. M37 W1 reuses this
// probe to resolve the version's `status` BEFORE the aggregation so the active
// (`positions`) vs shadow (`shadow_decisions`) path can be chosen.
const VERSION_LOOKUP_SQL = `
    SELECT
        sv.name || '@v' || sv.version::text AS label,
        sv.status                            AS status
    FROM strategy_versions sv
    WHERE sv.strategy_versions_id = $1
    LIMIT 1
`;

interface IVersionLookupRow {
    readonly label: string;
    readonly status: string;
}

export async function getPerformance(ds: DataSource, params: IGetPerformanceParams): Promise<IPerformanceByVersionView> {
    validateVersionIdOrThrow(params.versionId);
    validateDateRangeOrThrow(params.from, params.to);

    // M37 W1: resolve the version's canonical label + status first. `status`
    // selects the aggregation source — `positions` for the active version,
    // `shadow_decisions` for shadow versions — so no version is double-counted.
    // Throws when the version genuinely does not exist.
    const resolved = await lookupVersionOrThrow(ds, params.versionId);
    const label = resolved.label;
    const status = resolved.status;

    const aggregation = await aggregatePerformance(ds, params, status);
    const tradeCount = aggregation.tradeCount;
    const winCount = aggregation.winCount;
    // why: wrap raw `::text`-cast money strings through shared decimalMath so
    // the surface shape matches engine's `Money.toFixed()` exit point in
    // `mapPerformanceByVersion`. Same numeric value, identical string form.
    const netPnlUsd = formatMoneyString(aggregation.netPnlUsd);

    const windowDays = computeWindowDays(params.from, params.to);
    const winRate = tradeCount > 0 ? (winCount / tradeCount).toFixed(6) : null;

    // Drawdown / Sharpe / Sortino / expectancyPerUnitRisk all require a
    // per-trade equity series and OOS bootstrap; the M7/M8 BacktestReport
    // pipeline owns those numbers (ADR 0017/0018). The MCP analysis surface
    // returns `null` here so callers fall back to the comparison-report
    // artefact, matching ADR 0022 §2.3.1.
    return {
        strategyVersionId: String(params.versionId),
        label,
        status,
        windowDays,
        tradeCount,
        winRate,
        netPnlUsd,
        maxDrawdownUsd: null,
        sharpe: null,
        sortino: null,
        expectancyPerUnitRisk: null,
        forceCloseFraction: aggregation.forceCloseFraction,
        missRate: aggregation.missRate,
    };
}

interface IAggregatedPerformance {
    readonly tradeCount: number;
    readonly winCount: number;
    readonly netPnlUsd: string;
    readonly forceCloseFraction: string | null;
    readonly missRate: string | null;
}

// Selects the aggregation source by version status: the active version's
// realized trades from `positions`; a shadow version's counterfactual fills
// from `shadow_decisions`. This is the active-vs-shadow precedence rule
// (M37 W1 D1.2) — a version is read from exactly one stream, never both.
async function aggregatePerformance(ds: DataSource, params: IGetPerformanceParams, status: string): Promise<IAggregatedPerformance> {
    const sql = status === STRATEGY_STATUS_ACTIVE ? PERFORMANCE_SQL : SHADOW_PERFORMANCE_SQL;
    const rows: IPerformanceRow[] = await ds.query(sql, [params.versionId, params.from.toISOString(), params.to.toISOString()]);
    const row = rows[0];

    return {
        tradeCount: row !== undefined ? Number(row.trade_count) : 0,
        winCount: row !== undefined ? Number(row.win_count) : 0,
        netPnlUsd: row !== undefined && row.net_pnl_usd !== null ? row.net_pnl_usd : '0',
        forceCloseFraction: row !== undefined ? (row.force_close_fraction ?? null) : null,
        missRate: row !== undefined ? (row.miss_rate ?? null) : null,
    };
}

async function lookupVersionOrThrow(ds: DataSource, versionId: number): Promise<IVersionLookupRow> {
    const rows: IVersionLookupRow[] = await ds.query(VERSION_LOOKUP_SQL, [versionId]);
    const found = rows[0];

    if (found === undefined) {
        throw new AnalysisValidationError('versionId', `no such version: ${versionId}`);
    }

    return found;
}

function validateVersionIdOrThrow(versionId: number): void {
    if (!Number.isInteger(versionId) || versionId <= 0 || versionId > Number.MAX_SAFE_INTEGER) {
        throw new AnalysisValidationError('versionId', `must be a positive integer ≤Number.MAX_SAFE_INTEGER, got ${String(versionId)}`);
    }
}

// Re-parses a raw money string through `decimal.js` and emits the canonical
// `.toFixed()` shape (matches engine's `Money.toFixed()` surface in
// `apps/engine/src/read-api/mappers/readApiMappers.ts`). Exported so sibling
// query modules (compareVersions) share the same wrapper.
//
// Note: `@bot/shared/util/decimalMath` exposes `parseDecimal`/`formatDecimal`
// which use the same underlying `decimal.js` value type. We import directly
// from `decimal.js` here (a first-party `@bot/analysis` dependency) because
// the analysis Jest moduleNameMapper resolves `@bot/shared` to its source
// `index.ts`, which transitively re-exports through compiled `.js` artifacts
// in `packages/shared/src/`; value-imports from `@bot/shared` therefore fail
// to load under ts-jest. Direct decimal.js usage produces the SAME string
// surface (decimal.js `.toFixed()` is identical across instances).
export function formatMoneyString(raw: string): string {
    return new Decimal(raw).toFixed();
}

function computeWindowDays(from: Date, to: Date): number {
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_DAY));
}
