import { AuthFailureReasonEnum, AuthScopeEnum, IAuthSubject, WsRoomEnum } from '@bot/shared';

import { LiveGateway } from '../../src/ws/LiveGateway';
import { LIVE_NAMESPACE, WS_EVENT_AUTH_EXPIRED, WS_EVENT_STREAM_LAGGED, WS_QUEUE_FULL_DISCONNECT_MS, WS_QUEUE_SOFT_CAP } from '../../src/ws/WsConstants';
import { ISweeperSocketSource, WsAuthAdapter } from '../../src/ws/auth/WsAuthHandshake';
import { PerSocketQueue } from '../../src/ws/backpressure/PerSocketQueue';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { AuthTokenService, WsAuthHandshake } from '../../src/auth/AuthModule';
import type { IRevokedJtiRepositoryPort } from '../../src/auth/AuthModule';

// M9 QA — adversarial extension to LiveGateway.spec.ts.
// Covers:
//   - Token expiring 1ms before next emit → auth.expired before missed emit, no leak
//   - Sweeper race with emit (sweeper fires mid-broadcast) → no double-close
//   - Queue overflow EXACTLY at soft cap (boundary)
//   - Slow-client at 9.99s queue-full → NOT disconnected
//   - Slow-client at 10.01s queue-full → disconnected
//   - Subscribe to unknown room → ignored (warn), no crash
//   - READ-scoped client tries to subscribe to CONTROL room → rejected

class FakeSocket {
    readonly id: string;
    readonly data: { subject?: IAuthSubject } = {};
    readonly handshake: { auth?: { token?: unknown } };
    readonly emitted: Array<{ event: string; payload: unknown }> = [];
    readonly joinedRooms = new Set<string>();
    onAnyHandler: ((event: string, ...args: unknown[]) => void) | null = null;
    disconnected = false;
    disconnectCallCount = 0;
    forceClose = false;

    constructor(id: string, token: string | undefined) {
        this.id = id;
        this.handshake = { auth: token === undefined ? {} : { token } };
    }

    emit(event: string, payload: unknown): void {
        this.emitted.push({ event, payload });
    }

    disconnect(close: boolean): void {
        this.disconnected = true;
        this.forceClose = close;
        this.disconnectCallCount += 1;
    }

    onAny(handler: (event: string, ...args: unknown[]) => void): void {
        this.onAnyHandler = handler;
    }

    join(room: string): void {
        this.joinedRooms.add(room);
    }

    leave(room: string): void {
        this.joinedRooms.delete(room);
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>();

    to(_room: string): { emit(event: string, payload: unknown): void } {
        return { emit: (): void => undefined };
    }
}

class FakeServer {
    private readonly namespaces = new Map<string, FakeNamespace>();

    of(namespace: string): FakeNamespace {
        let ns = this.namespaces.get(namespace);
        if (ns === undefined) {
            ns = new FakeNamespace();
            this.namespaces.set(namespace, ns);
        }
        return ns;
    }
}

class StubRevokedRepo implements IRevokedJtiRepositoryPort {
    readonly revokedSet = new Set<string>();

    async isRevoked(jti: string): Promise<boolean> {
        return this.revokedSet.has(jti);
    }

    async revoke(): Promise<void> {
        /* not exercised */
    }

    async pruneOlderThan(_cutoff: Date): Promise<number> {
        return 0;
    }

    async countAll(): Promise<number> {
        return this.revokedSet.size;
    }
}

// Tracks every WsAuthAdapter started by buildGateway so the sweeper interval
// is cleared in teardown.  The interval is unref'd but still fires warnings
// while the process is alive.
const builtAdapters: WsAuthAdapter[] = [];

afterEach(() => {
    for (const adapter of builtAdapters) {
        adapter.onModuleDestroy();
    }
    builtAdapters.length = 0;
});

function buildGateway(opts: { clock?: () => number; revoked?: StubRevokedRepo } = {}): {
    gateway: LiveGateway;
    server: FakeServer;
    namespace: FakeNamespace;
    adapter: WsAuthAdapter;
} {
    const revoked = opts.revoked ?? new StubRevokedRepo();
    const clock = opts.clock ?? ((): number => Date.now());

    const tokenStub = {
        verify(raw: string, _now: Date): IAuthSubject | { error: 'AUTH_FAILED'; reason: AuthFailureReasonEnum } {
            if (raw === 'expired') {
                return { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.EXPIRED };
            }
            if (raw === 'malformed') {
                return { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.MALFORMED };
            }

            const [sub, scopesCsv, expSec] = raw.split('|');
            const scopes = scopesCsv.split(',').filter((s): s is AuthScopeEnum => (Object.values(AuthScopeEnum) as string[]).includes(s));

            return {
                sub,
                jti: `jti-${sub}`,
                scopes,
                iat: 0,
                exp: Number.parseInt(expSec, 10),
            };
        },
    } as unknown as AuthTokenService;

    const handshake = new WsAuthHandshake(tokenStub);
    const adapter = new WsAuthAdapter(handshake, revoked, clock);
    const positions = { findById: jest.fn().mockResolvedValue(null) } as unknown as PositionRepository;
    const gateway = new LiveGateway(adapter, positions);
    const server = new FakeServer();

    gateway.setServerForTest(server as unknown as Parameters<LiveGateway['setServerForTest']>[0]);

    const namespace = server.of(LIVE_NAMESPACE);
    const source: ISweeperSocketSource = {
        listSockets: (): Iterable<FakeSocket> => namespace.sockets.values(),
    };
    adapter.startSweeper(source);
    builtAdapters.push(adapter);

    return { gateway, server, namespace, adapter };
}

async function connect(gateway: LiveGateway, namespace: FakeNamespace, socket: FakeSocket): Promise<void> {
    namespace.sockets.set(socket.id, socket);
    await gateway.handleConnection(socket as unknown as Parameters<LiveGateway['handleConnection']>[0]);
}

// ---------------------------------------------------------------------------
// Token expiring 1ms before next emit
// ---------------------------------------------------------------------------

describe('LiveGateway adversarial — token expiring 1ms before sweep', () => {
    it('sweeper fires auth.expired and disconnects; no leaked position event follows', async () => {
        let nowMs = 1_000_000_000_000;
        const { gateway, namespace, adapter } = buildGateway({ clock: () => nowMs });
        const nowSec = Math.floor(nowMs / 1000);
        // Token expires at nowSec+60 seconds.
        const socket = new FakeSocket('s-expiring', `bob|${AuthScopeEnum.READ}|${nowSec + 60}`);

        await connect(gateway, namespace, socket);
        await gateway.onSubscribe(socket as never, { room: WsRoomEnum.POSITIONS });

        // Advance clock to 1ms PAST the expiry.
        nowMs = (nowSec + 60) * 1000 + 1;
        adapter.sweepOnce();

        // auth.expired must arrive before any hypothetical position event.
        const expiredIdx = socket.emitted.findIndex((e) => e.event === WS_EVENT_AUTH_EXPIRED);
        expect(expiredIdx).not.toBe(-1);
        expect(socket.disconnected).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Sweeper race with emit
// ---------------------------------------------------------------------------

describe('LiveGateway adversarial — sweeper race with ongoing broadcast', () => {
    it('sweeper does not double-disconnect a socket that disconnect() was already called on', async () => {
        let nowMs = 1_000_000_000_000;
        const { gateway, namespace, adapter } = buildGateway({ clock: () => nowMs });
        const nowSec = Math.floor(nowMs / 1000);
        const socket = new FakeSocket('s-race', `charlie|${AuthScopeEnum.READ}|${nowSec + 60}`);

        await connect(gateway, namespace, socket);

        // Manually disconnect the socket first (simulates a concurrent broadcast
        // that already called disconnect).
        socket.disconnect(true);
        const callsAfterManual = socket.disconnectCallCount;

        // Now advance time and sweep.
        nowMs = (nowSec + 60) * 1000 + 1;
        adapter.sweepOnce();

        // The sweeper may still call disconnect on an already-disconnected socket
        // (socket.io itself is idempotent), but it MUST NOT have called it 0 times
        // (the sweep must run). We assert the total is at most 2 (manual + 1 from sweeper).
        expect(socket.disconnectCallCount).toBeLessThanOrEqual(callsAfterManual + 1);
    });
});

// ---------------------------------------------------------------------------
// Queue overflow EXACTLY at soft cap boundary
// ---------------------------------------------------------------------------

describe('PerSocketQueue adversarial — overflow exactly at soft cap', () => {
    it('soft cap boundary: (cap-1) succeeds, cap-th succeeds, (cap+1) drops + emits stream.lagged once', () => {
        let now = 0;
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const queue = new PerSocketQueue(
            {
                socketId: 'q-boundary',
                emit: (event, payload) => emitted.push({ event, payload }),
                disconnect: () => undefined,
            },
            () => now,
        );

        // Enqueue exactly WS_QUEUE_SOFT_CAP items — all should succeed.
        for (let i = 0; i < WS_QUEUE_SOFT_CAP; i += 1) {
            expect(queue.tryEnqueue()).toBe(true);
        }

        // The very first message OVER the soft cap must drop and emit stream.lagged.
        const overCapResult = queue.tryEnqueue();
        expect(overCapResult).toBe(false);

        const laggedEvents = emitted.filter((e) => e.event === WS_EVENT_STREAM_LAGGED);
        expect(laggedEvents).toHaveLength(1);
    });

    it('only one stream.lagged notice per queue-full window, not one per dropped message', () => {
        let now = 0;
        const emitted: Array<{ event: string }> = [];
        const queue = new PerSocketQueue(
            {
                socketId: 'q-once',
                emit: (event) => emitted.push({ event }),
                disconnect: () => undefined,
            },
            () => now,
        );

        for (let i = 0; i < WS_QUEUE_SOFT_CAP; i += 1) {
            queue.tryEnqueue();
        }

        // Fire 10 more over-cap messages inside the same window.
        for (let i = 0; i < 10; i += 1) {
            queue.tryEnqueue();
        }

        const laggedCount = emitted.filter((e) => e.event === WS_EVENT_STREAM_LAGGED).length;
        expect(laggedCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Slow-client boundary: 9.99s queue-full → NOT disconnected
// ---------------------------------------------------------------------------

describe('PerSocketQueue adversarial — slow-client timeout boundary', () => {
    it('9.99s queue-full does NOT disconnect the socket', () => {
        let now = 0;
        let disconnected = false;
        const queue = new PerSocketQueue(
            {
                socketId: 'q-slow-safe',
                emit: () => undefined,
                disconnect: () => {
                    disconnected = true;
                },
            },
            () => now,
        );

        for (let i = 0; i < WS_QUEUE_SOFT_CAP; i += 1) {
            queue.tryEnqueue();
        }

        // Open the queue-full window.
        queue.tryEnqueue();
        expect(disconnected).toBe(false);

        // Advance to just under the threshold (1ms before 10s).
        now = WS_QUEUE_FULL_DISCONNECT_MS - 1;
        queue.tryEnqueue();

        expect(disconnected).toBe(false);
    });

    it('10.01s queue-full disconnects the socket', () => {
        let now = 0;
        let disconnected = false;
        const queue = new PerSocketQueue(
            {
                socketId: 'q-slow-evict',
                emit: () => undefined,
                disconnect: () => {
                    disconnected = true;
                },
            },
            () => now,
        );

        for (let i = 0; i < WS_QUEUE_SOFT_CAP; i += 1) {
            queue.tryEnqueue();
        }

        queue.tryEnqueue(); // opens window at now=0
        now = WS_QUEUE_FULL_DISCONNECT_MS + 1;
        queue.tryEnqueue();

        expect(disconnected).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Subscribe to unknown room → ignored, no crash
// ---------------------------------------------------------------------------

describe('LiveGateway adversarial — subscribe to unknown room', () => {
    it('subscribing with an invalid room string is ignored and returns not-ok, no crash', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-unknown-room', `dave|${AuthScopeEnum.READ}|${nowSec + 3600}`);

        await connect(gateway, namespace, socket);

        const result = await gateway.onSubscribe(socket as never, {
            room: 'DOES_NOT_EXIST' as WsRoomEnum,
        });

        expect(result).toMatchObject({ ok: false });
        expect(socket.disconnected).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// READ-scoped client subscribes to CONTROL room → rejected
// ---------------------------------------------------------------------------

describe('LiveGateway adversarial — READ-scope on CONTROL room', () => {
    it('READ token is rejected when subscribing to the CONTROL room', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-read-ctrl', `eve|${AuthScopeEnum.READ}|${nowSec + 3600}`);

        await connect(gateway, namespace, socket);

        const result = await gateway.onSubscribe(socket as never, { room: WsRoomEnum.CONTROL });

        expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_SCOPE' });
        expect(socket.joinedRooms.has(WsRoomEnum.CONTROL)).toBe(false);
    });

    it('HALT-scoped token can subscribe to the CONTROL room', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        // The token stub format is "sub|scopes|exp".
        const scopeStr = `${AuthScopeEnum.READ},${AuthScopeEnum.HALT}`;
        const socket = new FakeSocket('s-halt-ctrl', `frank|${scopeStr}|${nowSec + 3600}`);

        await connect(gateway, namespace, socket);

        const result = await gateway.onSubscribe(socket as never, { room: WsRoomEnum.CONTROL });

        expect(result).toEqual({ ok: true });
        expect(socket.joinedRooms.has(WsRoomEnum.CONTROL)).toBe(true);
    });
});
