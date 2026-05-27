// M12 W1 — `listPositions` query function.
//
// Filtered position listing with cursor pagination. Returns
// `IPaginated<IOpenPositionView | IClosedPositionView>` — the union is the
// existing shared shape. When `status` is unset, both states are returned
// and individual rows are mapped to whichever subtype matches their state at
// row time.
//
// Cursor format: opaque base64(JSON({id, createdAtMs})) via the local
// `CursorCodec` util (see `util/CursorCodec.ts` for the R5 reshuffle note).
// Cursor anchors at `(opened_at, positions_id)` desc — newer-first ordering
// with deterministic tie-breaks for same-millisecond rows.
//
// SQL is parameterized; range and limit are validated before SQL runs.

import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { ExitReasonEnum, IClosedPositionView, IOpenPositionView, IPaginated, PositionSideEnum, ProtectiveOrderTypeEnum } from '@bot/shared';
import { PositionSlotEnum, PositionStateEnum } from '@bot/shared';

import { DEFAULT_LIMIT, MAX_LIMIT, SYMBOL_MAX_LENGTH, SYMBOL_REGEX } from '../const/index.js';
import { decodeCursor, encodeCursor } from '../util/CursorCodec.js';
import { AnalysisValidationError, validateDateRangeOrThrow } from '../util/analysisValidation.js';

export type PositionListStatusFilter = 'open' | 'closed';

export interface IListPositionsParams {
    readonly symbol?: string;
    readonly versionId?: number;
    readonly status?: PositionListStatusFilter;
    readonly from: Date;
    readonly to: Date;
    readonly cursor?: string;
    readonly limit?: number;
}

interface IPositionRow {
    readonly positions_id: string;
    readonly symbol: string;
    readonly side: string;
    readonly state: string;
    readonly entry_price: string;
    readonly exit_price: string | null;
    readonly qty: string;
    readonly leverage: string;
    readonly realized_pnl: string | null;
    readonly opened_at: Date;
    readonly closed_at: Date | null;
    readonly exit_reason: string | null;
    readonly strategy_version_id: string;
    readonly protective_order_type: string;
    readonly stop_loss_price: string | null;
    readonly take_profit_price: string | null;
    readonly position_slot: string | null;
    readonly d_open_event_id: string | null;
}

export async function listPositions(ds: DataSource, params: IListPositionsParams): Promise<IPaginated<IOpenPositionView | IClosedPositionView>> {
    validateSymbolOrThrow(params.symbol);
    validateVersionIdOrThrow(params.versionId);
    validateDateRangeOrThrow(params.from, params.to);

    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor ?? null);
    const filterHash = computeFilterHash({ symbol: params.symbol, versionId: params.versionId, status: params.status });

    // why: a cursor is only valid for the filter set that issued it. If the
    // caller changes symbol/versionId/status mid-pagination, the (opened_at,
    // positions_id) anchor still applies and silently returns an inconsistent
    // slice. Encoding a stable filter fingerprint into the cursor lets us
    // reject the mismatch up-front. Legacy cursors with no fingerprint are
    // accepted (forward compat — the very next cursor we emit carries the
    // hash).
    if (cursor !== null && cursor.filterHash !== undefined && cursor.filterHash !== filterHash) {
        throw new AnalysisValidationError('cursor', 'cursor was issued for a different filter set; pagination requires constant filters');
    }

    const conditions: string[] = ['p.opened_at >= $1', 'p.opened_at < $2'];
    const bindings: unknown[] = [params.from.toISOString(), params.to.toISOString()];

    if (params.symbol !== undefined) {
        conditions.push(`p.symbol = $${bindings.length + 1}`);
        bindings.push(params.symbol);
    }

    if (params.versionId !== undefined) {
        conditions.push(`p.strategy_version_id = $${bindings.length + 1}`);
        bindings.push(params.versionId);
    }

    if (params.status === 'open') {
        conditions.push(`p.state = $${bindings.length + 1}`);
        bindings.push(PositionStateEnum.OPEN);
    } else if (params.status === 'closed') {
        conditions.push(`p.state = $${bindings.length + 1}`);
        bindings.push(PositionStateEnum.CLOSED);
    }

    if (cursor !== null) {
        // Page-after semantics: newer-first; "next page" returns rows whose
        // (opened_at, positions_id) tuple is strictly less than the cursor.
        // Tuple comparison handles same-ms ties deterministically.
        // why: bind the id as TEXT (not int / not Number()) so a future
        // BaseRepository UUID-PK widening (pre-M15 deferred item) does not
        // silently lose precision through Number's 2^53 ceiling. Cast to
        // bigint in SQL to preserve current numeric-PK behaviour; the cast
        // updates to ::uuid in lockstep with the PK widening migration.
        conditions.push(`(p.opened_at, p.positions_id) < ($${bindings.length + 1}::timestamptz, $${bindings.length + 2}::bigint)`);
        bindings.push(new Date(cursor.createdAtMs).toISOString());
        bindings.push(String(cursor.id));
    }

    // Fetch limit+1 so we know whether a next page exists without an extra
    // COUNT query.
    const fetchLimit = limit + 1;
    bindings.push(fetchLimit);

    const sql = `
        SELECT
            p.positions_id::text                AS positions_id,
            p.symbol                            AS symbol,
            p.side                              AS side,
            p.state                             AS state,
            p.entry_price::text                 AS entry_price,
            p.exit_price::text                  AS exit_price,
            p.qty::text                         AS qty,
            p.leverage::text                    AS leverage,
            p.realized_pnl::text                AS realized_pnl,
            p.opened_at                         AS opened_at,
            p.closed_at                         AS closed_at,
            p.exit_reason                       AS exit_reason,
            p.strategy_version_id::text         AS strategy_version_id,
            p.protective_order_type             AS protective_order_type,
            p.stop_loss_price::text             AS stop_loss_price,
            p.take_profit_price::text           AS take_profit_price,
            p.position_slot                     AS position_slot,
            d_open.event_id                     AS d_open_event_id
        FROM positions p
        LEFT JOIN LATERAL (
            SELECT event_id
            FROM decisions
            WHERE position_id = p.positions_id
            ORDER BY ts ASC
            LIMIT 1
        ) d_open ON true
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.opened_at DESC, p.positions_id DESC
        LIMIT $${bindings.length}
    `;

    const rows: IPositionRow[] = await ds.query(sql, bindings);
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;

    const items = pageRows.map(mapPositionRow);
    const lastRow = pageRows[pageRows.length - 1];
    // why: keep `positions_id` as the string pg returned (BIGINT arrives as
    // string from pg, and a future UUID widening will too) so cursors survive
    // ids > 2^53 without precision loss.
    const nextCursor =
        hasNext && lastRow !== undefined ? encodeCursor({ id: lastRow.positions_id, createdAtMs: new Date(lastRow.opened_at).getTime(), filterHash }) : null;

    return {
        items,
        nextCursor,
        pageSize: pageRows.length,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPositionRow(row: IPositionRow): IOpenPositionView | IClosedPositionView {
    if (row.state === PositionStateEnum.CLOSED) {
        return mapClosedRow(row);
    }

    return mapOpenRow(row);
}

function mapOpenRow(row: IPositionRow): IOpenPositionView {
    return {
        id: row.positions_id,
        symbol: row.symbol,
        side: row.side as PositionSideEnum,
        entryPrice: row.entry_price,
        // Mark price requires the live engine's price feed; analysis cannot
        // produce it. Fall back to the entry price (matches the engine's
        // own `mapOpenPosition` "no mark" branch). The MCP tool layer can
        // overlay an explicit current price if needed for an LLM prompt.
        currentPrice: row.entry_price,
        qty: row.qty,
        leverage: row.leverage,
        unrealizedPnlPriceUsd: '0',
        unrealizedPnlFundingUsd: null,
        openedAt: new Date(row.opened_at).toISOString(),
        slot: positionSlotToOrdinal(row.position_slot),
        strategyVersionId: row.strategy_version_id,
        // Real event_id from the earliest decision for this position (LEFT JOIN
        // LATERAL above). Null when no joining decision row exists — e.g. a
        // position adopted via reconciliation drift before any decision was
        // recorded. The shared `IOpenPositionView.eventId` contract permits
        // null since fix wave 4a.
        eventId: row.d_open_event_id ?? null,
        state: row.state as PositionStateEnum,
        protectiveOrderType: row.protective_order_type as ProtectiveOrderTypeEnum,
        slPrice: row.stop_loss_price,
        tpPrice: row.take_profit_price,
    };
}

function mapClosedRow(row: IPositionRow): IClosedPositionView {
    return {
        id: row.positions_id,
        symbol: row.symbol,
        side: row.side as PositionSideEnum,
        entryPrice: row.entry_price,
        exitPrice: row.exit_price,
        qty: row.qty,
        leverage: row.leverage,
        realizedPnlUsd: row.realized_pnl,
        openedAt: new Date(row.opened_at).toISOString(),
        closedAt: new Date(row.closed_at ?? row.opened_at).toISOString(),
        exitReason: (row.exit_reason ?? 'unknown') as ExitReasonEnum,
        strategyVersionId: row.strategy_version_id,
    };
}

function positionSlotToOrdinal(slot: string | null): number {
    if (slot === PositionSlotEnum.A) {
        return 1;
    }

    if (slot === PositionSlotEnum.B) {
        return 2;
    }

    if (slot === PositionSlotEnum.C) {
        return 3;
    }

    return 0;
}

// Stable SHA-256 hex prefix over the normalized filter set. `undefined`
// fields collapse to `null` and keys are emitted in sorted order so the hash
// is stable across call sites and JS engine iteration quirks. 16 hex chars
// (64 bits) is plenty to detect accidental filter drift while keeping the
// cursor payload compact.
interface IFilterSet {
    readonly symbol?: string;
    readonly versionId?: number;
    readonly status?: PositionListStatusFilter;
}

function computeFilterHash(filters: IFilterSet): string {
    const normalised = {
        status: filters.status ?? null,
        symbol: filters.symbol ?? null,
        versionId: filters.versionId ?? null,
    };
    // Sort keys explicitly so the JSON shape is identical regardless of
    // input key order or future field additions accidentally reordering.
    const sortedKeys = Object.keys(normalised).sort();
    const ordered: Record<string, unknown> = {};

    for (const key of sortedKeys) {
        ordered[key] = (normalised as Record<string, unknown>)[key];
    }

    return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex').slice(0, 16);
}

function validateSymbolOrThrow(symbol: string | undefined): void {
    if (symbol === undefined) {
        return;
    }

    if (symbol.length === 0 || symbol.length > SYMBOL_MAX_LENGTH) {
        throw new AnalysisValidationError('symbol', `must be a non-empty string ≤${SYMBOL_MAX_LENGTH} chars`);
    }

    // Symbols are alphanumeric futures pairs. The engine stores them in CCXT
    // notation (`BASE/QUOTE:SETTLEMENT`, e.g. `BTC/USDT:USDT`); legacy plain
    // form (`BTCUSDT`) is also accepted for any older row. The `/` and `:`
    // characters are safe under parameterized binding; the regex is
    // defence-in-depth against SQL-injection / wildcard attempts. The single
    // authoritative pattern lives in `@bot/shared` so the MCP DTO layer and
    // this analysis-layer guard cannot drift apart.
    if (!SYMBOL_REGEX.test(symbol)) {
        throw new AnalysisValidationError('symbol', `must match CCXT or legacy symbol form, got "${symbol}"`);
    }
}

function validateVersionIdOrThrow(versionId: number | undefined): void {
    if (versionId === undefined) {
        return;
    }

    if (!Number.isInteger(versionId) || versionId <= 0 || versionId > Number.MAX_SAFE_INTEGER) {
        throw new AnalysisValidationError('versionId', `must be a positive integer ≤Number.MAX_SAFE_INTEGER, got ${String(versionId)}`);
    }
}

function clampLimit(rawLimit: number | undefined): number {
    if (rawLimit === undefined) {
        return DEFAULT_LIMIT;
    }

    if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
        throw new AnalysisValidationError('limit', `must be a positive integer, got ${String(rawLimit)}`);
    }

    if (rawLimit > MAX_LIMIT) {
        throw new AnalysisValidationError('limit', `must be ≤${MAX_LIMIT}, got ${rawLimit}`);
    }

    return rawLimit;
}
