import { AuthFailureReasonEnum, AuthScopeEnum, IAuthSubject, WsRoomEnum } from '@bot/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';

import { AUTH_CORS_ALLOWLIST_ENV } from '../auth/const/authConsts';
import { POSITION_OPENED_EVENT, POSITION_CLOSED_EVENT } from '../common/const';
import { IPositionClosedEvent } from '../common/interface/IPositionClosedEvent';
import { IPositionOpenedEvent } from '../common/interface/IPositionOpenedEvent';
import { POSITION_STATE_TRANSITIONED_EVENT } from '../position/const';
import { PositionRepository } from '../position/repository/PositionRepository';
import { StrategyVersionRepository } from '../strategy/repository/StrategyVersionRepository';
import { UNKNOWN_STRATEGY_VERSION_NAME } from '../read-api/const/readApiConsts';
import { mapClosedPosition, mapOpenPosition } from '../read-api/mappers/readApiMappers';
import { PerSocketQueue } from './backpressure/PerSocketQueue';
import { PnlThrottle, PositionCoalescer } from './coalescing/Coalescers';
import { ISweeperSocket, ISweeperSocketSource, WsAuthAdapter } from './auth/WsAuthHandshake';
import {
    LIVE_NAMESPACE,
    WS_EVENT_AUTH_ERROR,
    WS_EVENT_POSITION_CLOSED,
    WS_EVENT_POSITION_OPENED,
    WS_EVENT_POSITION_UPDATED,
    WS_EVENT_SUBSCRIBE,
    WS_EVENT_UNSUBSCRIBE,
} from './WsConstants';

// M9 W5 (ADR 0023). Live read-only WS gateway. socket.io transport, four
// rooms (positions / decisions / pnl / control). Auth on handshake, scope
// check on subscribe, periodic re-auth sweep, three-layer backpressure,
// coalescing of high-frequency channels.
//
// Read-only invariant (ADR 0023 §2.5): the gateway publishes only. Inbound
// events outside the allowlist (`subscribe`, `unsubscribe`) are logged-warn
// and ignored — control-plane mutations stay on HTTP.
//
// Event sources are existing engine events (M2/M5/M6); we do not introduce
// new event names. POSITION_OPENED / POSITION_CLOSED / POSITION_STATE_TRANSITIONED
// are wired here. `decision.recorded`, `pnl.tick`, `halt.changed`,
// `risk.halt.engaged`, `model.divergence.engaged` are room-defined per ADR 0023
// §2.2 but do not yet exist on the engine bus (StrategyService writes
// decisions directly via the repository; HaltService updates the flag without
// emitting); the rooms are pre-wired so a follow-up wave can publish without
// changing the gateway contract.
//
// CORS reuses W2's AUTH_CORS_ALLOWLIST env (single source of truth per ADR
// 0023 §2.6). We parse the env at module init so a malformed value fails fast
// rather than at first connect.

// Minimal subset of socket.io's Socket / Server types we depend on. Typing
// against this interface lets the spec swap in a stub without pulling
// socket.io into the test build.
interface ILiveSocket extends ISweeperSocket {
    readonly handshake: { auth?: { token?: unknown } };
    join(room: string): Promise<unknown> | unknown;
    leave(room: string): Promise<unknown> | unknown;
    onAny(handler: (event: string, ...args: unknown[]) => void): void;
}

interface ILiveServer {
    // Root socket.io Server exposes `.of(namespace)`; a Namespace (which is
    // what @WebSocketServer() injects when a namespace is configured) does
    // not. Both shapes expose `sockets` directly. We treat `of` as optional
    // and read `sockets` off whichever shape we have. See `liveSockets()`.
    of?(namespace: string): {
        sockets: Map<string, ILiveSocket> | { values(): IterableIterator<ILiveSocket> };
        to(room: string): { emit(event: string, payload: unknown): void };
    };
    sockets?: Map<string, ILiveSocket> | { values(): IterableIterator<ILiveSocket> };
}

// Per-socket runtime state. Lives in `socket.data.runtime` but kept as a
// separate map keyed by socket id so the gateway can audit + clean up
// without depending on socket.io's `data` bag layout.
interface ISocketRuntime {
    queue: PerSocketQueue;
    pnlThrottle: PnlThrottle;
    positionCoalescer: PositionCoalescer;
    rooms: Set<WsRoomEnum>;
}

function parseCorsAllowlist(): string[] {
    // M9 R1 #4 — evaluated per-connect via the `origin` callback below so a
    // hot edit of AUTH_CORS_ALLOWLIST is honoured without a process restart.
    // Mirrors `AppConfigService.parseCorsAllowlist` byte-for-byte (single env
    // key per ADR 0020 §2.3 / §2.7). TODO(M11): inject AppConfigService into
    // the gateway once Nest exposes a decorator-time DI hook so this is the
    // literal AppConfigService accessor, not a parallel parser.
    const raw = process.env[AUTH_CORS_ALLOWLIST_ENV] ?? '';

    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

@Injectable()
@WebSocketGateway({
    namespace: LIVE_NAMESPACE,
    cors: {
        // socket.io invokes this callback per handshake; the allow-list is
        // re-read so a hot edit is reflected on the NEXT connect (existing
        // sockets keep their original auth — the re-auth sweeper closes them
        // on token expiry per ADR 0020 §2.5).
        origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
            // No `Origin` header (CLI / same-origin) — let the bearer guard
            // decide; the WS handshake still validates the token.
            if (requestOrigin === undefined || requestOrigin.length === 0) {
                callback(null, true);

                return;
            }

            const allowList = parseCorsAllowlist();
            callback(null, allowList.includes(requestOrigin));
        },
        credentials: true,
    },
})
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
    private readonly logger = new Logger(LiveGateway.name);

    @WebSocketServer() private server!: ILiveServer;

    private readonly runtimes = new Map<string, ISocketRuntime>();

    constructor(
        private readonly auth: WsAuthAdapter,
        private readonly positions: PositionRepository,
        private readonly strategyVersions: StrategyVersionRepository,
    ) {}

    onModuleInit(): void {
        // No-op placeholder; the sweeper is started from afterInit so the
        // namespace is available. Kept so test harnesses that bypass
        // afterInit can call this without side effects.
    }

    // socket.io lifecycle hook — fires once when the namespace is wired.
    afterInit(server: ILiveServer): void {
        this.server = server;

        const source: ISweeperSocketSource = {
            listSockets: () => this.liveSockets(),
        };

        this.auth.startSweeper(source);

        this.logger.log(`LiveGateway initialised namespace=${LIVE_NAMESPACE}`);
    }

    // Socket connected — verify handshake, attach subject + runtime, or
    // reject with `auth.error` + clean close. We do NOT join any room
    // automatically; the client emits `subscribe` per-room.
    async handleConnection(socket: ILiveSocket): Promise<void> {
        const rawToken = readHandshakeToken(socket);
        const verified = await this.auth.verifyHandshake(rawToken);

        if ('error' in verified) {
            this.rejectHandshake(socket, verified.reason);

            return;
        }

        socket.data.subject = verified;

        const runtime: ISocketRuntime = {
            queue: new PerSocketQueue({ socketId: socket.id, emit: (e, p) => socket.emit(e, p), disconnect: (c) => socket.disconnect(c) }, () => Date.now()),
            pnlThrottle: new PnlThrottle(
                () => Date.now(),
                (payload) => this.safeEmit(socket, 'pnl.tick', payload),
            ),
            positionCoalescer: new PositionCoalescer((payload) => this.safeEmit(socket, WS_EVENT_POSITION_UPDATED, payload)),
            rooms: new Set<WsRoomEnum>(),
        };

        this.runtimes.set(socket.id, runtime);

        // Read-only enforcement: any event id outside the allowlist is
        // logged + ignored. socket.io's `onAny` gives us a single handler
        // for everything that isn't explicitly @SubscribeMessage-bound.
        socket.onAny((event, ..._args) => {
            if (event === WS_EVENT_SUBSCRIBE || event === WS_EVENT_UNSUBSCRIBE) {
                return;
            }

            this.logger.warn(`ws.unsupportedInbound socketId=${socket.id} event=${event}`);
        });

        this.logger.log(`ws.connection sub=${verified.sub} jti=${verified.jti} socketId=${socket.id}`);
    }

    handleDisconnect(socket: ILiveSocket): void {
        const runtime = this.runtimes.get(socket.id);

        if (runtime !== undefined) {
            runtime.pnlThrottle.cancel();
            runtime.positionCoalescer.cancel();
            this.runtimes.delete(socket.id);
        }

        this.logger.log(`ws.disconnect socketId=${socket.id}`);
    }

    // ----- Inbound: subscribe ---------------------------------------------

    @SubscribeMessage(WS_EVENT_SUBSCRIBE)
    async onSubscribe(socket: ILiveSocket, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
        const room = extractRoom(payload);

        if (room === null) {
            return { ok: false, reason: 'INVALID_ROOM' };
        }

        const subject = socket.data.subject;

        if (subject === undefined) {
            return { ok: false, reason: 'NOT_AUTHENTICATED' };
        }

        if (!hasRequiredScope(subject, room)) {
            return { ok: false, reason: 'INSUFFICIENT_SCOPE' };
        }

        await socket.join(room);

        const runtime = this.runtimes.get(socket.id);

        if (runtime !== undefined) {
            runtime.rooms.add(room);
        }

        return { ok: true };
    }

    @SubscribeMessage(WS_EVENT_UNSUBSCRIBE)
    async onUnsubscribe(socket: ILiveSocket, payload: unknown): Promise<{ ok: boolean }> {
        const room = extractRoom(payload);

        if (room === null) {
            return { ok: false };
        }

        await socket.leave(room);

        const runtime = this.runtimes.get(socket.id);

        if (runtime !== undefined) {
            runtime.rooms.delete(room);
        }

        return { ok: true };
    }

    // ----- Outbound: position lifecycle -----------------------------------

    @OnEvent(POSITION_OPENED_EVENT)
    async onPositionOpened(event: IPositionOpenedEvent): Promise<void> {
        const position = await this.positions.findById(event.positionId);

        if (position === null) {
            return;
        }

        const view = mapOpenPosition({ position, markPrice: null });

        this.broadcastToRoom(WsRoomEnum.POSITIONS, WS_EVENT_POSITION_OPENED, view);
    }

    @OnEvent(POSITION_STATE_TRANSITIONED_EVENT)
    async onPositionTransitioned(event: { positionId: number; toState: string }): Promise<void> {
        const position = await this.positions.findById(event.positionId);

        if (position === null) {
            return;
        }

        const view = mapOpenPosition({ position, markPrice: null });

        // Per-socket coalescing: drop intermediate updates within the 200ms
        // window per positionId. The room broadcast happens via each
        // socket's PositionCoalescer (which finally calls socket.emit).
        for (const runtime of this.runtimesInRoom(WsRoomEnum.POSITIONS)) {
            runtime.positionCoalescer.offer(view);
        }
    }

    @OnEvent(POSITION_CLOSED_EVENT)
    async onPositionClosed(event: IPositionClosedEvent): Promise<void> {
        // Reuse mapOpenPosition-style payload semantics is wrong for closed
        // positions; for the close event we emit a slim payload carrying the
        // close-time facts the dashboard needs to drop the row + show the
        // realized PnL. The full closed-position view (mapClosedPosition)
        // requires the persisted exit timestamp + entry/exit prices which the
        // event payload already carries, but the position entity is the
        // source of truth — fetch it.
        const position = await this.positions.findById(event.positionId);

        if (position === null) {
            return;
        }

        // mapClosedPosition lives in the same mapper file; we reuse it
        // rather than synthesise a payload here. Statically imported at the
        // top of the file so the "no write paths from WS" boundary remains
        // visible to static analysis (R1 fix wave #6).
        const version = await this.strategyVersions.findById(position.strategyVersionId);
        const strategyVersionName = version === null ? UNKNOWN_STRATEGY_VERSION_NAME : version.name;

        const view = mapClosedPosition(position, strategyVersionName);

        this.broadcastToRoom(WsRoomEnum.POSITIONS, WS_EVENT_POSITION_CLOSED, view);
    }

    // ----- Internals ------------------------------------------------------

    private broadcastToRoom(room: WsRoomEnum, event: string, payload: unknown): void {
        // Per-socket broadcast (not socket.io's room emit) so each socket's
        // backpressure queue is decremented 1:1 with the wire emit. socket.io
        // room emits skip the per-socket queue accounting we need.
        for (const socket of this.liveSockets()) {
            const runtime = this.runtimes.get(socket.id);

            if (runtime === undefined || !runtime.rooms.has(room)) {
                continue;
            }

            if (!runtime.queue.tryEnqueue()) {
                continue;
            }

            this.safeEmit(socket, event, payload);
            runtime.queue.markFlushed();
        }
    }

    private safeEmit(socket: ILiveSocket, event: string, payload: unknown): void {
        try {
            socket.emit(event, payload);
        } catch (cause) {
            this.logger.warn(`ws.emit failed event=${event} socketId=${socket.id} cause=${describe(cause)}`);
        }
    }

    private *liveSockets(): IterableIterator<ILiveSocket> {
        if (this.server === undefined || this.server === null) {
            return;
        }

        // M9 hotfix: when @WebSocketGateway declares `namespace: '/live'`,
        // @WebSocketServer() injects the Namespace itself (not the root
        // Server), so `.of()` does not exist. Iterate `this.server.sockets`
        // directly. Fall back to `.of(LIVE_NAMESPACE)` only if a test stub
        // exposes the root-Server shape.
        const namespaceLike =
            typeof this.server.of === 'function' ? this.server.of(LIVE_NAMESPACE) : (this.server as unknown as { sockets: Map<string, ILiveSocket> });

        const sockets = namespaceLike.sockets as Map<string, ILiveSocket>;

        // socket.io's `sockets` is a Map in v4; iterate its values.
        if (sockets !== undefined && typeof (sockets as { values?: unknown }).values === 'function') {
            for (const s of (sockets as Map<string, ILiveSocket>).values()) {
                yield s;
            }
        }
    }

    private *runtimesInRoom(room: WsRoomEnum): IterableIterator<ISocketRuntime> {
        for (const [, runtime] of this.runtimeEntriesInRoom(room)) {
            yield runtime;
        }
    }

    private *runtimeEntriesInRoom(room: WsRoomEnum): IterableIterator<[string, ISocketRuntime]> {
        for (const [id, runtime] of this.runtimes) {
            if (runtime.rooms.has(room)) {
                yield [id, runtime];
            }
        }
    }

    private rejectHandshake(socket: ILiveSocket, reason: AuthFailureReasonEnum): void {
        try {
            socket.emit(WS_EVENT_AUTH_ERROR, { error: 'AUTH_FAILED', reason });
        } catch {
            // ignore — we're closing anyway
        }

        socket.disconnect(true);
        this.logger.warn(`ws.handshake.rejected socketId=${socket.id} reason=${reason}`);
    }

    // Test seam — the spec injects a stub server before calling
    // `handleConnection` so it can drive scenarios without standing up an
    // HTTP server.
    setServerForTest(server: ILiveServer): void {
        this.server = server;
    }

    getRuntimeForTest(socketId: string): ISocketRuntime | undefined {
        return this.runtimes.get(socketId);
    }
}

function readHandshakeToken(socket: ILiveSocket): string | undefined {
    const auth = socket.handshake.auth ?? {};
    const token = (auth as Record<string, unknown>).token;

    return typeof token === 'string' ? token : undefined;
}

function extractRoom(payload: unknown): WsRoomEnum | null {
    if (payload === null || typeof payload !== 'object') {
        return null;
    }

    const candidate = (payload as Record<string, unknown>).room;

    if (typeof candidate !== 'string') {
        return null;
    }

    const values = Object.values(WsRoomEnum) as string[];

    if (!values.includes(candidate)) {
        return null;
    }

    return candidate as WsRoomEnum;
}

// Subscribe rules per ADR 0023 §2.2: READ scope is enough for the read-only
// data rooms; CONTROL room requires HALT (because halt + risk-halt + model
// divergence are operationally sensitive — only the operator who can engage
// the halt should see those events surface in real-time).
function hasRequiredScope(subject: IAuthSubject, room: WsRoomEnum): boolean {
    const scopes = new Set(subject.scopes);

    if (room === WsRoomEnum.CONTROL) {
        return scopes.has(AuthScopeEnum.HALT) || scopes.has(AuthScopeEnum.ADMIN);
    }

    return scopes.has(AuthScopeEnum.READ) || scopes.has(AuthScopeEnum.HALT) || scopes.has(AuthScopeEnum.ADMIN);
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
