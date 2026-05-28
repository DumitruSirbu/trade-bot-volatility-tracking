// M14 W3 — SCA allowlist filter boundary tests (ADR 0040 §2.2).

import { AdvisoryReport, AllowlistEntry, evaluateSca, nonExpiredGhsas } from './auditAllowlistFilter';

const TODAY = new Date('2026-05-28T12:00:00.000Z');

function validEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
    return {
        ghsa: 'GHSA-aaaa-bbbb-cccc',
        cve: null,
        package: 'left-pad@1.0.0',
        severity: 'high',
        reason: 'no upstream fix; not reachable from the order path',
        reachability: 'transitive via build tool; not exercised at runtime',
        approvedBy: 'owner',
        approvedOn: '2026-05-01',
        expiresOn: '2026-06-30',
        trackingIssue: 'https://example.test/issues/1',
        ...overrides,
    };
}

function highAdvisory(ghsa: string): AdvisoryReport {
    return { ghsa, severity: 'high', package: 'left-pad@1.0.0', title: 'prototype pollution' };
}

describe('evaluateSca — ADR 0040 §2.2 boundary cases', () => {
    it('passes when no advisories and an empty allowlist (clean tree)', () => {
        const verdict = evaluateSca([], [], TODAY);

        expect(verdict.passed).toBe(true);
        expect(verdict.failures).toHaveLength(0);
    });

    it('suppresses a matched, not-yet-expired advisory and logs it', () => {
        const verdict = evaluateSca([highAdvisory('GHSA-aaaa-bbbb-cccc')], [validEntry()], TODAY);

        expect(verdict.passed).toBe(true);
        expect(verdict.suppressed).toContain('ALLOWLISTED GHSA-aaaa-bbbb-cccc expires 2026-06-30');
    });

    it('passes when the allowlist entry expires exactly today (>= today is valid)', () => {
        const verdict = evaluateSca([highAdvisory('GHSA-aaaa-bbbb-cccc')], [validEntry({ expiresOn: '2026-05-28' })], TODAY);

        expect(verdict.passed).toBe(true);
    });

    it('FAILS ALLOWLIST_ENTRY_EXPIRED when the matched entry expired yesterday', () => {
        const verdict = evaluateSca([highAdvisory('GHSA-aaaa-bbbb-cccc')], [validEntry({ expiresOn: '2026-05-27' })], TODAY);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures.map((failure) => failure.kind)).toContain('ALLOWLIST_ENTRY_EXPIRED');
    });

    it('FAILS UNMATCHED_ADVISORY for a HIGH advisory not on the allowlist', () => {
        const verdict = evaluateSca([highAdvisory('GHSA-zzzz-zzzz-zzzz')], [], TODAY);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures[0].kind).toBe('UNMATCHED_ADVISORY');
        expect(verdict.failures[0].detail).toContain('GHSA-zzzz-zzzz-zzzz');
    });

    it('FAILS UNMATCHED_ADVISORY for a CRITICAL advisory not on the allowlist', () => {
        const critical: AdvisoryReport = { ghsa: 'GHSA-crit-crit-crit', severity: 'critical', package: 'evil@9.9.9' };

        const verdict = evaluateSca([critical], [], TODAY);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures[0].kind).toBe('UNMATCHED_ADVISORY');
    });

    it('FAILS ALLOWLIST_MALFORMED when an entry is missing a required field', () => {
        const verdict = evaluateSca([], [validEntry({ reason: '' })], TODAY);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures[0].kind).toBe('ALLOWLIST_MALFORMED');
        expect(verdict.failures[0].detail).toContain('reason');
    });

    it('FAILS ALLOWLIST_MALFORMED when expiresOn is more than 90 days out', () => {
        const verdict = evaluateSca([], [validEntry({ expiresOn: '2026-09-30' })], TODAY);

        expect(verdict.passed).toBe(false);
        expect(verdict.failures[0].kind).toBe('ALLOWLIST_MALFORMED');
        expect(verdict.failures[0].detail).toContain('90 days');
    });

    it('passes ALLOWLIST_MALFORMED boundary when expiresOn is exactly 90 days out', () => {
        const verdict = evaluateSca([], [validEntry({ expiresOn: '2026-08-26' })], TODAY);

        expect(verdict.passed).toBe(true);
    });

    it('does not block a MODERATE advisory that is not on the allowlist (log-only)', () => {
        const moderate: AdvisoryReport = { ghsa: 'GHSA-mod-mod-modd', severity: 'moderate', package: 'meh@1.0.0' };

        const verdict = evaluateSca([moderate], [], TODAY);

        expect(verdict.passed).toBe(true);
        expect(verdict.failures).toHaveLength(0);
    });
});

describe('nonExpiredGhsas — auditConfig sync source of truth', () => {
    it('returns only the ghsa ids of non-expired entries', () => {
        const allowlist = [
            validEntry({ ghsa: 'GHSA-keep-keep-keep', expiresOn: '2026-06-30' }),
            validEntry({ ghsa: 'GHSA-drop-drop-drop', expiresOn: '2026-05-01' }),
        ];

        expect(nonExpiredGhsas(allowlist, TODAY)).toEqual(['GHSA-keep-keep-keep']);
    });

    it('returns an empty array for an empty allowlist (matches empty ignoreGhsas)', () => {
        expect(nonExpiredGhsas([], TODAY)).toEqual([]);
    });
});
