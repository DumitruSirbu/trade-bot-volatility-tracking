import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { HaltStateEnum, READ_API_PATHS, type IHaltAuditEntry, type IKillSwitchState, type IPaginated, type IPositionDetailView } from '@bot/shared';

import { apiClient } from '@/api/apiClient';
import { queryKeys } from '@/api/queries';
import { useAuth } from '@/auth/AuthProvider';

// Mutations + control/positions-detail queries. Separate from `queries.ts`
// because mutations carry different cache-invalidation semantics than read
// polls and we want one place to audit halt-surface invalidation.

export const controlKeys = {
    haltHistory: (cursor: string | null) => ['control', 'halt-history', cursor] as const,
    haltState: () => ['control', 'halt-state'] as const,
    positionById: (id: string) => ['positions', 'by-id', id] as const,
} as const;

export interface IHaltMutationInput {
    reason: string;
    flatten: boolean;
}

export interface IResumeMutationInput {
    reason: string;
}

// Engine response shapes per `apps/engine/src/control/HaltController.ts`
// `IHaltResponseBody` / `IResumeResponseBody`. These are narrower than
// `IKillSwitchState` (halt/resume return only the transition record + new
// state), so we keep local interfaces but reuse `HaltStateEnum` instead of
// re-declaring the literal union.
export interface IHaltMutationResponse {
    haltState: HaltStateEnum;
    haltedAt: string;
    haltReason: string;
    flattenRequested: boolean;
    auditId: string;
}

export interface IResumeMutationResponse {
    haltState: HaltStateEnum;
    resumedAt: string;
    auditId: string;
}

const invalidateHaltSurfaces = (queryClient: ReturnType<typeof useQueryClient>): void => {
    queryClient.invalidateQueries({ queryKey: queryKeys.riskState() });
    queryClient.invalidateQueries({ queryKey: controlKeys.haltState() });
    queryClient.invalidateQueries({ queryKey: ['control', 'halt-history'] });
};

export const useHaltMutation = (): UseMutationResult<IHaltMutationResponse, Error, IHaltMutationInput> => {
    const queryClient = useQueryClient();

    return useMutation<IHaltMutationResponse, Error, IHaltMutationInput>({
        mutationFn: ({ reason, flatten }) => apiClient.post<IHaltMutationResponse>(READ_API_PATHS.controlHalt, { reason, flatten }),
        onSuccess: () => invalidateHaltSurfaces(queryClient),
    });
};

export const useResumeMutation = (): UseMutationResult<IResumeMutationResponse, Error, IResumeMutationInput> => {
    const queryClient = useQueryClient();

    return useMutation<IResumeMutationResponse, Error, IResumeMutationInput>({
        mutationFn: ({ reason }) => apiClient.post<IResumeMutationResponse>(READ_API_PATHS.controlResume, { reason }),
        onSuccess: () => invalidateHaltSurfaces(queryClient),
    });
};

const HALT_HISTORY_STALE_MS = 30_000;
const STALE_TIME_HALT_STATE_MS = 5_000;
const POLL_INTERVAL_HALT_STATE_MS = 15_000;
const STALE_TIME_POSITION_BY_ID_MS = 5_000;
const POLL_INTERVAL_POSITION_BY_ID_MS = 10_000;

const withHistoryCursor = (cursor: string | null): string => {
    if (cursor === null) {
        return READ_API_PATHS.controlHaltHistory;
    }

    return `${READ_API_PATHS.controlHaltHistory}?cursor=${encodeURIComponent(cursor)}`;
};

export const useHaltHistoryQuery = (cursor: string | null = null, enabled = true): UseQueryResult<IPaginated<IHaltAuditEntry>> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: controlKeys.haltHistory(cursor),
        queryFn: ({ signal }) => apiClient.get<IPaginated<IHaltAuditEntry>>(withHistoryCursor(cursor), { signal }),
        staleTime: HALT_HISTORY_STALE_MS,
        enabled: isAuthenticated && enabled,
    });
};

export const useHaltStateQuery = (): UseQueryResult<IKillSwitchState> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: controlKeys.haltState(),
        queryFn: ({ signal }) => apiClient.get<IKillSwitchState>(READ_API_PATHS.controlHalt, { signal }),
        staleTime: STALE_TIME_HALT_STATE_MS,
        refetchInterval: POLL_INTERVAL_HALT_STATE_MS,
        enabled: isAuthenticated,
    });
};

export const usePositionByIdQuery = (id: string | undefined): UseQueryResult<IPositionDetailView> => {
    const { isAuthenticated } = useAuth();

    return useQuery({
        queryKey: controlKeys.positionById(id ?? ''),
        queryFn: ({ signal }) => apiClient.get<IPositionDetailView>(READ_API_PATHS.positionById(id ?? ''), { signal }),
        staleTime: STALE_TIME_POSITION_BY_ID_MS,
        refetchInterval: POLL_INTERVAL_POSITION_BY_ID_MS,
        enabled: isAuthenticated && id !== undefined && id.length > 0,
    });
};
