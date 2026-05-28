// M14 W3 — deterministic SCA allowlist filter (ADR 0040 §2.2).
//
// Pure logic, CI-only (lives under tests/ so it never ships in the engine image).
// Given the parsed `pnpm audit --json` report, the `.github/audit-allowlist.json`
// registry, and "today" (UTC), it decides whether the SCA gate passes and why.
//
// The caller (the `sca` CI job) is responsible for I/O: running pnpm audit,
// reading the JSON files, and exiting non-zero on a failing verdict.

/** Severities that block the gate (ADR 0040 §2.1 — HIGH + CRITICAL only). */
export const BLOCKING_SEVERITIES = ['high', 'critical'] as const;

/** Max days an allowlist exception may be valid (ADR 0040 §2.2 — blast-radius cap). */
export const MAX_EXPIRY_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const REQUIRED_ALLOWLIST_FIELDS = ['ghsa', 'package', 'severity', 'reason', 'reachability', 'approvedBy', 'approvedOn', 'expiresOn'] as const;

export type BlockingSeverity = (typeof BLOCKING_SEVERITIES)[number];

export interface AdvisoryReport {
    ghsa: string;
    severity: string;
    package: string;
    title?: string;
    url?: string;
}

export interface AllowlistEntry {
    ghsa: string;
    cve?: string | null;
    package: string;
    severity: string;
    reason: string;
    reachability: string;
    approvedBy: string;
    approvedOn: string;
    expiresOn: string;
    trackingIssue?: string;
}

export type ScaFailureKind = 'ALLOWLIST_MALFORMED' | 'ALLOWLIST_ENTRY_EXPIRED' | 'UNMATCHED_ADVISORY';

export interface ScaFailure {
    kind: ScaFailureKind;
    detail: string;
}

export interface ScaVerdict {
    passed: boolean;
    failures: ScaFailure[];
    suppressed: string[];
}

/** Mutable accumulators + resolution inputs threaded through advisory resolution. */
interface AdvisoryResolutionContext {
    allowlist: AllowlistEntry[];
    today: Date;
    failures: ScaFailure[];
    suppressed: string[];
}

/**
 * Evaluates the SCA gate. Validates the allowlist first (a malformed registry is
 * itself a failure), then resolves every blocking advisory against it.
 */
export function evaluateSca(advisories: AdvisoryReport[], allowlist: AllowlistEntry[], today: Date): ScaVerdict {
    const context: AdvisoryResolutionContext = { allowlist, today, failures: [], suppressed: [] };

    context.failures.push(...collectMalformedEntryFailures(allowlist, today));

    for (const advisory of blockingAdvisories(advisories)) {
        resolveAdvisory(advisory, context);
    }

    return { passed: context.failures.length === 0, failures: context.failures, suppressed: context.suppressed };
}

function blockingAdvisories(advisories: AdvisoryReport[]): AdvisoryReport[] {
    return advisories.filter((advisory) => isBlockingSeverity(advisory.severity));
}

export function isBlockingSeverity(severity: string): severity is BlockingSeverity {
    return (BLOCKING_SEVERITIES as readonly string[]).includes(severity.toLowerCase());
}

function resolveAdvisory(advisory: AdvisoryReport, context: AdvisoryResolutionContext): void {
    const match = context.allowlist.find((entry) => entry.ghsa === advisory.ghsa);

    if (!match) {
        context.failures.push({ kind: 'UNMATCHED_ADVISORY', detail: describeAdvisory(advisory) });

        return;
    }

    if (isExpired(match.expiresOn, context.today)) {
        context.failures.push({ kind: 'ALLOWLIST_ENTRY_EXPIRED', detail: `${match.ghsa} expired ${match.expiresOn}` });

        return;
    }

    context.suppressed.push(`ALLOWLISTED ${match.ghsa} expires ${match.expiresOn}`);
}

function collectMalformedEntryFailures(allowlist: AllowlistEntry[], today: Date): ScaFailure[] {
    const failures: ScaFailure[] = [];

    for (const entry of allowlist) {
        const reason = malformedReason(entry, today);

        if (reason) {
            failures.push({ kind: 'ALLOWLIST_MALFORMED', detail: reason });
        }
    }

    return failures;
}

function malformedReason(entry: AllowlistEntry, today: Date): string | null {
    const missing = REQUIRED_ALLOWLIST_FIELDS.filter((field) => isBlank(entry[field]));

    if (missing.length > 0) {
        return `${entry.ghsa ?? '<no ghsa>'} missing field(s): ${missing.join(', ')}`;
    }

    if (exceedsMaxExpiry(entry.expiresOn, today)) {
        return `${entry.ghsa} expiresOn ${entry.expiresOn} is more than ${MAX_EXPIRY_DAYS} days out`;
    }

    return null;
}

function isBlank(value: unknown): boolean {
    return value === undefined || value === null || value === '';
}

function isExpired(expiresOn: string, today: Date): boolean {
    return parseUtcDate(expiresOn).getTime() < startOfUtcDay(today).getTime();
}

function exceedsMaxExpiry(expiresOn: string, today: Date): boolean {
    const daysOut = (parseUtcDate(expiresOn).getTime() - startOfUtcDay(today).getTime()) / MS_PER_DAY;

    return daysOut > MAX_EXPIRY_DAYS;
}

function parseUtcDate(yyyyMmDd: string): Date {
    return new Date(`${yyyyMmDd}T00:00:00.000Z`);
}

function startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function describeAdvisory(advisory: AdvisoryReport): string {
    return `${advisory.ghsa} (${advisory.severity}) in ${advisory.package}${advisory.title ? ` — ${advisory.title}` : ''}`;
}

// Non-expired GHSA ids in the registry. NOTE (ADR 0040 §2.2): this set must NEVER
// be mirrored into root `pnpm.auditConfig.ignoreGhsas` — pnpm strips ignoreGhsas
// advisories from `--json` BEFORE the filter sees them, which would blind the
// expiry / 90-day forcing functions (fail-open). The auditConfigSync test asserts
// ignoreGhsas/ignoreCves stay empty. Retained for diagnostics / reporting only.
export function nonExpiredGhsas(allowlist: AllowlistEntry[], today: Date): string[] {
    return allowlist.filter((entry) => !isExpired(entry.expiresOn, today)).map((entry) => entry.ghsa);
}
