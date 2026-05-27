// M11a R2a Item 5A module-graph sentinel (ADR 0032 §2 + §3 D14).
//
// Static guarantee that the PAPER providers cannot reach ccxt or the
// rate-limit module via their import graph. The R2c PaperFillSimulator will
// share the FillSimulatorCore in `packages/shared/` — that path is allowed
// because it has zero engine/ccxt edges. The two compile-time invariants
// asserted here:
//
//   1. `PaperExecutionClient` source MUST NOT import 'ccxt' or
//      'RateLimitPolicyService'.
//   2. `PaperAccountStateSource` source MUST NOT import 'ccxt' or any
//      `exchange/` module.
//   3. `PaperModeModule` source MUST NOT import `ExchangeModule`.
//
// Why source-text and not a real Nest bootstrap: standing up the full Nest
// AppModule for a graph walk requires the DB, config, scheduler, and all
// downstream modules — much heavier than the bug class this test catches.
// A source-text grep on the four PAPER files reliably catches "a future
// refactor adds `import { rateLimitFoo } from '../exchange/...'`" — which is
// exactly the regression the static check is here to prevent.
//
// The runtime AsyncLocalStorage guard (LiveAccountStateCapabilityGuard.spec.ts)
// covers the ModuleRef.get / forwardRef class of escape that source-text
// cannot see. ESLint's no-restricted-syntax rule covers the rule violation
// at edit-time. Three layers; this one is the cheapest.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PAPER_MODE_DIR = resolve(__dirname, '..');

function collectTsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);

        if (entry === '__tests__' || entry === 'node_modules') {
            continue;
        }

        if (statSync(fullPath).isDirectory()) {
            collectTsFiles(fullPath, acc);
            continue;
        }

        if (fullPath.endsWith('.ts') && !fullPath.endsWith('.spec.ts')) {
            acc.push(fullPath);
        }
    }

    return acc;
}

function importedModules(source: string): readonly string[] {
    // Match `import ... from '...'`, `import('...')` dynamic imports, AND
    // bare side-effect imports (`import 'ccxt'`). The bare-import form is
    // load-bearing for the ccxt scan — a `import 'ccxt'` would pull the
    // library into the bundle even without binding a symbol; the previous
    // regex missed that variant (M11a R2a Item 5 — security R2a).
    const staticImports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const dynamicImports = [...source.matchAll(/import\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    const bareImports = [...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

    return [...staticImports, ...dynamicImports, ...bareImports];
}

function shortName(filePath: string): string {
    const segments = filePath.split('/');
    const tail = segments.slice(-3).join('/');

    return tail.length > 0 ? tail : filePath;
}

describe('PaperModeModule — D14 + D2 static module-graph sentinel', () => {
    const paperFiles = collectTsFiles(PAPER_MODE_DIR);

    it('discovers the four R2a paper-mode source files', () => {
        // Floor — at least the module + exec client + account-state source +
        // guard + two exception classes. Catches a delete-by-rename
        // regression that would otherwise let the rest of the assertions
        // pass vacuously.
        expect(paperFiles.length).toBeGreaterThanOrEqual(6);
    });

    // R2a Item 5 (security R2a): every `*.ts` file under `paper-mode/` —
    // not only the three R2a stubs — must be ccxt-free. R2b+ adds
    // PaperAccountStateService, PaperFillSimulator, PaperReconciliationAdapter
    // etc.; without this `it.each` over the full tree, a future file could
    // silently `import ... from 'ccxt'` and the test would pass vacuously.
    it.each(paperFiles.map((p) => [shortName(p), p]))('%s does not import ccxt', (_label: string, filePath: string) => {
        const source = readFileSync(filePath, 'utf8');
        const imports = importedModules(source);

        for (const imp of imports) {
            expect(imp).not.toMatch(/(^|\/)ccxt(\/|$)/);
        }
    });

    it('PaperExecutionClient does not import RateLimitPolicyService', () => {
        const filePath = paperFiles.find((path) => path.endsWith('PaperExecutionClient.ts'));
        const source = readFileSync(filePath as string, 'utf8');
        const imports = importedModules(source);

        // String mentions in comments are fine (they document the invariant);
        // only actual `import` edges matter for the module-graph guarantee.
        for (const imp of imports) {
            expect(imp).not.toMatch(/RateLimitPolicy/);
            expect(imp).not.toMatch(/rateLimit/);
        }
    });

    it('PaperAccountStateSource does not import any exchange/ module', () => {
        const filePath = paperFiles.find((path) => path.endsWith('PaperAccountStateSource.ts'));
        const source = readFileSync(filePath as string, 'utf8');
        const imports = importedModules(source);

        for (const imp of imports) {
            expect(imp).not.toMatch(/(^|\/)exchange(\/|$)/);
        }
    });

    it('PaperModeModule does not import ExchangeModule', () => {
        const filePath = paperFiles.find((path) => path.endsWith('PaperModeModule.ts'));
        const source = readFileSync(filePath as string, 'utf8');
        const imports = importedModules(source);

        // String mentions in comments are fine; only actual `import` edges
        // matter for the module-graph guarantee.
        for (const imp of imports) {
            expect(imp).not.toMatch(/ExchangeModule/);
            expect(imp).not.toMatch(/(^|\/)exchange(\/|$)/);
        }
    });
});
