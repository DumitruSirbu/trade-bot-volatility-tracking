# ADR 0040 — Supply-chain SCA gate, audit-exception process, lockfile integrity

**Status:** Accepted-and-shipped (M14 closed 2026-05-28; §2.2 revised R2-H1)
**Date:** 2026-05-28
**Milestone:** M14 — CI review gate (deterministic gates phase)
**Depends on:** ADR 0039 (CI gate policy — this is one of its required checks).
**Consumed by:** M14 W3 (SCA + lockfile jobs + allowlist file).
**Related:** ADR 0041 (dependency pinning + provenance), `docs/plans/M14-execution-plan.md` §W3.

## 1. Context

This is a money-handling bot with exchange-API access. A compromised or vulnerable
transitive dependency is a direct path to credential theft or order manipulation —
the worst-case failure for the project. The original M14 brief mandates an SCA gate
(`pnpm audit`) plus lockfile-integrity on every PR, **blocking on high/critical
advisories**, with a **documented exception process** for advisories that have no
fix available. The user has locked these answers:

- **Threshold: block on HIGH + CRITICAL advisories.** MODERATE/LOW are reported but
  do not block.
- **A documented exception process** for unfixable findings, with expiry and
  justification, recorded in an in-repo allowlist.
- **Lockfile integrity / tamper detection on every PR.**

pnpm@9 provides the primitives this ADR builds on:

- `pnpm audit` queries the GitHub advisory DB for the installed dependency graph;
  `--audit-level=high` sets the floor, `--prod` scopes to production deps,
  `--json` gives a parseable report. Non-zero exit on a finding at/above the level.
- `pnpm audit` reads an **ignore list from root `package.json`** under
  `pnpm.auditConfig.ignoreGhsas` (GHSA ids) / `ignoreCves` (CVE ids) — advisories on
  that list are **stripped from the JSON output before any consumer sees them**. This
  is a native suppression with no expiry. The exception process deliberately does
  **not** bind to it (see §2.2 R2-H1 adjudication): if an allowlisted advisory were
  mirrored into `ignoreGhsas`, `pnpm audit` would remove it from the report and the
  filter's expiry/90-day forcing functions could never fire for it.
- `pnpm install --frozen-lockfile` fails if `pnpm-lock.yaml` is out of sync with the
  manifests, and the lockfile records an integrity (`sha512`) hash per package —
  tamper of a resolved tarball flips the hash and fails install.

## 2. Decision

### 2.1 SCA gate command + threshold

The required `supply-chain SCA` check (ADR 0039 §2.2) runs:

```
pnpm audit --audit-level=high --prod --json
```

- `--audit-level=high` → the job fails on any **HIGH** or **CRITICAL** advisory.
  MODERATE/LOW are emitted to the log for visibility but do **not** fail the job.
- `--prod` → audits production dependencies. A **second, advisory (non-blocking)**
  invocation without `--prod` audits dev dependencies and is reported but does not
  block (a vuln in a test-only tool is not a runtime exposure; it is tracked, not a
  merge wall). *(The dev-scope run is the one advisory check ADR 0039 §2.3 leaves
  room for; it is informational.)*
- `--json` → the output is parsed by a small deterministic filter step (§2.2) so the
  allowlist can be applied with expiry semantics that `auditConfig` alone does not
  enforce.

The gate is **production-HIGH-and-CRITICAL-blocks**; everything else is reported.

### 2.2 The audit-exception process (allowlist with expiry + justification)

`pnpm.auditConfig.ignoreGhsas` suppresses an advisory but carries **no expiry and no
justification** — a silent forever-ignore is exactly the rot this project cannot
accept. Worse (R2-H1), `pnpm audit` strips `ignoreGhsas`-listed advisories from its
JSON output *before* the deterministic filter (§2.2 step list) ever runs — so any
advisory mirrored into `ignoreGhsas` becomes invisible to the filter, and the
filter's `ALLOWLIST_ENTRY_EXPIRED` / 90-day-cap forcing functions can **never fire**
for it. The expiry control would silently die on first real use.

**R2-H1 adjudication (chosen: keep `ignoreGhsas` permanently empty).**
`pnpm.auditConfig.ignoreGhsas` and `ignoreCves` are kept **empty `[]` at all times**.
The in-repo `.github/audit-allowlist.json` + the deterministic filter are the **sole
authority** on what is suppressed, because they are the only layer that sees the
**unsuppressed** advisory set and can therefore enforce expiry and the 90-day cap.
A raw `pnpm audit` run by a developer will show allowlisted advisories (it has no
expiry semantics); local/CI parity is provided by a `pnpm run audit:ci` wrapper that
runs the same `pnpm audit … --json | filter` pipeline CI runs, **not** by mirroring
exceptions into `auditConfig`. The W3 sync test is **inverted**: `auditConfigSync.spec.ts`
now asserts `pnpm.auditConfig.ignoreGhsas` and `ignoreCves` are **empty arrays** (or
absent), failing CI if anything is ever added to them — the mirror that would defeat
the gate is now itself a gate failure.

The exception process therefore layers a **human-readable registry** that is the
single source of truth (no native-suppression mirror beneath it):

**File:** `.github/audit-allowlist.json` (checked in, reviewed like code).

Each entry:

```
{
  "ghsa": "GHSA-xxxx-xxxx-xxxx",
  "cve": "CVE-2026-NNNNN | null",
  "package": "<name>@<range>",
  "severity": "high | critical",
  "reason": "no fix published upstream; not reachable from the order path because <…>",
  "reachability": "transitive via <pkg>; <how it is/ isn't exercised at runtime>",
  "approvedBy": "<repo owner / operator handle>",
  "approvedOn": "YYYY-MM-DD",
  "expiresOn": "YYYY-MM-DD",
  "trackingIssue": "<gh issue/PR url>"
}
```

The SCA job's filter step:

1. Runs `pnpm audit --audit-level=high --prod --json`.
2. For each reported HIGH/CRITICAL advisory, checks `.github/audit-allowlist.json`:
   - **Matched + not expired** (`expiresOn >= today`, in UTC) → suppressed; logged as
     `ALLOWLISTED <ghsa> expires <date>`.
   - **Matched + expired** → **the job FAILS** with `ALLOWLIST_ENTRY_EXPIRED`. An
     expired exception is a forcing function to re-review, not a permanent pass.
   - **Unmatched** → **the job FAILS** with the advisory details.
3. The job also fails (`ALLOWLIST_MALFORMED`) if any entry is missing a required
   field, or has `expiresOn` more than **90 days** in the future (caps the blast
   radius of a single approval; a longer exception requires renewal).

**Approval + recording:** an exception is added only by the repo owner / operator
via PR (it is a code change to a versioned file, so it passes through the same
branch-protection gate as everything else). The `approvedBy`/`approvedOn` fields
record who signed off; the `trackingIssue` links the upstream-fix watch. The native
`pnpm.auditConfig.ignoreGhsas` / `ignoreCves` lists are **not** touched by an
exception PR — they stay empty (R2-H1). Local/CI parity is the `pnpm run audit:ci`
wrapper (same `pnpm audit … --json | filter` pipeline), and the W3
`auditConfigSync.spec.ts` test asserts those native lists remain empty.

**Reachability for exchange-touching deps:** an exception that suppresses an advisory
on `ccxt`, `pg`, `decimal.js`, or anything on their dependency path requires the
`reachability` field to explicitly argue why the advisory does not reach the order /
key-handling path, and is flagged in the PR for the security reviewer (W4). This
is the one class of exception where "no fix upstream" alone is insufficient.

### 2.3 Lockfile integrity / tamper detection

Two layers, both required (ADR 0039 §2.2 `install integrity`):

1. **`pnpm install --frozen-lockfile`** on every PR. This fails if:
   - a manifest (`package.json`) was changed without regenerating `pnpm-lock.yaml`
     (drift — the common "forgot to commit the lock" case), or
   - the lockfile references a version no longer satisfiable by the manifests.

   It also **never writes** the lockfile in CI, so a CI run cannot mask a drift by
   silently updating the lock.

2. **Integrity-hash verification.** The lockfile pins a `sha512` integrity hash per
   resolved package. `--frozen-lockfile` install verifies fetched tarballs against
   those hashes; a tampered or substituted tarball flips the hash and **fails the
   install**. The pnpm content-addressable store is keyed on the same hash. No extra
   tool is needed — this is install-time behavior, asserted by the W3 smoke (seed a
   one-byte lockfile edit → install fails).

A separate deterministic job, **`lockfile:single-source`**, asserts there is exactly
one `pnpm-lock.yaml` at the repo root and no stray `package-lock.json` /
`yarn.lock` / nested lockfiles (a second lockfile is a supply-chain ambiguity and a
common injection vector). `git ls-files | grep -E '(package-lock\.json|yarn\.lock)$'`
must be empty; exactly one root `pnpm-lock.yaml` must exist.

### 2.4 What this ADR does NOT do

- Does NOT add a third-party SCA SaaS (Snyk, Dependabot-security-only auto-PRs) in
  M14. `pnpm audit` against the GitHub advisory DB is sufficient and adds no new
  vendor or secret. Dependabot *version*-bump PRs are an advisory-phase candidate
  (§deferred in the execution plan), not a blocking gate here.
- Does NOT pin or verify provenance of exchange-touching deps — that is ADR 0041.
  This ADR covers the *vulnerability* and *integrity* surface; 0041 covers the
  *authenticity/pinning* surface.
- Does NOT block on MODERATE/LOW. They are logged for the operator's awareness.

## 3. Consequences

**Positive.**

- A HIGH/CRITICAL advisory in a production dependency cannot merge to `main` without
  an explicit, time-boxed, signed, reachability-justified exception.
- Exceptions rot loudly: they expire, and an expired entry re-fails the gate. There
  is no permanent silent suppression.
- Lockfile drift and tarball tamper both fail the install gate — a substituted
  dependency cannot slip in.
- The whole mechanism uses only pnpm + a tiny JSON file + the GitHub advisory DB —
  no new vendor, no new secret in CI.

**Negative.**

- The allowlist filter is a small piece of deterministic glue to author and test
  (W3). Mitigation: it is pure (read JSON, compare dates, match ids) and fully
  unit-testable — boundary tests on expired/malformed/unmatched/matched.
- A raw `pnpm audit` run locally shows allowlisted advisories (it has no expiry
  semantics and `ignoreGhsas` is deliberately empty per R2-H1). Mitigation: the
  `pnpm run audit:ci` wrapper reproduces the exact CI pipeline (`pnpm audit … --json |
  filter`) for local parity; `ignoreGhsas` is never used as a parity shim because
  doing so would hide advisories from the filter and silently disable expiry.

**Neutral.**

- The advisory DB updates daily; a previously-green dependency can turn red on a new
  publication with no code change. That is correct behavior — it is the gate doing
  its job — and the exception process is the relief valve.

## 4. Alternatives considered

- **A. Block on MODERATE+.** Rejected: moderate advisories in transitive build tools
  are frequent and mostly non-reachable; blocking on them trains engineers to
  reflexively allowlist, which erodes the gate's signal. HIGH+CRITICAL is the
  meaningful floor for a runtime exposure.
- **B. `pnpm.auditConfig.ignoreGhsas` as the exception mechanism (sole, or as a
  parity mirror of the registry).** Rejected on two grounds: (1) no expiry, no
  justification, no approver — a forever-ignore with zero accountability; (2) R2-H1 —
  `pnpm audit` strips `ignoreGhsas` advisories from its JSON *before* the filter runs,
  so mirroring exceptions there makes the filter's expiry/90-day forcing functions
  unable to fire. The registry + filter is the sole control; `ignoreGhsas` stays
  empty and a W3 test enforces that. Local parity comes from the `pnpm run audit:ci`
  wrapper, not from the native list.
- **C. A SaaS SCA (Snyk/Mend) as the blocking gate.** Rejected for M14: adds a
  vendor, a token secret in CI (new attack surface), and cost — for signal `pnpm
  audit` already provides. Revisit only if the advisory DB proves insufficient.
- **D. No lockfile gate, rely on `pnpm install` default behavior.** Rejected:
  default install *writes* the lockfile, masking drift. `--frozen-lockfile` is the
  only mode that turns drift into a failure.
- **E. Allow indefinite exceptions with manual review reminders.** Rejected: relies
  on a human remembering. The 90-day expiry cap + auto-fail-on-expiry makes the
  reminder a hard gate.
- **F. Audit dev deps as a blocking gate too.** Rejected: a vuln in a test-only tool
  is not a runtime exposure and would block merges for non-shippable risk. Dev-scope
  audit runs as advisory (§2.1) so it is still visible.

## 5. References

- `docs/plans/M14-execution-plan.md` §W3 (SCA job, allowlist file, lockfile jobs).
- ADR 0039 §2.2 (required-check set this gate joins), §2.4 (what "blocks merge"
  means).
- ADR 0041 (pinning + provenance — the authenticity half of supply-chain).
- pnpm CLI: `pnpm audit --audit-level --prod --json`, `pnpm.auditConfig`,
  `pnpm install --frozen-lockfile`, lockfile `sha512` integrity hashes.
