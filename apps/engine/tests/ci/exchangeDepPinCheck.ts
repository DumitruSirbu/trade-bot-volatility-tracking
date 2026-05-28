// M14 W3 — exchange-critical dependency pin + version-skew check (ADR 0041 §2.2/§2.3).
//
// Pure logic, CI-only. Given the parsed `.github/exchange-critical-deps.json`
// manifest and each workspace's parsed package.json, it asserts that every
// critical dep is exact-pinned everywhere it appears and is consistent across
// workspaces. The caller (the `deps:pin-and-provenance` job) handles I/O and the
// `pnpm audit signatures` provenance layer.

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export interface CriticalDep {
    name: string;
    version: string;
}

export interface WorkspaceManifest {
    path: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
}

export type PinFailureKind = 'UNPINNED_EXCHANGE_DEP' | 'EXCHANGE_DEP_VERSION_SKEW';

export interface PinFailure {
    kind: PinFailureKind;
    detail: string;
}

export interface PinVerdict {
    passed: boolean;
    failures: PinFailure[];
}

interface DepOccurrence {
    version: string;
    manifestPath: string;
}

/** A bare semver such as `4.5.54` is exact; `^`, `~`, `>=`, `*`, `x`, tags, urls are not. */
export function isExactPin(specifier: string): boolean {
    return EXACT_SEMVER.test(specifier.trim());
}

/**
 * Evaluates the pin + skew gate across all critical deps and workspaces.
 */
export function evaluateExchangeDepPins(criticalDeps: CriticalDep[], manifests: WorkspaceManifest[]): PinVerdict {
    const failures: PinFailure[] = [];

    for (const dep of criticalDeps) {
        const occurrences = collectOccurrences(dep.name, manifests);
        failures.push(...unpinnedFailures(dep.name, occurrences));
        failures.push(...skewFailures(dep, occurrences));
    }

    return { passed: failures.length === 0, failures };
}

function collectOccurrences(depName: string, manifests: WorkspaceManifest[]): DepOccurrence[] {
    const occurrences: DepOccurrence[] = [];

    for (const manifest of manifests) {
        const version = readSpecifier(manifest, depName);

        if (version !== null) {
            occurrences.push({ version, manifestPath: manifest.path });
        }
    }

    return occurrences;
}

function readSpecifier(manifest: WorkspaceManifest, depName: string): string | null {
    return manifest.dependencies[depName] ?? manifest.devDependencies[depName] ?? null;
}

function unpinnedFailures(depName: string, occurrences: DepOccurrence[]): PinFailure[] {
    return occurrences
        .filter((occurrence) => !isExactPin(occurrence.version))
        .map((occurrence) => ({
            kind: 'UNPINNED_EXCHANGE_DEP' as const,
            detail: `${depName} is "${occurrence.version}" (not exact) in ${occurrence.manifestPath}`,
        }));
}

function skewFailures(dep: CriticalDep, occurrences: DepOccurrence[]): PinFailure[] {
    const exactOccurrences = occurrences.filter((occurrence) => isExactPin(occurrence.version));
    const divergent = exactOccurrences.filter((occurrence) => occurrence.version !== dep.version);

    if (divergent.length === 0) {
        return [];
    }

    const where = divergent.map((occurrence) => `${occurrence.manifestPath}=${occurrence.version}`).join(', ');

    return [{ kind: 'EXCHANGE_DEP_VERSION_SKEW', detail: `${dep.name} expected ${dep.version} but found ${where}` }];
}
