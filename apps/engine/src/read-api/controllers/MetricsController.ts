import { AuthScopeEnum, IAccountEquityView, IDecisionView, IPaginated, IPerformanceByVersionView, IRiskStateView } from '@bot/shared';
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';

import { AuthGuard, RequiredScopes } from '../../auth/AuthGuard';
import { MS_PER_DAY } from '../../common/const/timeConsts';
import { AccountSnapshotRepository } from '../../position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { RiskStateRepository } from '../../risk/repository/RiskStateRepository';
import { DecisionRepository } from '../../strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../strategy/repository/StrategyVersionRepository';
import { NoStoreCacheInterceptor } from '../interceptor/NoStoreCacheInterceptor';
import { mapAccountEquity, mapDecision, mapPerformanceByVersion, mapRiskState } from '../mappers/readApiMappers';
import { CursorCodec } from '../pagination/CursorCodec';

// M9 W4 (ADR 0022 §2.2). Aggregated read API endpoints — decisions, account
// equity, risk state, per-version performance. Bundled into one controller
// because each is a thin repo→mapper hop; the alternative is three near-empty
// controller files that complicate routing tree review.

const DECISIONS_PAGE_SIZE_DEFAULT = 50;
const DECISIONS_PAGE_SIZE_MAX = 200;

const PERFORMANCE_WINDOW_DAYS_DEFAULT = 30;
const PERFORMANCE_WINDOW_DAYS_MAX = 365;

@Controller('v1')
@UseGuards(AuthGuard)
@UseInterceptors(NoStoreCacheInterceptor)
@RequiredScopes(AuthScopeEnum.READ)
export class MetricsController {
    constructor(
        private readonly decisions: DecisionRepository,
        private readonly positions: PositionRepository,
        private readonly snapshots: AccountSnapshotRepository,
        private readonly riskStates: RiskStateRepository,
        private readonly strategyVersions: StrategyVersionRepository,
        private readonly cursors: CursorCodec,
    ) {}

    @Get('decisions')
    async listDecisions(
        @Query('cursor') rawCursor?: string,
        @Query('pageSize') rawPageSize?: string,
        @Query('symbol') symbol?: string,
        @Query('flowType') flowType?: string,
    ): Promise<IPaginated<IDecisionView>> {
        const pageSize = clampPageSize(rawPageSize);
        const decoded = this.cursors.decode(rawCursor);
        // Decision ids are SERIAL numbers; reject string-id cursors as "no cursor".
        const cursorTuple = decoded === null || typeof decoded.id !== 'number' ? null : { ts: decoded.ts, id: decoded.id };

        const rows = await this.decisions.findPage(cursorTuple, pageSize, {
            symbol: normalizeFilter(symbol),
            flowType: normalizeFilter(flowType),
        });

        const items = rows.map(mapDecision);
        const last = rows.length === 0 ? null : rows[rows.length - 1];
        const nextCursor = last === null || rows.length < pageSize ? null : this.cursors.encode({ id: last.id, ts: last.ts });

        return { items, nextCursor, pageSize };
    }

    @Get('account/equity')
    async getAccountEquity(): Promise<IAccountEquityView> {
        const latest = await this.snapshots.findLatest();

        return mapAccountEquity(latest);
    }

    @Get('risk/state')
    async getRiskState(): Promise<IRiskStateView> {
        const today = utcDateString(new Date());
        const state = await this.riskStates.findByDate(today);

        return mapRiskState(state, today);
    }

    @Get('performance/by-version')
    async getPerformanceByVersion(@Query('windowDays') rawWindow?: string): Promise<IPerformanceByVersionView[]> {
        const windowDays = clampWindow(rawWindow);
        // M9 R2 wave B (Q9): floor `now` to UTC midnight before subtracting the
        // window so the sample composition is stable across a UTC day rather
        // than drifting hour-by-hour with wall-clock. Two requests in the same
        // UTC day return the same `since` boundary, which keeps cached metric
        // panels and back-to-back operator refreshes coherent.
        const todayUtcMidnight = new Date(Date.now());
        todayUtcMidnight.setUTCHours(0, 0, 0, 0);
        const since = new Date(todayUtcMidnight.getTime() - windowDays * MS_PER_DAY);

        const rows = await this.positions.aggregatePerformanceByVersion(since);

        if (rows.length === 0) {
            return [];
        }

        // Hydrate strategy version metadata once per request — typical row count is
        // 4 (v0–v3) so a per-row findById is acceptable; if this grows past ~20 we
        // promote to `findByIds` on the repository.
        const enriched: IPerformanceByVersionView[] = [];

        for (const row of rows) {
            const version = await this.strategyVersions.findById(row.strategyVersionId);

            if (version === null) {
                // A row references a version that has been deleted — skip silently
                // rather than poison the response. The aggregation source is the
                // positions table and rows survive a version-row deletion if the
                // FK action is RESTRICT (it is, per StrategyVersionEntity), so
                // hitting this branch indicates an out-of-band cleanup.
                continue;
            }

            enriched.push(mapPerformanceByVersion(row, version, windowDays));
        }

        return enriched;
    }
}

function normalizeFilter(raw: string | undefined): string | undefined {
    if (raw === undefined || raw.length === 0) {
        return undefined;
    }

    return raw;
}

function clampPageSize(raw: string | undefined): number {
    if (raw === undefined || raw.length === 0) {
        return DECISIONS_PAGE_SIZE_DEFAULT;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DECISIONS_PAGE_SIZE_DEFAULT;
    }

    if (parsed > DECISIONS_PAGE_SIZE_MAX) {
        return DECISIONS_PAGE_SIZE_MAX;
    }

    return parsed;
}

function clampWindow(raw: string | undefined): number {
    if (raw === undefined || raw.length === 0) {
        return PERFORMANCE_WINDOW_DAYS_DEFAULT;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return PERFORMANCE_WINDOW_DAYS_DEFAULT;
    }

    if (parsed > PERFORMANCE_WINDOW_DAYS_MAX) {
        return PERFORMANCE_WINDOW_DAYS_MAX;
    }

    return parsed;
}

function utcDateString(now: Date): string {
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = now.getUTCDate().toString().padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
}
