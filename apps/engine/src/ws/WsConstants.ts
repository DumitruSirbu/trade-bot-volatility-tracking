// M9 W5 (ADR 0023). Tunables for the live WS gateway. Centralised so
// reviewers + operators see every knob in one place (conventions §Constants
// Placement) and so tests can import the exact same numbers the production
// code uses.

// Socket.io namespace. Per ADR 0023 §2.1 the gateway lives at `/live` so the
// dashboard can mount it alongside future namespaces (e.g. `/admin`) without
// path collisions on the same HTTP port.
export const LIVE_NAMESPACE = '/live';

// Inbound event ids. Only `subscribe` + `unsubscribe` are honoured — anything
// else is logged-warn + ignored (ADR 0023 §2.5, read-only invariant).
export const WS_EVENT_SUBSCRIBE = 'subscribe';
export const WS_EVENT_UNSUBSCRIBE = 'unsubscribe';

// Outbound system-event ids. Sent on the CONTROL room regardless of whether
// the client subscribed (ADR 0023 §2.3) so a slow / silent client still sees
// auth + backpressure signals.
export const WS_EVENT_AUTH_ERROR = 'auth.error';
export const WS_EVENT_AUTH_EXPIRED = 'auth.expired';
export const WS_EVENT_STREAM_LAGGED = 'stream.lagged';

// Outbound room event ids. Pinned here (not inline) so emitters + the test
// harness import the same string.
export const WS_EVENT_POSITION_OPENED = 'position.opened';
export const WS_EVENT_POSITION_UPDATED = 'position.updated';
export const WS_EVENT_POSITION_CLOSED = 'position.closed';
export const WS_EVENT_DECISION_RECORDED = 'decision.recorded';
export const WS_EVENT_PNL_TICK = 'pnl.tick';
export const WS_EVENT_HALT_CHANGED = 'halt.changed';
export const WS_EVENT_RISK_HALT_ENGAGED = 'risk.halt.engaged';
export const WS_EVENT_MODEL_DIVERGENCE_ENGAGED = 'model.divergence.engaged';

// Backpressure caps (ADR 0023 §2.4). Soft cap triggers `stream.lagged` + drop
// oldest; hard cap (or sustained queue-full beyond the disconnect timeout)
// triggers a slow-client disconnect with reason `BACKPRESSURE`.
export const WS_QUEUE_SOFT_CAP = 256;
export const WS_QUEUE_HARD_CAP = 1024;
export const WS_QUEUE_FULL_DISCONNECT_MS = 10_000;

// Coalescing windows (ADR 0023 §2.4).
//
// PnL ticks throttle to at most 1Hz: the dashboard renders an equity figure,
// not an audit trail, so dropping intermediate ticks within a 1s window is a
// fidelity-vs-bandwidth tradeoff we accept.
//
// Position updates coalesce by positionId within a 200ms window with
// keep-latest semantics (per the W5 brief; ADR 0023 §2.4 documents 250ms —
// the brief overrides, and tests pin 200ms). Decisions + halt events are
// NEVER coalesced (every one matters).
export const WS_PNL_THROTTLE_MS = 1_000;
export const WS_POSITION_COALESCE_MS = 200;

// Re-auth sweeper cadence + safety lead time (ADR 0023 §2.3). Sockets whose
// `IAuthSubject.exp` <= now are kicked with `auth.expired` + clean close.
export const WS_AUTH_SWEEPER_INTERVAL_MS = 30_000;

// M9 R1 #5 — single canonical injected-clock alias for the WS layer.
// Previously redeclared in `coalescing/Coalescers.ts` and
// `backpressure/PerSocketQueue.ts`; centralising here removes the duplicate
// and makes any future widening (e.g. to a richer `IClock`) a one-line change.
export type IClockMs = () => number;
