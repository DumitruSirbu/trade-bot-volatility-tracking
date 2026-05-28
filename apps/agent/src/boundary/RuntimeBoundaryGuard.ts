// M13 W6 fix wave 1 — runtime boundary guard (ADR 0035 §2.4 layer C).
//
// Mirrors `apps/mcp/src/boundary/RuntimeGuard.ts`. At agent boot, before any
// I/O or client instantiation, scan the loaded-module set for any path whose
// fragment is `/apps/engine/`, `/apps/mcp/`, or `/packages/analysis/`. If any
// match → log a structured FATAL line on stderr and exit(1). The agent must
// be structurally isolated from those workspaces (Layer A in package.json
// + Layer B in ESLint); the runtime guard is defense-in-depth.
//
// ESM caveat: `@bot/agent` emits ESM (`"type": "module"`). Under pure ESM
// `require` is undefined and `require.cache` does not exist — only modules
// loaded via the CJS interop bridge populate it. We mirror the MCP guard's
// approach: best-effort read of `globalThis.require?.cache`. If the cache is
// unavailable we return an empty list — Layer A + Layer B remain the
// compile-time guarantees and this guard is best-effort, not load-bearing.
//
// Boundary invariant: this file imports only Node built-ins (and not even
// those). It must NOT import from @bot/engine, @bot/mcp, @bot/analysis, or
// any sibling agent module — keeping the guard dependency-free protects
// against a buggy import chain pulling banned code BEFORE the guard runs.

const BANNED_PATH_FRAGMENTS: readonly string[] = ['/apps/engine/', '/apps/mcp/', '/packages/analysis/'];
const ESCAPE_HATCH_ENV_VAR = 'AGENT_BOUNDARY_GUARD';
const ESCAPE_HATCH_VALUE = 'disabled';

export interface IRuntimeBoundaryGuardDeps {
    /** Defaults to Node's `require.cache` keys (CJS) or `[]` under pure ESM. */
    getLoadedModulePaths?: () => readonly string[];
    /** Defaults to `(code) => process.exit(code)`. Overridable in tests. */
    exit?: (code: number) => never;
    /** Defaults to `console.error`. Stderr only. */
    logError?: (message: string) => void;
    /** Defaults to `console.warn`. Stderr only. */
    logWarn?: (message: string) => void;
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

function defaultGetLoadedModulePaths(): readonly string[] {
    const cache: Record<string, unknown> | undefined = (globalThis as { require?: { cache?: Record<string, unknown> } }).require?.cache;
    if (cache !== undefined && typeof cache === 'object') {
        return Object.keys(cache);
    }
    return [];
}

/**
 * Asserts that no module from `apps/engine/`, `apps/mcp/`, or `packages/analysis/`
 * is loaded in this process. Calls `exit(1)` on violation; returns normally on
 * success. Under pure ESM the require-cache probe returns no paths, in which
 * case a single warn line is logged so the operator sees the no-op fallback.
 *
 * Set `AGENT_BOUNDARY_GUARD=disabled` ONLY in tests of the guard itself. A
 * warning is logged when bypassed so the operator notices a misconfigured
 * production process.
 */
export function runBoundaryGuard(deps: IRuntimeBoundaryGuardDeps = {}): void {
    const env = deps.env ?? process.env;
    const logError =
        deps.logError ??
        ((msg: string): void => {
            console.error(msg);
        });
    const logWarn =
        deps.logWarn ??
        ((msg: string): void => {
            console.warn(msg);
        });
    const exit = deps.exit ?? ((code: number): never => process.exit(code));

    if (env[ESCAPE_HATCH_ENV_VAR] === ESCAPE_HATCH_VALUE) {
        logWarn(
            `[agent:boundary] WARNING: ${ESCAPE_HATCH_ENV_VAR}=${ESCAPE_HATCH_VALUE} — boundary guard bypassed. This is only valid in tests of the guard itself (ADR 0035 §2.4 layer C).`,
        );
        return;
    }

    const getLoadedModulePaths = deps.getLoadedModulePaths ?? defaultGetLoadedModulePaths;
    const paths = getLoadedModulePaths();

    if (paths.length === 0 && deps.getLoadedModulePaths === undefined) {
        // ESM runtime — `require.cache` is unavailable. Log once and rely on
        // Layer A (package.json deps) + Layer B (ESLint) compile-time guarantees.
        logWarn(
            '[agent:boundary] INFO: require.cache unavailable under ESM — runtime guard is a no-op. Layer A (package.json) + Layer B (ESLint) remain in force (ADR 0035 §2.4).',
        );
        return;
    }

    const violations = paths.filter((p) => BANNED_PATH_FRAGMENTS.some((f) => p.includes(f)));

    if (violations.length > 0) {
        logError(
            `[agent:boundary] FATAL: ${violations.length} banned module(s) loaded into agent process address space (ADR 0035 §2.4 layer C violation). First offender: ${violations[0]}. Exiting with code 1.`,
        );
        exit(1);
    }
}
