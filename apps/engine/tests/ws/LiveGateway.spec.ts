import { AuthFailureReasonEnum, AuthScopeEnum, IAuthSubject, PositionSideEnum, PositionStateEnum, ProtectiveOrderTypeEnum, WsRoomEnum } from '@bot/shared';

import { Money } from '../../src/common/utils/money';
import { IPositionOpenedEvent } from '../../src/common/interface/IPositionOpenedEvent';
import { LiveGateway } from '../../src/ws/LiveGateway';
import {
    LIVE_NAMESPACE,
    WS_EVENT_AUTH_ERROR,
    WS_EVENT_AUTH_EXPIRED,
    WS_EVENT_POSITION_OPENED,
    WS_EVENT_POSITION_UPDATED,
    WS_EVENT_STREAM_LAGGED,
    WS_EVENT_SUBSCRIBE,
    WS_PNL_THROTTLE_MS,
    WS_POSITION_COALESCE_MS,
    WS_QUEUE_FULL_DISCONNECT_MS,
    WS_QUEUE_SOFT_CAP,
} from '../../src/ws/WsConstants';
import { ISweeperSocketSource, WsAuthAdapter } from '../../src/ws/auth/WsAuthHandshake';
import { PerSocketQueue } from '../../src/ws/backpressure/PerSocketQueue';
import { PnlThrottle, PositionCoalescer } from '../../src/ws/coalescing/Coalescers';
import { PositionEntity } from '../../src/position/entity';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { AuthTokenService, WsAuthHandshake } from '../../src/auth/AuthModule';
import type { IRevokedJtiRepositoryPort } from '../../src/auth/AuthModule';

// M9 W5 — adversarial spec for the live WS gateway. Uses in-memory stub
// sockets + a fake @nestjs/websockets server so each scenario is a pure
// unit-of-behaviour (no actual socket.io transport). The behaviour under
// test is the gateway's contract: handshake reject, mid-stream expiry,
// slow-client disconnect, coalescing semantics, scope enforcement, and the
// read-only invariant.

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSocket {
    readonly id: string;
    readonly data: { subject?: IAuthSubject } = {};
    readonly handshake: { auth?: { token?: unknown } };
    readonly emitted: Array<{ event: string; payload: unknown }> = [];
    readonly joinedRooms = new Set<string>();
    onAnyHandler: ((event: string, ...args: unknown[]) => void) | null = null;
    disconnected = false;
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
        // not exercised in this spec
    }

    async pruneOlderThan(_cutoff: Date): Promise<number> {
        return 0;
    }

    async countAll(): Promise<number> {
        return this.revokedSet.size;
    }
}

class StubPositionRepository {
    private readonly rows = new Map<number, PositionEntity>();

    seed(position: PositionEntity): void {
        this.rows.set(position.id, position);
    }

    async findById(id: number): Promise<PositionEntity | null> {
        return this.rows.get(id) ?? null;
    }
}

function fakePosition(id: number, overrides: Partial<PositionEntity> = {}): PositionEntity {
    const base: Partial<PositionEntity> = {
        id,
        symbol: 'BTCUSDT',
        strategyVersionId: 1,
        side: PositionSideEnum.LONG,
        state: PositionStateEnum.OPEN,
        leverage: new Money(2),
        entryPrice: new Money(50_000),
        qty: new Money(1),
        openedAt: new Date('2026-05-01T00:00:00Z'),
        protectiveOrderType: ProtectiveOrderTypeEnum.EXCHANGE_SIDE,
        ...overrides,
    };

    return base as PositionEntity;
}

function buildOpenedEvent(positionId: number): IPositionOpenedEvent {
    return {
        positionId,
        symbol: 'BTCUSDT',
        side: PositionSideEnum.LONG,
        leverage: new Money(2),
        entryPrice: new Money(50_000),
        entryNotional: new Money(50_000),
        strategyVersionId: 1,
    };
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

function buildGateway(opts: { revoked?: StubRevokedRepo; positions?: StubPositionRepository; clock?: () => number }): {
    gateway: LiveGateway;
    server: FakeServer;
    namespace: FakeNamespace;
    adapter: WsAuthAdapter;
} {
    const revoked = opts.revoked ?? new StubRevokedRepo();
    const positions = opts.positions ?? new StubPositionRepository();
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
    const gateway = new LiveGateway(adapter, positions as unknown as PositionRepository);
    const server = new FakeServer();

    gateway.setServerForTest(server as unknown as Parameters<LiveGateway['setServerForTest']>[0]);

    // Stand up the namespace and prime the adapter sweeper with our live-socket
    // source so the sweeper test can call sweepOnce against the same map.
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
// Tests
// ---------------------------------------------------------------------------

describe('LiveGateway — handshake', () => {
    it('rejects a socket that arrives with no auth token', async () => {
        const { gateway, namespace } = buildGateway({});
        const socket = new FakeSocket('s1', undefined);

        await connect(gateway, namespace, socket);

        expect(socket.disconnected).toBe(true);
        expect(socket.forceClose).toBe(true);
        const rejection = socket.emitted.find((e) => e.event === WS_EVENT_AUTH_ERROR);

        expect(rejection).toBeDefined();
        expect((rejection!.payload as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.MISSING);
    });

    it('rejects a socket whose token jti is revoked', async () => {
        const revoked = new StubRevokedRepo();

        revoked.revokedSet.add('jti-alice');
        const { gateway, namespace } = buildGateway({ revoked });
        const socket = new FakeSocket('s2', `alice|${AuthScopeEnum.READ}|${Math.floor(Date.now() / 1000) + 3_600}`);

        await connect(gateway, namespace, socket);

        expect(socket.disconnected).toBe(true);
        const rejection = socket.emitted.find((e) => e.event === WS_EVENT_AUTH_ERROR);

        expect((rejection!.payload as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.REVOKED);
    });

    it('rejects a malformed token without crashing', async () => {
        const { gateway, namespace } = buildGateway({});
        const socket = new FakeSocket('s3', 'malformed');

        await connect(gateway, namespace, socket);

        expect(socket.disconnected).toBe(true);
    });
});

describe('LiveGateway — re-auth sweeper', () => {
    it('emits auth.expired and disconnects sockets whose exp has passed', async () => {
        let nowMs = 1_000_000_000_000;

        const { gateway, namespace, adapter } = buildGateway({ clock: () => nowMs });
        const nowSec = Math.floor(nowMs / 1000);
        const socket = new FakeSocket('s-expire', `bob|${AuthScopeEnum.READ}|${nowSec + 60}`);

        await connect(gateway, namespace, socket);

        expect(socket.disconnected).toBe(false);

        // Advance the clock past exp + run the sweeper once.
        nowMs += 120_000;
        adapter.sweepOnce();

        expect(socket.emitted.find((e) => e.event === WS_EVENT_AUTH_EXPIRED)).toBeDefined();
        expect(socket.disconnected).toBe(true);
    });
});

describe('LiveGateway — subscribe scope enforcement', () => {
    it('rejects CONTROL room subscription from a READ-only token', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-read', `carol|${AuthScopeEnum.READ}|${nowSec + 3_600}`);

        await connect(gateway, namespace, socket);
        const result = await gateway.onSubscribe(socket as unknown as Parameters<LiveGateway['onSubscribe']>[0], {
            room: WsRoomEnum.CONTROL,
        });

        expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_SCOPE' });
        expect(socket.joinedRooms.has(WsRoomEnum.CONTROL)).toBe(false);
    });

    it('admits POSITIONS room subscription from a READ token', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-read2', `dave|${AuthScopeEnum.READ}|${nowSec + 3_600}`);

        await connect(gateway, namespace, socket);
        const result = await gateway.onSubscribe(socket as unknown as Parameters<LiveGateway['onSubscribe']>[0], {
            room: WsRoomEnum.POSITIONS,
        });

        expect(result).toEqual({ ok: true });
        expect(socket.joinedRooms.has(WsRoomEnum.POSITIONS)).toBe(true);
    });
});

describe('LiveGateway — read-only enforcement', () => {
    it('logs + ignores unsupported inbound events; never invokes a handler', async () => {
        const { gateway, namespace } = buildGateway({});
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-cmd', `eve|${AuthScopeEnum.READ}|${nowSec + 3_600}`);

        await connect(gateway, namespace, socket);

        // Simulate the client firing a rogue control-channel command via socket.io's onAny.
        expect(socket.onAnyHandler).not.toBeNull();
        socket.onAnyHandler!('halt.engage', { reason: 'panic' });

        // No emit back, no disconnect, no state change.
        expect(socket.disconnected).toBe(false);
        expect(socket.emitted.filter((e) => e.event !== 'subscribe' && e.event !== 'unsubscribe')).toHaveLength(0);
    });
});

describe('LiveGateway — broadcast to room', () => {
    it('emits position.opened to sockets in the POSITIONS room', async () => {
        const positions = new StubPositionRepository();

        positions.seed(fakePosition(42));
        const { gateway, namespace } = buildGateway({ positions });
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-pos', `frank|${AuthScopeEnum.READ}|${nowSec + 3_600}`);

        await connect(gateway, namespace, socket);
        await gateway.onSubscribe(socket as unknown as Parameters<LiveGateway['onSubscribe']>[0], {
            room: WsRoomEnum.POSITIONS,
        });

        await gateway.onPositionOpened(buildOpenedEvent(42));

        const opened = socket.emitted.find((e) => e.event === WS_EVENT_POSITION_OPENED);

        expect(opened).toBeDefined();
        expect((opened!.payload as { id: string }).id).toBe('42');
    });

    it('skips broadcast to sockets that have not joined the room', async () => {
        const positions = new StubPositionRepository();

        positions.seed(fakePosition(7));
        const { gateway, namespace } = buildGateway({ positions });
        const nowSec = Math.floor(Date.now() / 1000);
        const socket = new FakeSocket('s-no-room', `grace|${AuthScopeEnum.READ}|${nowSec + 3_600}`);

        await connect(gateway, namespace, socket);
        // No subscribe.
        await gateway.onPositionOpened(buildOpenedEvent(7));

        expect(socket.emitted.find((e) => e.event === WS_EVENT_POSITION_OPENED)).toBeUndefined();
    });
});

describe('PerSocketQueue — backpressure', () => {
    it('emits stream.lagged once when the soft cap is breached', () => {
        let now = 0;
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const queue = new PerSocketQueue(
            {
                socketId: 'sq1',
                emit: (event, payload) => emitted.push({ event, payload }),
                disconnect: () => undefined,
            },
            () => now,
        );

        // Fill to the soft cap.
        for (let i = 0; i < WS_QUEUE_SOFT_CAP; i += 1) {
            expect(queue.tryEnqueue()).toBe(true);
        }

        // First over-cap attempt drops + notices.
        expect(queue.tryEnqueue()).toBe(false);
        // Second over-cap attempt also drops; should NOT re-notice within the same window.
        expect(queue.tryEnqueue()).toBe(false);

        const lagged = emitted.filter((e) => e.event === WS_EVENT_STREAM_LAGGED);

        expect(lagged).toHaveLength(1);
    });

    it('disconnects the socket once the sustained queue-full timeout elapses', () => {
        let now = 0;
        let disconnected = false;
        const queue = new PerSocketQueue(
            {
                socketId: 'sq2',
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

        // First over-cap attempt opens the queue-full window.
        queue.tryEnqueue();
        expect(disconnected).toBe(false);

        // Advance just under the timeout — still no disconnect.
        now += WS_QUEUE_FULL_DISCONNECT_MS - 1;
        queue.tryEnqueue();
        expect(disconnected).toBe(false);

        // Cross the threshold.
        now += 2;
        queue.tryEnqueue();
        expect(disconnected).toBe(true);
    });
});

describe('PnlThrottle', () => {
    it('emits the first payload immediately, then at most once per throttle window with the latest payload', async () => {
        let now = 0;
        const emitted: Array<{ asOf: string }> = [];
        const throttle = new PnlThrottle(
            () => now,
            (p) => emitted.push({ asOf: p.asOf }),
        );

        throttle.offer({ asOf: 't1', equityUsd: '1', openExposureUsd: '0', unrealizedPnlUsd: '0' });
        expect(emitted).toHaveLength(1);

        // Three more inside the window — only the latest survives.
        throttle.offer({ asOf: 't2', equityUsd: '2', openExposureUsd: '0', unrealizedPnlUsd: '0' });
        throttle.offer({ asOf: 't3', equityUsd: '3', openExposureUsd: '0', unrealizedPnlUsd: '0' });
        throttle.offer({ asOf: 't4', equityUsd: '4', openExposureUsd: '0', unrealizedPnlUsd: '0' });
        expect(emitted).toHaveLength(1);

        // Let the throttle fire its pending payload by walking real time forward.
        await new Promise((resolve) => setTimeout(resolve, WS_PNL_THROTTLE_MS + 50));
        now += WS_PNL_THROTTLE_MS + 50;

        expect(emitted).toHaveLength(2);
        expect(emitted[1].asOf).toBe('t4');

        throttle.cancel();
    });
});

describe('PositionCoalescer', () => {
    it('keeps the latest payload per positionId within the coalesce window', async () => {
        const emitted: Array<{ id: string; entryPrice: string }> = [];
        const coalescer = new PositionCoalescer((p) => emitted.push({ id: p.id, entryPrice: p.entryPrice }));

        coalescer.offer({ id: '1', entryPrice: 'p1' } as Parameters<PositionCoalescer['offer']>[0]);
        coalescer.offer({ id: '1', entryPrice: 'p2' } as Parameters<PositionCoalescer['offer']>[0]);
        coalescer.offer({ id: '1', entryPrice: 'p3' } as Parameters<PositionCoalescer['offer']>[0]);

        // No emission yet — still inside the window.
        expect(emitted).toHaveLength(0);

        await new Promise((resolve) => setTimeout(resolve, WS_POSITION_COALESCE_MS + 50));

        expect(emitted).toHaveLength(1);
        expect(emitted[0].entryPrice).toBe('p3');
    });

    it('coalesces independently per positionId', async () => {
        const emitted: string[] = [];
        const coalescer = new PositionCoalescer((p) => emitted.push(p.id));

        coalescer.offer({ id: 'a' } as Parameters<PositionCoalescer['offer']>[0]);
        coalescer.offer({ id: 'b' } as Parameters<PositionCoalescer['offer']>[0]);

        await new Promise((resolve) => setTimeout(resolve, WS_POSITION_COALESCE_MS + 50));

        expect(emitted.sort()).toEqual(['a', 'b']);
    });
});

describe('LiveGateway — constant exports stay load-bearing', () => {
    it('exports the post-W5 event id set the gateway broadcasts on', () => {
        expect(WS_EVENT_POSITION_UPDATED).toBe('position.updated');
        expect(WS_EVENT_SUBSCRIBE).toBe('subscribe');
    });
});

// M9 hotfix regression — @WebSocketServer() injects a Namespace (not the root
// Server) when @WebSocketGateway declares a `namespace`. Namespace has no
// `.of()` method, so the sweeper's source lambda must iterate
// `this.server.sockets` directly. The W5 FakeServer happened to expose `.of`,
// hiding this; the test below uses a Namespace-shaped stub to lock the fix in.
describe('LiveGateway — liveSockets against a Namespace-shaped server', () => {
    it('iterates server.sockets directly when .of() is absent (namespace injection)', () => {
        const { gateway } = buildGateway({});
        const s1 = new FakeSocket('ns-1', undefined);
        const s2 = new FakeSocket('ns-2', undefined);

        // socket.io Namespace shape — exposes `sockets` Map, no `.of()`.
        const namespaceShaped = {
            sockets: new Map<string, FakeSocket>([
                ['ns-1', s1],
                ['ns-2', s2],
            ]),
        };

        gateway.setServerForTest(namespaceShaped as unknown as Parameters<LiveGateway['setServerForTest']>[0]);

        const iter = (gateway as unknown as { liveSockets(): IterableIterator<{ id: string }> }).liveSockets();
        const ids = Array.from(iter).map((s) => s.id);

        expect(ids.sort()).toEqual(['ns-1', 'ns-2']);
    });

    it('no-ops without throwing when the server is not yet initialised', () => {
        const { gateway } = buildGateway({});

        gateway.setServerForTest(undefined as unknown as Parameters<LiveGateway['setServerForTest']>[0]);

        const iter = (gateway as unknown as { liveSockets(): IterableIterator<unknown> }).liveSockets();

        expect(Array.from(iter)).toEqual([]);
    });
});
