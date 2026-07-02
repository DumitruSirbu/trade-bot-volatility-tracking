// M10 W0 — Read API paths (ADR 0022). Centralised so the dashboard
// never hard-codes URL strings. Single source of truth for path auditing
// when /v2/ lands in a future milestone.

export const READ_API_BASE = '/v1' as const;

export const READ_API_PATHS = {
    health: `${READ_API_BASE}/health`,
    authLogin: `${READ_API_BASE}/auth/login`,
    authRevoke: `${READ_API_BASE}/auth/revoke`,
    controlHalt: `${READ_API_BASE}/control/halt`,
    controlHaltHistory: `${READ_API_BASE}/control/halt/history`,
    controlResume: `${READ_API_BASE}/control/resume`,
    controlTriggerRebalance: `${READ_API_BASE}/control/trigger-rebalance`,
    positionsOpen: `${READ_API_BASE}/positions/open`,
    positionsClosed: `${READ_API_BASE}/positions/closed`,
    positionById: (id: string) => `${READ_API_BASE}/positions/${id}`,
    decisionsRecent: `${READ_API_BASE}/decisions`,
    accountEquity: `${READ_API_BASE}/account/equity`,
    performanceByVersion: `${READ_API_BASE}/performance/by-version`,
    performanceDailySeries: `${READ_API_BASE}/performance/daily-series`,
    performanceShadowSummary: `${READ_API_BASE}/performance/shadow-summary`,
    riskState: `${READ_API_BASE}/risk/state`,
} as const;
