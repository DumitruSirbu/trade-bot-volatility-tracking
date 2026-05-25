import { io, type Socket } from 'socket.io-client';

// Singleton socket.io client targeting the engine's `/live` namespace
// (ADR 0023 §2.1). Same-origin connect: vite proxy in dev, nginx in prod —
// we never hard-code the engine host.
//
// Token rotation (login, AUTH_EXPIRED) requires a full disconnect + recreate
// because socket.io binds the `auth` handshake field at construction time;
// patching it post-connect does not re-verify on the engine side.

const LIVE_NAMESPACE = '/live';

const RECONNECTION_DELAY_MS = 1_000;
const RECONNECTION_DELAY_MAX_MS = 5_000;
const MAX_ATTEMPTS_BEFORE_ERROR = 5;
const RECONNECTION_JITTER_FACTOR = 0.5;

let currentSocket: Socket | null = null;
let currentToken: string | null = null;
const subscribers = new Set<(socket: Socket | null) => void>();

const notify = (socket: Socket | null): void => {
    for (const cb of subscribers) {
        cb(socket);
    }
};

const buildSocket = (token: string): Socket =>
    io(LIVE_NAMESPACE, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: RECONNECTION_DELAY_MS,
        reconnectionDelayMax: RECONNECTION_DELAY_MAX_MS,
        randomizationFactor: RECONNECTION_JITTER_FACTOR,
    });

export const setSocketToken = (token: string | null): void => {
    if (token === currentToken) {
        return;
    }

    if (currentSocket !== null) {
        currentSocket.disconnect();
        currentSocket = null;
    }

    currentToken = token;

    if (token !== null) {
        currentSocket = buildSocket(token);
    }

    notify(currentSocket);
};

export const getSocket = (): Socket | null => currentSocket;

export const onSocketChange = (cb: (socket: Socket | null) => void): (() => void) => {
    subscribers.add(cb);
    cb(currentSocket);

    return () => {
        subscribers.delete(cb);
    };
};

export const MAX_RECONNECT_ATTEMPTS_BEFORE_ERROR = MAX_ATTEMPTS_BEFORE_ERROR;
