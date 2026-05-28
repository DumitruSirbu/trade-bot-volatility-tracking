// M14 W3 — exchange-dep pin/skew check boundary tests (ADR 0041 §2.2/§2.3).

import { CriticalDep, WorkspaceManifest, evaluateExchangeDepPins, isExactPin } from './exchangeDepPinCheck';

const CRITICAL_DEPS: CriticalDep[] = [
    { name: 'ccxt', version: '4.5.54' },
    { name: 'decimal.js', version: '10.6.0' },
    { name: 'pg', version: '8.21.0' },
];

function manifest(path: string, deps: Record<string, string>, devDeps: Record<string, string> = {}): WorkspaceManifest {
    return { path, dependencies: deps, devDependencies: devDeps };
}

describe('isExactPin — ADR 0041 §2.2 specifier classification', () => {
    it('treats a bare semver as exact', () => {
        expect(isExactPin('4.5.54')).toBe(true);
    });

    it('treats a prerelease bare semver as exact', () => {
        expect(isExactPin('4.5.54-rc.1')).toBe(true);
    });

    it.each(['^4.5.54', '~4.5.54', '>=4.5.54', '4.x', '*', 'latest', 'npm:ccxt@4.5.54', 'github:ccxt/ccxt'])('rejects non-exact specifier %s', (specifier) => {
        expect(isExactPin(specifier)).toBe(false);
    });
});

describe('evaluateExchangeDepPins — ADR 0041 §2.2/§2.3 boundary cases', () => {
    it('passes when every critical dep is exact-pinned and consistent across workspaces', () => {
        const manifests = [
            manifest('apps/engine/package.json', { ccxt: '4.5.54', 'decimal.js': '10.6.0', pg: '8.21.0' }),
            manifest('packages/shared/package.json', { 'decimal.js': '10.6.0' }),
            manifest('packages/analysis/package.json', { 'decimal.js': '10.6.0', pg: '8.21.0' }),
            manifest('apps/agent/package.json', { pg: '8.21.0' }),
        ];

        const verdict = evaluateExchangeDepPins(CRITICAL_DEPS, manifests);

        expect(verdict.passed).toBe(true);
        expect(verdict.failures).toHaveLength(0);
    });

    it('FAILS UNPINNED_EXCHANGE_DEP on a caret specifier', () => {
        const manifests = [manifest('apps/engine/package.json', { ccxt: '^4.5.54' })];

        const verdict = evaluateExchangeDepPins(CRITICAL_DEPS, manifests);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures[0].kind).toBe('UNPINNED_EXCHANGE_DEP');
        expect(verdict.failures[0].detail).toContain('apps/engine/package.json');
    });

    it('FAILS UNPINNED_EXCHANGE_DEP on a tag specifier', () => {
        const manifests = [manifest('apps/engine/package.json', { ccxt: 'latest' })];

        expect(evaluateExchangeDepPins(CRITICAL_DEPS, manifests).failures[0].kind).toBe('UNPINNED_EXCHANGE_DEP');
    });

    it('FAILS EXCHANGE_DEP_VERSION_SKEW when decimal.js diverges across workspaces', () => {
        const manifests = [
            manifest('apps/engine/package.json', { 'decimal.js': '10.6.0' }),
            manifest('packages/shared/package.json', { 'decimal.js': '10.5.0' }),
        ];

        const verdict = evaluateExchangeDepPins(CRITICAL_DEPS, manifests);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures.map((failure) => failure.kind)).toContain('EXCHANGE_DEP_VERSION_SKEW');
        expect(verdict.failures.find((failure) => failure.kind === 'EXCHANGE_DEP_VERSION_SKEW')?.detail).toContain('10.5.0');
    });

    it('detects a dep declared in devDependencies', () => {
        const manifests = [manifest('apps/engine/package.json', {}, { ccxt: '^4.5.54' })];

        expect(evaluateExchangeDepPins(CRITICAL_DEPS, manifests).failures[0].kind).toBe('UNPINNED_EXCHANGE_DEP');
    });

    it('passes when a critical dep is absent from every workspace (nothing to check)', () => {
        const manifests = [manifest('apps/dashboard/package.json', { react: '19.0.0' })];

        expect(evaluateExchangeDepPins(CRITICAL_DEPS, manifests).passed).toBe(true);
    });
});
