// M12 W1 — `getDecisions` query function.
//
// Returns `IDecisionView[]` for a symbol over a window, with the
// `market_snapshot` JSONB selectable. Hard-capped at 10_000 rows inside the
// function (extra safety beyond Postgres' role-level `statement_timeout`)
// per ADR 0034 §2.4. Anything wanting more than 10k decisions in one call
// should paginate via `listPositions`-style cursors (deferred — current MCP
// tool surface treats decisions as a bounded debugging slice).
//
// `includeSnapshot=false` (default) skips the `market_snapshot` JSONB column
// entirely so the response stays small for typical agent prompts. When the
// agent explicitly opts in we project it, but it never appears on the
// `IDecisionView` shape — it's a side-channel for caller-side analysis.
//
// SQL is parameterized. Symbol charset is validated as in `listPositions`.

import { DataSource } from 'typeorm';
import type { FlowTypeEnum, IDecisionView, SignalActionEnum } from '@bot/shared';
import { mapDecisionOutcome } from '@bot/shared';

import { DECISIONS_ROW_CAP, SYMBOL_MAX_LENGTH, SYMBOL_REGEX } from '../const/index.js';
import { AnalysisValidationError, validateDateRangeOrThrow } from '../util/analysisValidation.js';

export interface IGetDecisionsParams {
    readonly symbol: string;
    readonly from: Date;
    readonly to: Date;
    readonly includeSnapshot?: boolean;
}

/**
 * M12 W4 fix wave 4a decision: `IGetDecisionsResult` remains in analysis (not promoted to shared)
 * because the `snapshots` field is implementation-specific (optional market-snapshot sidecar).
 * Only analysis + MCP packages consume this shape; the dashboard never calls getDecisions directly.
 */
export interface IGetDecisionsResult {
    readonly items: IDecisionView[];
    /** Per-row snapshots, indexed by decision id, populated only when `includeSnapshot=true`. */
    readonly snapshots: Record<string, unknown> | null;
}

interface IDecisionRowWithoutSnapshot {
    readonly decisions_id: string;
    readonly symbol: string;
    readonly ts: Date;
    readonly event_id: string;
    readonly signal_type: string;
    readonly action: string;
    readonly gate_allowed: boolean | null;
    readonly reason: string | null;
    readonly strategy_version_id: string;
    readonly position_id: string | null;
    readonly market_snapshot: unknown | null;
}

export async function getDecisions(ds: DataSource, params: IGetDecisionsParams): Promise<IGetDecisionsResult> {
    validateSymbolOrThrow(params.symbol);
    validateDateRangeOrThrow(params.from, params.to);

    const includeSnapshot = params.includeSnapshot === true;
    const fetchLimit = DECISIONS_ROW_CAP + 1; // +1 so we can detect truncation.

    const sql = `
        SELECT
            d.decisions_id::text            AS decisions_id,
            d.symbol                        AS symbol,
            d.ts                            AS ts,
            d.event_id                      AS event_id,
            d.signal_type                   AS signal_type,
            d.action                        AS action,
            d.gate_allowed                  AS gate_allowed,
            d.reason                        AS reason,
            d.strategy_version_id::text     AS strategy_version_id,
            d.position_id::text             AS position_id,
            ${includeSnapshot ? 'd.market_snapshot' : 'NULL::jsonb'} AS market_snapshot
        FROM decisions d
        WHERE d.symbol = $1
          AND d.ts >= $2
          AND d.ts <  $3
        ORDER BY d.ts ASC, d.decisions_id ASC
        LIMIT $4
    `;

    const rows: IDecisionRowWithoutSnapshot[] = await ds.query(sql, [params.symbol, params.from.toISOString(), params.to.toISOString(), fetchLimit]);

    // why: ADR 0034 §2.4 mandates pagination over silent truncation — the agent
    // needs a hard error to narrow the window, otherwise it would consume a
    // truncated slice and reason on partial data.
    if (rows.length > DECISIONS_ROW_CAP) {
        throw new AnalysisValidationError('range', `range produced >${DECISIONS_ROW_CAP} decisions; narrow the window`);
    }

    const items = rows.map(mapRowToDecisionView);
    const snapshots = includeSnapshot ? Object.fromEntries(rows.map((row) => [row.decisions_id, row.market_snapshot])) : null;

    return { items, snapshots };
}

function mapRowToDecisionView(row: IDecisionRowWithoutSnapshot): IDecisionView {
    const positionId = row.position_id;

    return {
        id: row.decisions_id,
        occurredAt: new Date(row.ts).toISOString(),
        symbol: row.symbol,
        action: row.action as SignalActionEnum,
        outcome: mapDecisionOutcome({
            action: row.action,
            gateAllowed: row.gate_allowed,
            positionId,
        }),
        flowType: row.signal_type as FlowTypeEnum,
        signalScore: extractSignalScore(row.market_snapshot),
        reason: row.reason,
        strategyVersionId: row.strategy_version_id,
        eventId: row.event_id,
        positionId,
    };
}

function extractSignalScore(snapshot: unknown): string | null {
    // Mirrors the engine read-API's `extractSignalScore` shape: the score
    // lives inside `market_snapshot.signalScore` when persisted. The shape
    // is not part of the typed `IMarketSnapshot` contract, so we read it
    // defensively and surface `null` on absent / non-numeric values.
    if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
        return null;
    }

    const raw = (snapshot as Record<string, unknown>)['signalScore'];

    if (typeof raw === 'string' && raw.length > 0) {
        return raw;
    }

    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw.toString();
    }

    return null;
}

function validateSymbolOrThrow(symbol: string): void {
    if (typeof symbol !== 'string' || symbol.length === 0 || symbol.length > SYMBOL_MAX_LENGTH) {
        throw new AnalysisValidationError('symbol', `must be a non-empty string ≤${SYMBOL_MAX_LENGTH} chars`);
    }

    // Accepts CCXT futures notation (`BASE/QUOTE:SETTLEMENT`, the engine's
    // actual storage form) and legacy plain-uppercase form. The single
    // authoritative `SYMBOL_REGEX` lives in `@bot/shared` so the MCP DTO
    // layer and this analysis-layer guard cannot drift apart.
    if (!SYMBOL_REGEX.test(symbol)) {
        throw new AnalysisValidationError('symbol', `must match CCXT or legacy symbol form, got "${symbol}"`);
    }
}
