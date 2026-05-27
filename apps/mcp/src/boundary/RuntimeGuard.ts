// M12 W3 — runtime boundary guard (ADR 0033 §2.4 layer C).
//
// At MCP boot, before any tool is registered, we scan the loaded-module set
// for any file whose path contains `/apps/engine/`. If even one is present,
// the MCP process has somehow pulled engine code into its address space —
// which would defeat the structural read-only guarantee of ADR 0033. Exit
// immediately with a non-zero code so the operator's MCP client notices.
//
// Boundary invariant: this file imports only Node built-ins. It must not
// import from @bot/engine, @bot/analysis, or even sibling MCP modules
// (keeping the guard itself dependency-free protects against a buggy import
// chain accidentally pulling engine code BEFORE the guard runs).

const ENGINE_PATH_FRAGMENT = '/apps/engine/';
const ESCAPE_HATCH_ENV_VAR = 'MCP_BOUNDARY_GUARD';
const ESCAPE_HATCH_VALUE = 'disabled';

export interface IRuntimeGuardDeps {
    /** Defaults to Node's `require.cache` (CommonJS) or a no-op for ESM. */
    getLoadedModulePaths?: () => readonly string[];
    /** Defaults to `(code) => process.exit(code)`. Overridable in tests. */
    exit?: (code: number) => never;
    /** Defaults to `console.error`. Stderr only — stdout is reserved for the stdio transport. */
    logError?: (message: string) => void;
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Returns the file paths currently held in `require.cache`. Under pure ESM
 * (no CommonJS interop), `require` may be undefined; in that case we return
 * an empty list and rely on layer A (workspace deps) + layer B (eslint) for
 * the guarantee. Layer C is best-effort defense in depth, not load-bearing.
 */
function defaultGetLoadedModulePaths(): readonly string[] {
    const cache: Record<string, unknown> | undefined = (globalThis as any).require?.cache;
    if (cache && typeof cache === 'object') {
        return Object.keys(cache);
    }
    return [];
}

/**
 * Asserts that no module from `apps/engine/` is loaded in this process.
 * Calls `exit(1)` on violation. Returns normally on success.
 *
 * Set `MCP_BOUNDARY_GUARD=disabled` ONLY in tests of the guard itself. A
 * warning is logged when bypassed so the operator notices a misconfigured
 * production process.
 */
export function runBoundaryGuard(deps: IRuntimeGuardDeps = {}): void {
    const env = deps.env ?? process.env;
    const logError =
        deps.logError ??
        ((msg: string): void => {
            console.error(msg);
        });
    const exit = deps.exit ?? ((code: number): never => process.exit(code));

    if (env[ESCAPE_HATCH_ENV_VAR] === ESCAPE_HATCH_VALUE) {
        logError(
            `[mcp:boundary] WARNING: ${ESCAPE_HATCH_ENV_VAR}=${ESCAPE_HATCH_VALUE} — boundary guard bypassed. This is only valid in tests of the guard itself (ADR 0033 §2.4 layer C).`,
        );
        return;
    }

    const getLoadedModulePaths = deps.getLoadedModulePaths ?? defaultGetLoadedModulePaths;
    const violations = getLoadedModulePaths().filter((p) => p.includes(ENGINE_PATH_FRAGMENT));

    if (violations.length > 0) {
        logError(
            `[mcp:boundary] FATAL: ${violations.length} engine module(s) loaded into MCP process address space (ADR 0033 §2.4 layer C violation). First offender: ${violations[0]}. Exiting with code 1.`,
        );
        exit(1);
    }
}
