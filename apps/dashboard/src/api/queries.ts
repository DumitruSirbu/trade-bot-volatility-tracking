import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
    READ_API_PATHS,
    type IAccountEquityView,
    type IClosedPositionView,
    type IDailyPerformanceRow,
    type IDecisionView,
    type IOpenPositionView,
    type IPaginated,
    type IPerformanceByVersionView,
    type IRiskStateView,
    type IShadowPerformanceSummary,
} from '@bot/shared';

import { apiClient } from '@/api/apiClient';
import { useAuth } from '@/auth/AuthProvider';

// Polling cadences (ms). Hard-coded as named constants per W2 brief.
// W3 will swap polling for WS-driven cache merges; until then these intervals
// dominate the apparent latency of every view.
export const POLL_INTERVAL_POSITIONS_MS = 5_000;
export const POLL_INTERVAL_DECISIONS_MS = 5_000;
export const POLL_INTERVAL_ACCOUNT_MS = 10_000;
export const POLL_INTERVAL_RISK_MS = 10_000;
export const POLL_INTERVAL_PERFORMANCE_MS = 10_000;

// staleTime sits just below the polling interval so the scheduled refetch
// remains authoritative; manual refetches after a window-focus etc. still
// dedupe within the same tick.
const STALE_GUTTER_MS = 1_000;

// Cursor-paginated reads (closed positions, deeper decision pages) do not poll
// — keep them fresh for a minute so a back-paginating operator does not refetch
// every render but still sees server-side merges if they return after a pause.
const STALE_TIME_CLOSED_MS = 60_000;
const STALE_TIME_DECISIONS_PAGE_MS = 60_000;
const STALE_TIME_PERFORMANCE_SERIES_MS = 60_000;

// Server-side page size for cursor-paginated decision reads. The engine
// defaults to this when `pageSize` is omitted; the dashboard sends it
// explicitly so the rendered "Page size: N" label cannot drift from reality.
export const DECISIONS_PAGE_SIZE = 100;

// Filters accepted by GET /v1/decisions. Each is a single value: when the
// operator multi-selects, the caller decides whether to send one value
// server-side and filter the rest client-side (see DecisionsFeed).
export interface IDecisionFilters {
    action?: string;
    symbol?: string;
}

export const queryKeys = {
    positionsOpen: () => ['positions', 'open'] as const,
    positionsClosed: (cursor: string | null) => ['positions', 'closed', cursor] as const,
    positionsClosedPrefix: () => ['positions', 'closed'] as const,
    decisionsRecent: (cursor: string | null, filters: IDecisionFilters = {}) => ['decisions', 'recent', cursor, filters] as const,
    decisionsRecentPrefix: () => ['decisions', 'recent'] as const,
    accountEquity: () => ['account', 'equity'] as const,
    riskState: () => ['risk', 'state'] as const,
    performanceByVersion: (windowDays: number) => ['performance', 'by-version', windowDays] as const,
    performanceDailySeries: (windowDays: number) => ['performance', 'daily-series', windowDays] as const,
    shadowPerformanceSummary: (windowDays: number) => ['performance', 'shadow-summary', windowDays] as const,
} as const;

const withCursor = (path: string, cursor: string | null): string => {
    if (cursor === null) {
        return path;
    }

    const separator = path.includes('?') ? '&' : '?';

    return `${path}${separator}cursor=${encodeURIComponent(cursor)}`;
};

const buildDecisionsPath = (cursor: string | null, filters: IDecisionFilters): string => {
    const params = new URLSearchParams();

    params.set('pageSize', String(DECISIONS_PAGE_SIZE));

    if (cursor !== null) {
        params.set('cursor', cursor);
    }

    if (filters.action !== undefined && filters.action.length > 0) {
        params.set('action', filters.action);
    }

    if (filters.symbol !== undefined && filters.symbol.length > 0) {
        params.set('symbol', filters.symbol);
    }

    return `${READ_API_PATHS.decisionsRecent}?${params.toString()}`;
};

// W3 seam: live WS handlers should call queryClient.setQueryData against
// these same keys to override the cache between polls. Keep the key factory
// the single source of truth.

export const usePositionsOpen = (): UseQueryResult<IOpenPositionView[]> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.positionsOpen(),
        queryFn: ({ signal }) => apiClient.get<IOpenPositionView[]>(READ_API_PATHS.positionsOpen, { signal }),
        refetchInterval: POLL_INTERVAL_POSITIONS_MS,
        staleTime: POLL_INTERVAL_POSITIONS_MS - STALE_GUTTER_MS,
        enabled: isAuthenticated,
    });
};

export const usePositionsClosed = (cursor: string | null = null): UseQueryResult<IPaginated<IClosedPositionView>> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.positionsClosed(cursor),
        queryFn: ({ signal }) => apiClient.get<IPaginated<IClosedPositionView>>(withCursor(READ_API_PATHS.positionsClosed, cursor), { signal }),
        staleTime: STALE_TIME_CLOSED_MS,
        enabled: isAuthenticated,
    });
};

export const useDecisionsRecent = (cursor: string | null = null, filters: IDecisionFilters = {}): UseQueryResult<IPaginated<IDecisionView>> => {
    const { isAuthenticated } = useAuth();
    const isFirstPage = cursor === null;

    return useQuery({
        queryKey: queryKeys.decisionsRecent(cursor, filters),
        queryFn: ({ signal }) => apiClient.get<IPaginated<IDecisionView>>(buildDecisionsPath(cursor, filters), { signal }),
        refetchInterval: isFirstPage ? POLL_INTERVAL_DECISIONS_MS : false,
        staleTime: isFirstPage ? POLL_INTERVAL_DECISIONS_MS - STALE_GUTTER_MS : STALE_TIME_DECISIONS_PAGE_MS,
        enabled: isAuthenticated,
    });
};

export const useAccountEquity = (): UseQueryResult<IAccountEquityView> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.accountEquity(),
        queryFn: ({ signal }) => apiClient.get<IAccountEquityView>(READ_API_PATHS.accountEquity, { signal }),
        refetchInterval: POLL_INTERVAL_ACCOUNT_MS,
        staleTime: POLL_INTERVAL_ACCOUNT_MS - STALE_GUTTER_MS,
        enabled: isAuthenticated,
    });
};

export const useRiskState = (): UseQueryResult<IRiskStateView> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.riskState(),
        queryFn: ({ signal }) => apiClient.get<IRiskStateView>(READ_API_PATHS.riskState, { signal }),
        refetchInterval: POLL_INTERVAL_RISK_MS,
        staleTime: POLL_INTERVAL_RISK_MS - STALE_GUTTER_MS,
        enabled: isAuthenticated,
    });
};

export const usePerformanceByVersion = (windowDays: number): UseQueryResult<IPerformanceByVersionView[]> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.performanceByVersion(windowDays),
        queryFn: ({ signal }) => apiClient.get<IPerformanceByVersionView[]>(`${READ_API_PATHS.performanceByVersion}?windowDays=${windowDays}`, { signal }),
        refetchInterval: POLL_INTERVAL_PERFORMANCE_MS,
        staleTime: POLL_INTERVAL_PERFORMANCE_MS - STALE_GUTTER_MS,
        enabled: isAuthenticated,
    });
};

export const usePerformanceDailySeries = (windowDays: number): UseQueryResult<IDailyPerformanceRow[]> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.performanceDailySeries(windowDays),
        queryFn: ({ signal }) => apiClient.get<IDailyPerformanceRow[]>(`${READ_API_PATHS.performanceDailySeries}?windowDays=${windowDays}`, { signal }),
        staleTime: STALE_TIME_PERFORMANCE_SERIES_MS,
        enabled: isAuthenticated,
    });
};

export const useShadowPerformanceSummary = (windowDays: number): UseQueryResult<IShadowPerformanceSummary[]> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: queryKeys.shadowPerformanceSummary(windowDays),
        queryFn: ({ signal }) => apiClient.get<IShadowPerformanceSummary[]>(`${READ_API_PATHS.performanceShadowSummary}?windowDays=${windowDays}`, { signal }),
        staleTime: STALE_TIME_PERFORMANCE_SERIES_MS,
        enabled: isAuthenticated,
    });
};
