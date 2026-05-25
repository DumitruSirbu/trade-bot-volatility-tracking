import { AuthFailureReasonEnum, IAuthFailure, IAuthSubject } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { WsAuthHandshake as CryptoHandshake, IRevokedJtiRepositoryPort, REVOKED_JTI_REPOSITORY } from '../../auth/AuthModule';
import { WS_AUTH_SWEEPER_INTERVAL_MS, WS_EVENT_AUTH_EXPIRED } from '../WsConstants';

// M9 W5 (ADR 0020 §2.5 + ADR 0023 §2.3).
//
// Wraps the AuthModule's `WsAuthHandshake` (pure crypto verify) for socket.io's
// handshake signature, layers the `revoked_jti` check on top, and ships the
// 30s sweeper that closes sockets within 5s of `exp`.
//
// Why separate from the AuthModule helper: the AuthModule's helper is
// transport-agnostic (returns `IAuthSubject | IAuthFailure` from a raw
// string). This adapter knows about socket.io semantics (`handshake.auth`,
// `disconnect(true)`, emitting `auth.expired` on the control room) and so
// belongs in `ws/auth/` per single-responsibility.
//
// Clock is injected so the sweeper test can advance time without `jest.useFakeTimers`
// — production wiring binds to `() => Date.now()`.

export interface ISweeperSocket {
    readonly id: string;
    readonly data: { subject?: IAuthSubject };
    emit(event: string, payload: unknown): void;
    disconnect(close: boolean): void;
}

export interface ISweeperSocketSource {
    listSockets(): Iterable<ISweeperSocket>;
}

export type IClockMs = () => number;

export const WS_CLOCK = Symbol('WS_CLOCK');

@Injectable()
export class WsAuthAdapter implements OnModuleDestroy {
    private readonly logger = new Logger(WsAuthAdapter.name);

    private sweeper: NodeJS.Timeout | null = null;

    private socketSource: ISweeperSocketSource | null = null;

    constructor(
        private readonly crypto: CryptoHandshake,
        @Inject(REVOKED_JTI_REPOSITORY) private readonly revoked: IRevokedJtiRepositoryPort,
        @Inject(WS_CLOCK) private readonly clock: IClockMs,
    ) {}

    // Verifies the handshake bearer. Returns the subject on success, or an
    // `IAuthFailure` (never throws — the gateway chooses how to surface).
    // Layers a `revoked_jti` check on top of the crypto verify so a revoked
    // token cannot open a new socket even within its `exp` window.
    async verifyHandshake(rawToken: string | undefined | null): Promise<IAuthSubject | IAuthFailure> {
        if (typeof rawToken !== 'string' || rawToken.length === 0) {
            return { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.MISSING };
        }

        const verified = this.crypto.verify(rawToken);

        if ('error' in verified) {
            return verified;
        }

        if (await this.revoked.isRevoked(verified.jti)) {
            return { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.REVOKED };
        }

        return verified;
    }

    // The gateway calls this once at boot, supplying a lambda that returns the
    // live socket list (typically `server.of('/live').sockets.values()`). The
    // sweeper walks every connected socket on each tick; sockets whose
    // `subject.exp` <= now (in seconds) are kicked.
    startSweeper(source: ISweeperSocketSource): void {
        if (this.sweeper !== null) {
            return;
        }

        this.socketSource = source;
        this.sweeper = setInterval(() => {
            this.sweepOnce();
        }, WS_AUTH_SWEEPER_INTERVAL_MS);

        // setInterval keeps the event loop alive; in tests this would block
        // `globalTeardown`. Unref so the process can exit cleanly.
        if (typeof this.sweeper.unref === 'function') {
            this.sweeper.unref();
        }
    }

    // Exposed for tests + paranoid manual probes. Walks the live socket list
    // once and kicks any expired socket. Idempotent on a clean run.
    sweepOnce(): void {
        if (this.socketSource === null) {
            return;
        }

        const nowSec = Math.floor(this.clock() / 1000);

        for (const socket of this.socketSource.listSockets()) {
            const subject = socket.data.subject;

            if (subject === undefined) {
                continue;
            }

            if (subject.exp <= nowSec) {
                this.kickExpired(socket);
            }
        }
    }

    private kickExpired(socket: ISweeperSocket): void {
        this.logger.warn(`ws.auth.expired socketId=${socket.id} sub=${socket.data.subject?.sub ?? '-'}`);

        try {
            socket.emit(WS_EVENT_AUTH_EXPIRED, { reason: AuthFailureReasonEnum.EXPIRED });
        } catch (cause) {
            this.logger.warn(`ws.auth.expired emit failed: ${describe(cause)}`);
        }

        // disconnect(true) closes the underlying transport; the client sees a
        // clean disconnect event rather than a TCP RST.
        socket.disconnect(true);
    }

    onModuleDestroy(): void {
        if (this.sweeper !== null) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
