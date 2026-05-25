import * as React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { WS_EVENT_NAMES, type IAccountEquityView, type IDecisionView, type IOpenPositionView, type IPaginated, type IPnlTickEvent } from '@bot/shared';
import type { Socket } from 'socket.io-client';

import { controlKeys } from '@/api/mutations';
import { queryKeys } from '@/api/queries';
import { onSocketChange } from '@/realtime/liveSocket';

// Engine REST page size for /v1/decisions/recent — keep the live-merge bound
// matched so a prepend doesn't push the visible window past one REST page.
const DECISIONS_FIRST_PAGE_SIZE = 50;

const upsertOpenPosition = (existing: IOpenPositionView[] | undefined, incoming: IOpenPositionView): IOpenPositionView[] => {
    if (existing === undefined) {
        return [incoming];
    }

    const idx = existing.findIndex((p) => p.id === incoming.id);

    if (idx === -1) {
        return [incoming, ...existing];
    }

    const next = existing.slice();
    next[idx] = incoming;

    return next;
};

const dropPositionById = (existing: IOpenPositionView[] | undefined, id: string): IOpenPositionView[] | undefined => {
    if (existing === undefined) {
        return existing;
    }

    return existing.filter((p) => p.id !== id);
};

const prependDecision = (existing: IPaginated<IDecisionView> | undefined, incoming: IDecisionView): IPaginated<IDecisionView> => {
    if (existing === undefined) {
        return { items: [incoming], nextCursor: null, pageSize: DECISIONS_FIRST_PAGE_SIZE };
    }

    if (existing.items.some((d) => d.id === incoming.id)) {
        return existing;
    }

    const items = [incoming, ...existing.items].slice(0, DECISIONS_FIRST_PAGE_SIZE);

    return { ...existing, items };
};

const mergePnlTick = (existing: IAccountEquityView | undefined, tick: IPnlTickEvent): IAccountEquityView => ({
    equityUsd: tick.equityUsd,
    marginUsed: existing?.marginUsed ?? null,
    freeMargin: existing?.freeMargin ?? null,
    openExposureUsd: tick.openExposureUsd,
    asOf: tick.asOf,
});

export const bindPositions = (socket: Socket, queryClient: QueryClient): void => {
    const onOpenedOrUpdated = (view: IOpenPositionView): void => {
        queryClient.setQueryData<IOpenPositionView[]>(queryKeys.positionsOpen(), (prev) => upsertOpenPosition(prev, view));
    };

    socket.on(WS_EVENT_NAMES.positionOpened, onOpenedOrUpdated);
    socket.on(WS_EVENT_NAMES.positionUpdated, onOpenedOrUpdated);
    socket.on(WS_EVENT_NAMES.positionClosed, (view: { id: string }) => {
        queryClient.setQueryData<IOpenPositionView[]>(queryKeys.positionsOpen(), (prev) => dropPositionById(prev, view.id));
        // Prefix-invalidate so EVERY cached cursor page (page 1, page 2, …)
        // refetches — not just the first page (Round-1 logic fix).
        queryClient.invalidateQueries({ queryKey: queryKeys.positionsClosedPrefix() });
        // Round-2 logic fix: the detail page for the just-closed position is
        // still showing the OPEN snapshot until its next poll. Invalidate
        // explicitly so the route renders the CLOSED state immediately.
        queryClient.invalidateQueries({ queryKey: controlKeys.positionById(view.id) });
    });
};

const bindDecisions = (socket: Socket, queryClient: QueryClient): void => {
    socket.on(WS_EVENT_NAMES.decisionRecorded, (decision: IDecisionView) => {
        queryClient.setQueryData<IPaginated<IDecisionView>>(queryKeys.decisionsRecent(null), (prev) => prependDecision(prev, decision));
    });
};

const bindPnlTick = (socket: Socket, queryClient: QueryClient): void => {
    socket.on(WS_EVENT_NAMES.pnlTick, (tick: IPnlTickEvent) => {
        queryClient.setQueryData<IAccountEquityView>(queryKeys.accountEquity(), (prev) => mergePnlTick(prev, tick));
    });
};

const bindHaltEvents = (socket: Socket, queryClient: QueryClient): void => {
    const invalidateRisk = (): void => {
        queryClient.invalidateQueries({ queryKey: queryKeys.riskState() });
    };

    socket.on(WS_EVENT_NAMES.haltChanged, invalidateRisk);
    socket.on(WS_EVENT_NAMES.riskHaltEngaged, invalidateRisk);
    socket.on(WS_EVENT_NAMES.modelDivergenceEngaged, invalidateRisk);
};

export const useLiveMerges = (): void => {
    const queryClient = useQueryClient();

    React.useEffect(() => {
        const unsubscribe = onSocketChange((socket) => {
            if (socket === null) {
                return;
            }

            bindPositions(socket, queryClient);
            bindDecisions(socket, queryClient);
            bindPnlTick(socket, queryClient);
            bindHaltEvents(socket, queryClient);
        });

        return unsubscribe;
    }, [queryClient]);
};
