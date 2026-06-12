import { AuthScopeEnum, IClosedPositionView, IOpenPositionView, IPaginated, IPositionDetailView } from '@bot/shared';
import { Controller, Get, NotFoundException, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';

import { AuthGuard, RequiredScopes } from '../../auth/AuthGuard';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../const/readApiConsts';
import { mapClosedPosition, mapOpenPosition, mapPositionDetail } from '../mappers/readApiMappers';
import { NoStoreCacheInterceptor } from '../interceptor/NoStoreCacheInterceptor';
import { CursorCodec } from '../pagination/CursorCodec';

// M9 W4 (ADR 0022 §2.2). Read API positions endpoints.
//
//   GET /v1/positions/open       → IOpenPositionView[]
//   GET /v1/positions/closed     → IPaginated<IClosedPositionView>
//   GET /v1/positions/:id        → IPositionDetailView
//
// All routes layer `AuthGuard` + `@RequiredScopes(READ)`. The mappers handle
// least-disclosure (no entity ever crosses the wire). `currentPrice` on the
// OPEN view falls back to `entryPrice` when no mark-price feed has been
// injected — the live mark is a M10 follow-up wire (the dashboard already has
// a price stream via WS in W5).

@Controller(`v1/positions`)
@UseGuards(AuthGuard)
@UseInterceptors(NoStoreCacheInterceptor)
@RequiredScopes(AuthScopeEnum.READ)
export class PositionsController {
    constructor(
        private readonly positions: PositionRepository,
        private readonly cursors: CursorCodec,
    ) {}

    @Get('open')
    async listOpen(): Promise<IOpenPositionView[]> {
        // M31 R1 (HIGH): live-risk view only (qty > 0 AND non-terminal) — a qty=0 zombie row is
        // lifecycle residue, not a live position, and must not surface on /v1/positions/open.
        const rows = await this.positions.findLiveRisk();

        return rows.map((position) => mapOpenPosition({ position, markPrice: null }));
    }

    @Get('closed')
    async listClosed(@Query('cursor') rawCursor?: string, @Query('pageSize') rawPageSize?: string): Promise<IPaginated<IClosedPositionView>> {
        const pageSize = clampPageSize(rawPageSize);
        const decoded = this.cursors.decode(rawCursor);
        // Position ids are SERIAL numbers; a forged string-id cursor is treated
        // as "no cursor" (forgiving, matches ADR 0022 §2.5).
        const cursorTuple = decoded === null || typeof decoded.id !== 'number' ? null : { closedAt: decoded.ts, id: decoded.id };

        const rows = await this.positions.findClosedPage(cursorTuple, pageSize);
        const items = rows.map(mapClosedPosition);

        // M9 R2 wave B (Q8): repository.findClosedPage now guards
        // `closed_at IS NOT NULL`, so `last.closedAt` is non-null by construction
        // for any row we received. We keep an explicit guard rather than `!` so
        // an out-of-band write that ever bypasses the guard surfaces as a
        // deterministic 500 instead of an encoded NaN cursor.
        const last = rows.length === 0 ? null : rows[rows.length - 1];

        let nextCursor: string | null = null;

        if (last !== null && rows.length >= pageSize) {
            if (last.closedAt === null || last.closedAt === undefined) {
                throw new Error(`Read-API invariant: CLOSED position ${last.id} has null closedAt`);
            }

            nextCursor = this.cursors.encode({ id: last.id, ts: last.closedAt });
        }

        return { items, nextCursor, pageSize };
    }

    @Get(':id')
    async getDetail(@Param('id') rawId: string): Promise<IPositionDetailView> {
        const id = Number.parseInt(rawId, 10);

        if (!Number.isFinite(id) || id <= 0) {
            // 404 (not 400) per ADR 0022 §2.2 "not found / wrong tenant" — never
            // distinguishes between malformed id and missing row, so a probe can
            // not enumerate valid ids.
            throw new NotFoundException({ error: 'NOT_FOUND', reason: 'position not found' });
        }

        const position = await this.positions.findById(id);

        if (position === null) {
            throw new NotFoundException({ error: 'NOT_FOUND', reason: 'position not found' });
        }

        return mapPositionDetail({ position, markPrice: null, clientOrderId: deriveClientOrderId(position.id) });
    }
}

// Pre-M5 positions row → `clientOrderId` lookup. The transactions table carries
// the authoritative client-order-id but joining for the detail view costs an
// extra query per call; the read API stays single-query and surfaces a stable
// derived breadcrumb. M10 dashboards can drill into /v1/decisions for the full
// audit thread. (M9 W4 NOTE — when M11 surfaces the linkage via a denormalised
// column on PositionEntity, swap this for `position.clientOrderId`.)
function deriveClientOrderId(positionId: number): string {
    return `position-${positionId}`;
}

function clampPageSize(raw: string | undefined): number {
    if (raw === undefined || raw.length === 0) {
        return PAGE_SIZE_DEFAULT;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return PAGE_SIZE_DEFAULT;
    }

    if (parsed > PAGE_SIZE_MAX) {
        return PAGE_SIZE_MAX;
    }

    return parsed;
}
