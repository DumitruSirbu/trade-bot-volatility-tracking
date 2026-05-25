# ADR 0023 — WS/SSE gateway: transport, topology, auth, backpressure (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0020 (auth + WS re-validation), ADR 0021 (halt state), ADR 0022 (DTO shapes).
**Consumed by:** M10 (dashboard client).

## 1. Context

The dashboard needs live updates for positions, PnL, decisions, halt-state transitions, and alerts. The dashboard agent contract (per `M10-dashboard.md`) consumes a WS feed; we lock the gateway here so M9 W4 ships a contract M10 can build against without churn.

## 2. Decision

### 2.1 Transport: socket.io

Socket.io over WebSocket primary, long-polling fallback for hostile networks. Chosen over raw `ws` and SSE for three reasons:

1. **Bidirectional handshake with structured `auth` payload** — natural fit for ADR 0020's bearer-in-handshake.
2. **Built-in rooms** map cleanly to the per-channel topology in §2.2.
3. **Heartbeats + auto-reconnect** ship for free; the client (M10) gets resilient connection logic without bespoke code.

SSE was considered for its simplicity but rejected: re-auth on expiry requires server-initiated close + client reconnect, which SSE handles awkwardly (no clean way to signal "reauthenticate" inside the event stream).

NestJS provides `@nestjs/platform-socket.io` and `@WebSocketGateway`; verified current via Context7 prior to ADR.

### 2.2 Channel topology

Four logical channels, exposed as socket.io **rooms** (clients subscribe explicitly post-handshake):

| Room | Event names | Payload | Source |
|---|---|---|---|
| `positions` | `position.opened`, `position.updated`, `position.closed` | `IOpenPositionView` / `IClosedPositionView` (ADR 0022) | M6 instrumentor + state-machine events |
| `decisions` | `decision.recorded` | `IDecisionView` (ADR 0022) | M3 orchestrator post-write |
| `pnl` | `pnl.tick` | `{ asOf, equityUsd, openExposureUsd, unrealizedPnlUsd }` | 5s aggregator over `positions` + latest price ticks |
| `control` | `halt.changed`, `risk.halt.engaged`, `model.divergence.engaged`, `auth.expired` | `IKillSwitchState` / `IRiskHaltEvent` / `IModelDivergenceEvent` / `{ reason }` | Halt-flag listener, M4 surfaces, ADR 0020 §2.5 |

Clients subscribe via `socket.emit('subscribe', { room: 'positions' })`. Server validates `scope=read` is present (control-plane mutations stay HTTP — §2.5). Wildcard subscriptions are NOT supported (force the client to opt in per room, easier to audit).

### 2.3 Auth on handshake + re-validation

Per ADR 0020 §2.5:

- handshake: `io({ auth: { token: '<bearer>' } })`; server `connection` handler verifies and attaches `IAuthSubject` to the socket;
- re-validation: pre-emit check + 30s sweeper closing sockets within 5s of `exp`;
- on expiry/revocation, server emits `auth.expired` (on the `control` room, even if the client never subscribed — it's a system event) and calls `socket.disconnect(true)` after a 100ms flush window.

### 2.4 Backpressure

Three layers, top-down:

1. **Per-room coalescing.** `pnl.tick` is published at most once per second per client even if upstream produces 10/s — the gateway holds a 1-Hz throttle ring per socket. `position.updated` is coalesced per `positionId` within a 250ms window (latest-wins) — operators don't need every intermediate price tick on a long-held position. Decisions and halt events are NOT coalesced (every one matters).
2. **Per-socket queue cap.** Each socket's outbound queue is capped at 256 messages. On overflow, the gateway drops oldest and emits a single `stream.lagged { droppedCount, sinceMs }` on the `control` room so the client can refetch via REST. No silent loss.
3. **Slow-client disconnect.** If a socket's queue stays full for 10s, the gateway disconnects it with reason `BACKPRESSURE`. Client reconnects via socket.io's normal flow.

### 2.5 Read-only channel; no control over WS

The WS gateway **publishes only**. Inbound messages allowed: `subscribe`, `unsubscribe`, `ping`. Any other event id → ignored + counted in a metric. Halt, resume, revoke remain on HTTP per ADR 0021 §2.1 — single auditable control plane.

### 2.6 CORS

Socket.io `cors.origin` uses the same `AUTH_CORS_ORIGINS` env list as REST (ADR 0020 §2.3). Default-deny.

### 2.7 Failure modes

| Cause | Server behavior | Client guidance |
|---|---|---|
| Bad/missing token at handshake | Reject `connection` with `AUTH_FAILED` | Re-issue token, retry |
| Token expired mid-stream | Emit `auth.expired`, disconnect | Re-issue token, reconnect |
| `revoked_jti` hit mid-stream | Same as expired | Same |
| Backpressure overflow | Emit `stream.lagged` once, drop oldest | Refetch REST snapshot |
| Slow-client (10s queue full) | Disconnect with `BACKPRESSURE` | Reconnect, refetch REST snapshot |
| Server restart | All sockets dropped | Reconnect; the WS does not promise at-least-once delivery — REST is the source of truth |

## 3. Consequences

- One transport (socket.io) for all live updates — the dashboard does not maintain two stacks (WS + SSE).
- Backpressure is explicit and observable (`stream.lagged`) rather than silent — operator sees gaps if they happen.
- The WS surface is **strictly a side-channel**: every payload is a re-shape of a persisted row (or a snapshot of a persisted state machine). Loss of the WS never loses data — the REST API holds the truth.
- Re-auth on expiry is enforced at three points (handshake, pre-emit, sweeper) so the "no infinite stream on one token" invariant holds even under odd timing.

## 4. Alternatives considered

- **Raw `ws` + custom protocol.** Rejected: heartbeats, reconnect, rooms, and fallback transport are all features we'd build by hand. The bug surface lives in custom plumbing.
- **SSE.** Rejected: server-initiated re-auth is awkward, no native rooms, browser concurrent-connection limits per origin bite when the dashboard also calls REST.
- **GraphQL subscriptions.** Rejected for the same reason GraphQL itself was — over-engineered for one operator, one dashboard.
- **At-least-once delivery with per-message ack.** Rejected: dashboard is a read-only view, not an event log. Loss-tolerant + REST-as-source-of-truth is simpler and correct.
- **WS as control channel for halt.** Rejected per ADR 0021 §4 — single auditable control plane stays HTTP.
- **No coalescing — push every tick.** Rejected: a busy session would saturate a slow operator network and starve genuine state changes (decisions, halts).
