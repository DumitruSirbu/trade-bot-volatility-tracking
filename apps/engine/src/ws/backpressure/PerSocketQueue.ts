import { Logger } from '@nestjs/common';

import {
    IClockMs,
    WS_EVENT_STREAM_LAGGED,
    WS_QUEUE_FULL_DISCONNECT_MS,
    WS_QUEUE_HARD_CAP,
    WS_QUEUE_SOFT_CAP,
} from '../WsConstants';

// M9 W5 (ADR 0023 §2.4). Bounded per-socket outbound queue with three layers
// of backpressure:
//
//   1. Soft cap (`WS_QUEUE_SOFT_CAP`): drop oldest + emit a single
//      `stream.lagged` notice so the dashboard knows to refetch via REST.
//   2. Hard cap (`WS_QUEUE_HARD_CAP`): immediate slow-client disconnect.
//   3. Sustained queue-full (`WS_QUEUE_FULL_DISCONNECT_MS`): if the queue has
//      been at/above the soft cap continuously for the timeout, disconnect
//      regardless of the hard cap (a chronically slow client we don't trust
//      to recover).
//
// The queue does NOT take ownership of socket.io's internal write buffer; it
// is an *application-level* counter the gateway consults before calling
// `socket.emit(...)`. When `tryEnqueue` returns true the caller may emit;
// when it returns false the caller must skip. `markFlushed` decrements the
// counter as the socket.io adapter drains. This keeps backpressure observable
// in tests without monkey-patching the socket.
//
// Clock injected so the disconnect-timer test can advance time deterministically.
// `IClockMs` lives in `../WsConstants` — single source of truth for the layer.

export interface IQueueOwner {
    readonly socketId: string;
    emit(event: string, payload: unknown): void;
    disconnect(close: boolean): void;
}

export class PerSocketQueue {
    private readonly logger: Logger;

    private depth = 0;

    private droppedSinceLastNotice = 0;

    private queueFullStartedAtMs: number | null = null;

    private laggedNoticeSentAt: number | null = null;

    constructor(private readonly owner: IQueueOwner, private readonly clock: IClockMs) {
        this.logger = new Logger(`PerSocketQueue[${owner.socketId}]`);
    }

    // Returns true if the caller should proceed with `socket.emit(...)`.
    // Returns false if the caller must skip the emit (queue full + oldest
    // already dropped, or socket already disconnected).
    tryEnqueue(): boolean {
        // Hard cap — disconnect immediately. No further `stream.lagged` notice
        // because the disconnect itself is the signal.
        if (this.depth >= WS_QUEUE_HARD_CAP) {
            this.disconnectBackpressure('queue.hardCapHit');

            return false;
        }

        if (this.depth >= WS_QUEUE_SOFT_CAP) {
            this.beginQueueFullIfNeeded();
            this.droppedSinceLastNotice += 1;
            this.maybeEmitLagged();

            // Sustained queue-full beyond the timeout — disconnect even
            // though we haven't hit the hard cap. Catches the chronically
            // slow client.
            if (this.queueFullDurationExceeded()) {
                this.disconnectBackpressure('queue.sustainedFull');

                return false;
            }

            // Soft-cap dropped this message (drop-oldest semantics: the
            // caller's new message is the "oldest" we drop because we never
            // actually enqueued it; the effect is the same — bounded depth).
            return false;
        }

        // Below the soft cap — clear any pending queue-full window.
        this.queueFullStartedAtMs = null;
        this.depth += 1;

        return true;
    }

    // The gateway calls this after socket.io's adapter has flushed a message
    // off the wire (or, in test, after the synchronous emit returns). Pure
    // accounting; never emits.
    markFlushed(): void {
        if (this.depth > 0) {
            this.depth -= 1;
        }

        if (this.depth < WS_QUEUE_SOFT_CAP) {
            // R1 fix wave #6 (L10): explicit reset of the lagged-notice marker
            // when the queue-full window closes. The prior logic happened to
            // work because `maybeEmitLagged` only re-checks `laggedNoticeSentAt`
            // relative to the current `queueFullStartedAtMs`, but the
            // dependency was non-obvious. An explicit reset removes the
            // implicit invariant and lets the next queue-full window emit a
            // fresh `stream.lagged`.
            this.queueFullStartedAtMs = null;
            this.laggedNoticeSentAt = null;
        }
    }

    // Test seam — production code never reads this; tests assert on it.
    snapshot(): { depth: number; dropped: number; queueFullSinceMs: number | null } {
        return {
            depth: this.depth,
            dropped: this.droppedSinceLastNotice,
            queueFullSinceMs: this.queueFullStartedAtMs,
        };
    }

    private beginQueueFullIfNeeded(): void {
        if (this.queueFullStartedAtMs === null) {
            this.queueFullStartedAtMs = this.clock();
        }
    }

    private queueFullDurationExceeded(): boolean {
        if (this.queueFullStartedAtMs === null) {
            return false;
        }

        return this.clock() - this.queueFullStartedAtMs >= WS_QUEUE_FULL_DISCONNECT_MS;
    }

    private maybeEmitLagged(): void {
        // Single `stream.lagged` notice per queue-full window. The dashboard
        // refetches REST on receipt; further notices in the same window add
        // no information (and would themselves contribute to backpressure).
        if (this.laggedNoticeSentAt !== null && this.queueFullStartedAtMs !== null && this.laggedNoticeSentAt >= this.queueFullStartedAtMs) {
            return;
        }

        const sinceMs = this.queueFullStartedAtMs === null ? 0 : Math.max(0, this.clock() - this.queueFullStartedAtMs);

        try {
            this.owner.emit(WS_EVENT_STREAM_LAGGED, {
                droppedCount: this.droppedSinceLastNotice,
                sinceMs,
            });
            this.laggedNoticeSentAt = this.clock();
        } catch (cause) {
            this.logger.warn(`stream.lagged emit failed: ${describe(cause)}`);
        }
    }

    private disconnectBackpressure(reason: string): void {
        this.logger.warn(`ws.backpressure.disconnect reason=${reason} depth=${this.depth}`);

        try {
            this.owner.disconnect(true);
        } catch (cause) {
            this.logger.warn(`ws.backpressure.disconnect failed: ${describe(cause)}`);
        }
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
