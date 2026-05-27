// M12 W3 — runtime boundary-guard tests (ADR 0033 §2.4 layer C).
//
// The guard scans the loaded-module set for `/apps/engine/` paths. We inject
// the scan source + exit function to avoid actually terminating the test
// runner.

import { runBoundaryGuard } from '../../src/boundary/RuntimeGuard';

interface ISpyExit {
    readonly exit: (code: number) => never;
    readonly calls: number[];
}

function makeSpyExit(): ISpyExit {
    const calls: number[] = [];
    return {
        calls,
        exit: ((code: number): never => {
            calls.push(code);
            throw new Error(`__SPY_EXIT__:${code}`);
        }) as (code: number) => never,
    };
}

describe('runBoundaryGuard', () => {
    it('passes silently when no engine paths are loaded', () => {
        const { exit, calls } = makeSpyExit();
        expect(() =>
            runBoundaryGuard({
                getLoadedModulePaths: () => ['/Users/x/apps/mcp/dist/main.js', '/Users/x/packages/analysis/dist/index.js'],
                exit,
                env: {},
                logError: () => undefined,
            }),
        ).not.toThrow();
        expect(calls).toEqual([]);
    });

    it('calls exit(1) when ANY loaded module path contains /apps/engine/', () => {
        const { exit, calls } = makeSpyExit();
        const logs: string[] = [];

        expect(() =>
            runBoundaryGuard({
                getLoadedModulePaths: () => ['/Users/x/apps/mcp/dist/main.js', '/Users/x/apps/engine/dist/execution/ExecutionService.js'],
                exit,
                env: {},
                logError: (m) => logs.push(m),
            }),
        ).toThrow(/__SPY_EXIT__:1/);

        expect(calls).toEqual([1]);
        expect(logs.some((l) => l.includes('apps/engine'))).toBe(true);
        expect(logs.some((l) => l.includes('FATAL'))).toBe(true);
    });

    it('honors MCP_BOUNDARY_GUARD=disabled and logs a warning', () => {
        const { exit, calls } = makeSpyExit();
        const logs: string[] = [];

        runBoundaryGuard({
            getLoadedModulePaths: () => ['/Users/x/apps/engine/dist/foo.js'],
            exit,
            env: { MCP_BOUNDARY_GUARD: 'disabled' },
            logError: (m) => logs.push(m),
        });

        expect(calls).toEqual([]);
        expect(logs.some((l) => l.includes('bypassed'))).toBe(true);
    });
});
