// M14 W3 — auditConfig fail-open guard (ADR 0040 §2.2, R1 contract).
//
// CONTRACT (inverted from the original sync test): root package.json
// `pnpm.auditConfig.ignoreGhsas` / `ignoreCves` MUST stay empty (or absent).
// pnpm strips ignoreGhsas advisories from `pnpm audit --json` BEFORE the filter
// sees them, so mirroring allowlist entries there would blind the expiry / 90-day
// forcing functions (fail-open). The in-repo .github/audit-allowlist.json +
// auditAllowlistFilter is the SOLE suppression authority. This test fails if
// anything is ever added to either native ignore list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './ciPaths';

interface RootAuditConfig {
    pnpm?: { auditConfig?: { ignoreGhsas?: string[]; ignoreCves?: string[] } };
}

function readRootPackage(): RootAuditConfig {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootAuditConfig;
}

describe('auditConfig must stay empty — no native fail-open suppression (ADR 0040 §2.2)', () => {
    it('pnpm.auditConfig.ignoreGhsas is empty or absent', () => {
        const ignoreGhsas = readRootPackage().pnpm?.auditConfig?.ignoreGhsas ?? [];

        expect(ignoreGhsas).toEqual([]);
    });

    it('pnpm.auditConfig.ignoreCves is empty or absent', () => {
        const ignoreCves = readRootPackage().pnpm?.auditConfig?.ignoreCves ?? [];

        expect(ignoreCves).toEqual([]);
    });
});
