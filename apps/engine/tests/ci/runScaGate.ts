// M14 W3 — SCA gate CI entrypoint (ADR 0040). Run via the root `audit:ci` script,
// or directly:
//   pnpm audit --audit-level=high --prod --json > audit-prod.json || true
//   pnpm --filter @bot/engine exec ts-node tests/ci/runScaGate.ts "$PWD/audit-prod.json"
//
// Reads the pnpm-audit JSON from the file path in argv[2] (must be readable) or,
// if none given, from stdin; reads the allowlist registry from
// .github/audit-allowlist.json; applies the deterministic filter; prints the
// verdict; and exits non-zero on failure. I/O only — logic is in auditAllowlistFilter.

import { readFileSync } from 'node:fs';

import { AdvisoryReport, AllowlistEntry, evaluateSca } from './auditAllowlistFilter';
import { AUDIT_ALLOWLIST_PATH } from './ciPaths';

// Reads the audit JSON. When an explicit input path is given it MUST be readable —
// a swallowed read error would fail OPEN (0 advisories → pass) and silently blind
// the gate, so an unreadable explicit path throws. Stdin is best-effort (empty ok).
function readAuditJson(): string {
    const filePath = process.argv[2];

    if (filePath) {
        return readFileSync(filePath, 'utf8');
    }

    try {
        return readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function parseAdvisories(auditJson: string): AdvisoryReport[] {
    if (auditJson.trim() === '') {
        return [];
    }

    const report = JSON.parse(auditJson) as { advisories?: Record<string, RawAdvisory> };
    const advisories = report.advisories ?? {};

    return Object.values(advisories).map(toAdvisoryReport);
}

interface RawAdvisory {
    github_advisory_id?: string;
    id?: number;
    severity: string;
    module_name?: string;
    title?: string;
    url?: string;
}

function toAdvisoryReport(raw: RawAdvisory): AdvisoryReport {
    return {
        ghsa: raw.github_advisory_id ?? String(raw.id ?? 'unknown'),
        severity: raw.severity,
        package: raw.module_name ?? 'unknown',
        title: raw.title,
        url: raw.url,
    };
}

function readAllowlist(): AllowlistEntry[] {
    return JSON.parse(readFileSync(AUDIT_ALLOWLIST_PATH, 'utf8')) as AllowlistEntry[];
}

function main(): void {
    const advisories = parseAdvisories(readAuditJson());
    const verdict = evaluateSca(advisories, readAllowlist(), new Date());

    for (const note of verdict.suppressed) {
        console.warn(note);
    }

    if (verdict.passed) {
        console.warn(`SCA gate PASSED — ${advisories.length} advisory record(s) scanned, 0 blocking.`);

        return;
    }

    for (const failure of verdict.failures) {
        console.error(`SCA FAIL [${failure.kind}] ${failure.detail}`);
    }

    process.exit(1);
}

main();
