// Paper-only dev/ops route fragments for the momentum rebalance trigger (ADR 0048 §10).
// Pinned here so the controller, CLI, and tests import the same literals.
export const REBALANCE_CONTROL_BASE_PATH = 'v1/control';
export const TRIGGER_REBALANCE_PATH = 'trigger-rebalance';

// `pnpm rebalance:trigger` CLI constants (ADR 0048 §10). Kept here so the CLI and its tests
// import the same literals — no inline magic values in the CLI body.

// TTL of the short-lived admin JWT the CLI mints for the one-shot HTTP call. 120s is ample
// for a local loopback round-trip and short enough to bound exposure if revoke fails.
export const REBALANCE_TRIGGER_ADMIN_TOKEN_TTL_SEC = 120;

// Default engine HTTP port the CLI targets when neither --base-url nor ENGINE_PORT is set.
export const REBALANCE_TRIGGER_DEFAULT_ENGINE_PORT = '3007';

// Exit-code map (consumers grep here):
//   0   success
//   1   runtime failure (HTTP non-2xx, network, unexpected exception)
//   2   bad arguments (missing flag value, non-loopback target host)
export const REBALANCE_TRIGGER_CLI_EXIT_OK = 0;
export const REBALANCE_TRIGGER_CLI_EXIT_RUNTIME = 1;
export const REBALANCE_TRIGGER_CLI_EXIT_BAD_ARGS = 2;

// Loopback hosts the CLI is allowed to send its live admin token to. This is a local dev/ops
// tool — it must never hand a minted admin JWT to a remote or typo'd host.
export const REBALANCE_TRIGGER_ALLOWED_HOSTS: ReadonlyArray<string> = ['127.0.0.1', 'localhost', '::1'];

// HTTP rate limit on POST /v1/control/trigger-rebalance (security review, defense-in-depth). The
// AuthGuard + admin scope is the primary guard; this throttle bounds unauthenticated/invalid-token
// request spam against the endpoint. A tight 1-per-60s window is ample — the scheduler's own
// 5-min emission cooldown already rejects rapid legitimate retriggers downstream.
export const REBALANCE_TRIGGER_RATE_LIMIT = 1;
export const REBALANCE_TRIGGER_RATE_TTL_MS = 60_000;
