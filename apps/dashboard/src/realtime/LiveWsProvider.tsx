import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENT_NAMES, WsRoomEnum, type IStreamLaggedEvent } from '@bot/shared';

import { AUTH_EXPIRED_EVENT } from '@/api/apiClient';
import { useAuth } from '@/auth/AuthProvider';
import { queryKeys } from '@/api/queries';
import { useLiveMerges } from '@/realtime/liveMerges';
import { MAX_RECONNECT_ATTEMPTS_BEFORE_ERROR, onSocketChange, setSocketToken } from '@/realtime/liveSocket';

// All rooms we ever care about. Subscribing eagerly post-handshake keeps the
// per-hook merges declarative — they only bind handlers.
const ALL_ROOMS: readonly WsRoomEnum[] = [WsRoomEnum.POSITIONS, WsRoomEnum.DECISIONS, WsRoomEnum.PNL, WsRoomEnum.CONTROL];

const LAG_BANNER_VISIBLE_MS = 8_000;

interface ILiveWsState {
    isConnected: boolean;
    isLagged: boolean;
    lastLaggedAt: string | null;
    lastError: string | null;
}

const LiveWsContext = React.createContext<ILiveWsState | null>(null);

const dispatchAuthExpired = (): void => {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
};

const subscribeAllRooms = (socket: Socket): void => {
    for (const room of ALL_ROOMS) {
        socket.emit('subscribe', { room });
    }
};

const invalidateEverything = (queryClient: ReturnType<typeof useQueryClient>): void => {
    queryClient.invalidateQueries({ queryKey: queryKeys.positionsOpen() });
    queryClient.invalidateQueries({ queryKey: ['positions', 'closed'] });
    queryClient.invalidateQueries({ queryKey: ['decisions', 'recent'] });
    queryClient.invalidateQueries({ queryKey: queryKeys.accountEquity() });
    queryClient.invalidateQueries({ queryKey: queryKeys.riskState() });
    queryClient.invalidateQueries({ queryKey: ['performance', 'by-version'] });
};

export const LiveWsProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => {
    const { session } = useAuth();
    const queryClient = useQueryClient();
    const [state, setState] = React.useState<ILiveWsState>({ isConnected: false, isLagged: false, lastLaggedAt: null, lastError: null });

    useLiveMerges();

    React.useEffect(() => {
        setSocketToken(session?.token ?? null);
    }, [session?.token]);

    React.useEffect(() => {
        const unsubscribe = onSocketChange((socket) => {
            if (socket === null) {
                setState((s) => ({ ...s, isConnected: false }));

                return;
            }

            bindLifecycle({ socket, setState, queryClient });
        });

        return unsubscribe;
    }, [queryClient]);

    return <LiveWsContext.Provider value={state}>{children}</LiveWsContext.Provider>;
};

interface IBindLifecycleArgs {
    socket: Socket;
    setState: React.Dispatch<React.SetStateAction<ILiveWsState>>;
    queryClient: ReturnType<typeof useQueryClient>;
}

const bindLifecycle = ({ socket, setState, queryClient }: IBindLifecycleArgs): void => {
    socket.on('connect', () => {
        subscribeAllRooms(socket);
        setState((s) => ({ ...s, isConnected: true, lastError: null }));
        // First REST snapshot may have been stale during the disconnect window —
        // a single invalidate brings every view back to ground truth.
        invalidateEverything(queryClient);
    });

    socket.on('disconnect', (reason) => {
        setState((s) => ({ ...s, isConnected: false, lastError: typeof reason === 'string' ? reason : null }));
    });

    socket.on('connect_error', (err) => {
        setState((s) => ({ ...s, lastError: err.message }));
    });

    socket.io.on('reconnect_attempt', (attempt: number) => {
        if (attempt > MAX_RECONNECT_ATTEMPTS_BEFORE_ERROR) {
            setState((s) => ({ ...s, lastError: `Reconnect attempts exceeded ${MAX_RECONNECT_ATTEMPTS_BEFORE_ERROR}` }));
        }
    });

    socket.on(WS_EVENT_NAMES.streamLagged, (payload: IStreamLaggedEvent) => {
        const stampIso = new Date().toISOString();
        invalidateEverything(queryClient);
        setState((s) => ({ ...s, isLagged: true, lastLaggedAt: stampIso, lastError: `Stream lagged: dropped ${payload.droppedCount}` }));
        window.setTimeout(() => setState((s) => ({ ...s, isLagged: false })), LAG_BANNER_VISIBLE_MS);
    });

    socket.on(WS_EVENT_NAMES.authExpired, () => {
        dispatchAuthExpired();
    });
};

export const useLiveWs = (): ILiveWsState => {
    const value = React.useContext(LiveWsContext);

    if (value === null) {
        throw new Error('useLiveWs must be used inside a LiveWsProvider');
    }

    return value;
};

interface IPillProps {
    className?: string;
}

const STATUS_TONE: Record<'connected' | 'disconnected' | 'lagged', string> = {
    connected: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    disconnected: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300',
    lagged: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
};

const pickTone = (state: ILiveWsState): keyof typeof STATUS_TONE => {
    if (state.isLagged) {
        return 'lagged';
    }

    return state.isConnected ? 'connected' : 'disconnected';
};

export const LiveStatusPill = ({ className }: IPillProps): React.ReactElement => {
    const state = useLiveWs();
    const tone = pickTone(state);
    const label = tone === 'connected' ? 'WS: connected' : tone === 'lagged' ? 'WS: lagged' : 'WS: disconnected';

    return (
        <span
            title={state.lastError ?? undefined}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[tone]} ${className ?? ''}`}
        >
            {label}
        </span>
    );
};
