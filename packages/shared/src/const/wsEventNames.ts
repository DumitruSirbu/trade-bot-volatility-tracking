// M10 W0 — WebSocket event names (ADR 0023 §2.2). Centralised so the dashboard
// and engine share the exact same string literals. Single source of truth for
// event-name auditing across all WS communication.

export const WS_EVENT_NAMES = {
    // Position lifecycle
    positionOpened: 'position.opened',
    positionUpdated: 'position.updated',
    positionClosed: 'position.closed',

    // Decision recording
    decisionRecorded: 'decision.recorded',

    // Account & PnL
    pnlTick: 'pnl.tick',

    // Control & halt
    haltChanged: 'halt.changed',
    riskHaltEngaged: 'risk.halt.engaged',
    modelDivergenceEngaged: 'model.divergence.engaged',

    // Auth & stream health
    authExpired: 'auth.expired',
    streamLagged: 'stream.lagged',
} as const;
