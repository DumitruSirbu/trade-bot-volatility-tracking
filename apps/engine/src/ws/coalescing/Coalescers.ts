import { IOpenPositionView, IPnlTickEvent } from '@bot/shared';

import { IClockMs, WS_PNL_THROTTLE_MS, WS_POSITION_COALESCE_MS } from '../WsConstants';

// M9 W5 (ADR 0023 §2.4). Two coalescing primitives bundled together to stay
// inside the W5 file-budget (per the brief: "combine into one file Coalescers.ts
// if needed"). Both are pure timing helpers — no socket.io, no NestJS DI;
// the gateway owns one instance per socket and feeds them via callbacks.
//
// Decisions + halt events are intentionally NOT coalesced (ADR 0023 §2.4 —
// every one matters); they bypass these primitives.
//
// Clock injected so tests can fast-forward without `jest.useFakeTimers`. The
// `IClockMs` alias is sourced from `../WsConstants` so the WS layer has a
// single canonical definition.

// ---------------------------------------------------------------------------
// PnL throttle — emit at most 1 message per WS_PNL_THROTTLE_MS window per
// socket, keep-latest within the window.
// ---------------------------------------------------------------------------

// M10 W0.5 — local IPnlTickPayload was replaced by @bot/shared's IPnlTickEvent
// (shapes are identical; bot-shared-maintainer verified at W0). The alias keeps
// existing imports compiling without churn while the WS payload type is the
// single shared definition.
export type IPnlTickPayload = IPnlTickEvent;

export class PnlThrottle {
    private lastEmittedAtMs: number | null = null;

    private pendingPayload: IPnlTickEvent | null = null;

    private pendingTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly clock: IClockMs,
        private readonly emit: (payload: IPnlTickEvent) => void,
    ) {}

    offer(payload: IPnlTickEvent): void {
        const now = this.clock();

        if (this.lastEmittedAtMs === null || now - this.lastEmittedAtMs >= WS_PNL_THROTTLE_MS) {
            this.emit(payload);
            this.lastEmittedAtMs = now;
            this.pendingPayload = null;

            return;
        }

        // Inside the throttle window — overwrite the pending payload (latest
        // wins) and schedule a single flush at the window boundary.
        this.pendingPayload = payload;

        if (this.pendingTimer === null) {
            const delayMs = WS_PNL_THROTTLE_MS - (now - this.lastEmittedAtMs);

            this.pendingTimer = setTimeout(
                () => {
                    this.pendingTimer = null;

                    if (this.pendingPayload !== null) {
                        this.emit(this.pendingPayload);
                        this.lastEmittedAtMs = this.clock();
                        this.pendingPayload = null;
                    }
                },
                Math.max(0, delayMs),
            );

            if (typeof this.pendingTimer.unref === 'function') {
                this.pendingTimer.unref();
            }
        }
    }

    // Test seam — production never calls this; the gateway calls it on
    // socket disconnect to release the timer.
    cancel(): void {
        if (this.pendingTimer !== null) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }

        this.pendingPayload = null;
    }

    snapshot(): { hasPending: boolean; lastEmittedAtMs: number | null } {
        return { hasPending: this.pendingPayload !== null, lastEmittedAtMs: this.lastEmittedAtMs };
    }
}

// ---------------------------------------------------------------------------
// Position coalescer — drop intermediate `position.updated` messages within a
// WS_POSITION_COALESCE_MS window per positionId, keep-latest.
// ---------------------------------------------------------------------------

interface IPendingPositionUpdate {
    payload: IOpenPositionView;
    timer: NodeJS.Timeout;
}

export class PositionCoalescer {
    private readonly pending = new Map<string, IPendingPositionUpdate>();

    constructor(private readonly emit: (payload: IOpenPositionView) => void) {}

    // Offer a position update. If no flush is scheduled for `positionId`,
    // schedule one for WS_POSITION_COALESCE_MS from now. If one is already
    // scheduled, overwrite the pending payload (latest wins) and let the
    // existing timer fire.
    offer(payload: IOpenPositionView): void {
        const positionId = payload.id;
        const existing = this.pending.get(positionId);

        if (existing !== undefined) {
            existing.payload = payload;

            return;
        }

        const timer = setTimeout(() => {
            const pending = this.pending.get(positionId);

            this.pending.delete(positionId);

            if (pending !== undefined) {
                this.emit(pending.payload);
            }
        }, WS_POSITION_COALESCE_MS);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.pending.set(positionId, { payload, timer });
    }

    // Force-flush all pending updates synchronously. Called on socket
    // disconnect so the last-known state is not silently dropped if the
    // socket is reconnecting / the operator is closing the dashboard tab.
    flushAll(): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            this.emit(entry.payload);
        }

        this.pending.clear();
    }

    cancel(): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
        }

        this.pending.clear();
    }

    snapshot(): { pendingCount: number; pendingIds: string[] } {
        return { pendingCount: this.pending.size, pendingIds: Array.from(this.pending.keys()) };
    }
}
