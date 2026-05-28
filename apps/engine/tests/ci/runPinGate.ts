// M14 W3 — exchange-dep pin/skew gate CI entrypoint (ADR 0041 §2.2/§2.3). Run via:
//   pnpm --filter @bot/engine exec ts-node tests/ci/runPinGate.ts
//
// Reads .github/exchange-critical-deps.json + every apps/* and packages/*
// package.json, applies the deterministic pin/skew check, prints the verdict,
// and exits non-zero on failure. The advisory attestation-presence lookup runs
// as a separate non-blocking CI step; this entry covers the BLOCKING pin + skew checks.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CriticalDep, WorkspaceManifest, evaluateExchangeDepPins } from './exchangeDepPinCheck';
import { EXCHANGE_CRITICAL_DEPS_PATH, REPO_ROOT } from './ciPaths';

const WORKSPACE_PARENTS = ['apps', 'packages'] as const;

function readCriticalDeps(): CriticalDep[] {
    return JSON.parse(readFileSync(EXCHANGE_CRITICAL_DEPS_PATH, 'utf8')) as CriticalDep[];
}

function collectManifests(): WorkspaceManifest[] {
    const manifests: WorkspaceManifest[] = [];

    for (const parent of WORKSPACE_PARENTS) {
        for (const workspace of readdirSync(join(REPO_ROOT, parent))) {
            const manifestPath = join(parent, workspace, 'package.json');

            if (existsSync(join(REPO_ROOT, manifestPath))) {
                manifests.push(readManifest(manifestPath));
            }
        }
    }

    return manifests;
}

function readManifest(manifestPath: string): WorkspaceManifest {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, manifestPath), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };

    return {
        path: manifestPath,
        dependencies: parsed.dependencies ?? {},
        devDependencies: parsed.devDependencies ?? {},
    };
}

function main(): void {
    const verdict = evaluateExchangeDepPins(readCriticalDeps(), collectManifests());

    if (verdict.passed) {
        console.warn('Exchange-dep pin/skew gate PASSED — all critical deps exact-pinned and consistent.');

        return;
    }

    for (const failure of verdict.failures) {
        console.error(`PIN FAIL [${failure.kind}] ${failure.detail}`);
    }

    process.exit(1);
}

main();
