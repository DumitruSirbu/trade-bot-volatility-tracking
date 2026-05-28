# CI gates + branch protection runbook

Operator reference for the deterministic CI gates (M14) and the `main`
branch-protection rule that makes them merge-blocking.

Authoritative decisions: **ADR 0039** (gate policy + branch protection), **ADR
0040** (SCA + lockfile integrity), **ADR 0041** (exchange-dep pinning +
provenance). Workflow: `.github/workflows/ci.yml`.

---

## 1. Required status checks (the job-name contract)

Branch protection on `main` matches required checks **by job name**. The job
names in `.github/workflows/ci.yml` are therefore a frozen contract.

**Canonical job names (W1 + W2 + W3 — live today):**

| Job name                   | Gate                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `install`                  | `pnpm install --frozen-lockfile` (lockfile integrity)               |
| `build`                    | `pnpm -r build`                                                      |
| `typecheck`                | `pnpm -r --if-present typecheck`                                     |
| `lint`                     | `pnpm lint` (`eslint .`, includes no-restricted-imports)            |
| `format`                   | `pnpm format` (`prettier --check .`)                                 |
| `test`                     | full suite incl. DB-integration against a Postgres service          |
| `boundary`                 | ADR 0033/0035 import greps + boundary spec suites                   |
| `sca`                      | `pnpm audit --prod --json` + allowlist filter (ADR 0040)            |
| `lockfile:single-source`   | one root `pnpm-lock.yaml`, no foreign lockfiles (ADR 0040 §2.3)     |
| `deps:pin-and-provenance`  | exact-pin + cross-workspace skew (ADR 0041); advisory attestation log |

> The GitHub check name equals each job's `name:` field — including the colon in
> `lockfile:single-source` and `deps:pin-and-provenance`. The `required_status_checks`
> payload in §2 must use these exact strings.

> **WARNING — job names are load-bearing.** Renaming a job in `ci.yml` silently
> breaks the branch-protection binding: GitHub keeps requiring the OLD name,
> which never reports, so PRs hang "expected" forever — OR, worse, the renamed
> job is no longer required and a red gate stops blocking. **Renaming a job is a
> two-step change: update `ci.yml` AND re-apply the protection payload in §2.**

---

## 2. Branch-protection payload (`main`)

> **DO NOT run this blindly.** Applying branch protection is a shared-state
> change that needs the repo owner's GitHub admin auth. It is recorded here so
> it is reproducible and reviewable (GitHub branch-protection is not
> file-versionable). The repo owner / orchestrator applies it.

Settings encode ADR 0039 §2.6: require PR, require up-to-date branches, require
status checks, linear history, no admin bypass (single logged emergency-revert
exception), require conversation resolution.

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/DumitruSirbu/trade-bot-volatility-tracking/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "install", "app_id": 15368 },
      { "context": "build", "app_id": 15368 },
      { "context": "typecheck", "app_id": 15368 },
      { "context": "lint", "app_id": 15368 },
      { "context": "format", "app_id": 15368 },
      { "context": "test", "app_id": 15368 },
      { "context": "boundary", "app_id": 15368 },
      { "context": "sca", "app_id": 15368 },
      { "context": "lockfile:single-source", "app_id": 15368 },
      { "context": "deps:pin-and-provenance", "app_id": 15368 }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "required_linear_history": true,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null
}
JSON
```

Field notes:

- `required_status_checks.strict: true` — "require branches to be up to date
  before merging" (ADR 0039 §2.6); forces a re-run against the latest `main` so
  a stale green cannot merge a regression.
- `required_status_checks.checks[].context` — must equal the §1 job names
  exactly (including the colons in `lockfile:single-source` and
  `deps:pin-and-provenance`).
- `required_status_checks.checks[].app_id: 15368` — binds each required context
  to the **GitHub Actions** app (app id `15368`) so only a result reported by
  Actions satisfies it. Without this pin, any installed GitHub App with
  commit-status scope (or a spoofed status of the same name) could mark a
  required context green. (If a future check is reported by a different app,
  that entry needs that app's id instead.)
- `enforce_admins: true` — "do not allow bypassing the above settings",
  including for administrators. The only sanctioned exception is an emergency
  revert (see §3).
- `required_linear_history: true` — matches the project's squash/rebase log.
- `required_conversation_resolution: true` — review threads must be resolved
  before merge.
- `restrictions: null` — no push allow-list; combined with the PR requirement,
  direct pushes to `main` are disallowed for everyone (all changes flow through
  a PR that runs the same workflow).

Verify the rule after applying:

```bash
gh api /repos/DumitruSirbu/trade-bot-volatility-tracking/branches/main/protection
```

---

## 3. Emergency-revert bypass (the only sanctioned admin override)

`enforce_admins` blocks admin merges by default. The single documented exception
(ADR 0039 §2.6): the repo owner may bypass **only** to land an emergency revert
of a change already on `main` that is actively breaking production.

Procedure:

1. Open the revert PR (`git revert <bad-sha>`).
2. If the gates cannot run in time, the owner temporarily relaxes
   `enforce_admins` to `false`, merges the revert, then immediately re-applies
   the §2 payload (restoring `enforce_admins: true`).
3. **Record the bypass in `docs/work-log.md`** — who, when, which commit, why.
   No routine admin bypass is permitted.

---

## 4. Test-job Postgres service

The `test` job runs the full suite, including the engine DB-integration suites,
against an **ephemeral Postgres service container** (`postgres:16`):

- Credentials are a throwaway plain workflow value
  (`DATABASE_URL=postgresql://trade_bot:ci_ephemeral_test_password@localhost:5432/trade_bot`)
  — NOT a repo secret. The DB holds no real data and is destroyed with the
  runner, so committing the password is safe and keeps CI's secret surface at
  zero (consistent with ADR 0039 §2.7 least-privilege).
- `pnpm --filter @bot/engine migration:run` runs before the tests; it creates
  the schema AND the `mcp_reader` / `agent_writer` roles (with the sentinel
  passwords the role migrations set). The role-integration suites connect with
  `MCP_DB_PASSWORD` / `AGENT_WRITER_PASSWORD` matching those sentinels, so no
  manual `ALTER ROLE` is needed in CI.

---

## 5. Audit-allowlist rotation (ADR 0040 §2.2)

When the `sca` job fails on a HIGH/CRITICAL advisory that has **no upstream fix**,
the only sanctioned way to unblock is a time-boxed, justified, signed exception —
never disabling the gate.

The registry is `.github/audit-allowlist.json` (an array). Each entry:

```json
{
  "ghsa": "GHSA-xxxx-xxxx-xxxx",
  "cve": "CVE-2026-NNNNN",
  "package": "<name>@<range>",
  "severity": "high",
  "reason": "no fix published upstream; <why it is acceptable>",
  "reachability": "transitive via <pkg>; <how it is/isn't exercised at runtime>",
  "approvedBy": "<repo owner / operator handle>",
  "approvedOn": "YYYY-MM-DD",
  "expiresOn": "YYYY-MM-DD",
  "trackingIssue": "<gh issue/PR url>"
}
```

Required fields (the `sca` job fails `ALLOWLIST_MALFORMED` if any is missing or
blank): `ghsa`, `package`, `severity`, `reason`, `reachability`, `approvedBy`,
`approvedOn`, `expiresOn`. (`cve` may be `null`; `trackingIssue` is recommended.)

**To add an exception:**

1. Confirm there is genuinely no fixed version (`pnpm why <pkg>`, upstream advisory).
2. Add the entry with `expiresOn` **at most 90 days out** (`ALLOWLIST_MALFORMED`
   otherwise — the cap forces re-review). For an exception on an
   exchange-touching dep (`ccxt`/`decimal.js`/`pg` or their dependency path) the
   `reachability` field MUST argue why the advisory does not reach the order /
   key-handling path; flag it for the security reviewer in the PR.
3. Do NOT touch `pnpm.auditConfig.ignoreGhsas`/`ignoreCves` — they MUST stay
   empty. pnpm strips `ignoreGhsas` advisories from `pnpm audit --json` BEFORE the
   allowlist filter sees them, so adding the ghsa there would fail OPEN (blind the
   expiry / 90-day forcing functions). The `.github/audit-allowlist.json` registry
   is the sole suppression authority; the `auditConfigSync` test FAILS if anything
   is ever added to either native ignore list. Local parity comes from the root
   `audit:ci` script (which runs the same filter as CI), not from `ignoreGhsas`.
4. Open a PR (it passes through the same branch-protection gate); the `approvedBy`
   field records sign-off.

**Rotation / expiry:** an expired entry that still matches a live advisory fails
`ALLOWLIST_ENTRY_EXPIRED` — re-review (is there a fix now? still unreachable?),
then either remove the entry once the dep is bumped or renew `expiresOn`
(≤90 days) with a fresh `approvedOn`. There is no permanent suppression.

---

## 6. Exchange-dependency bump (ADR 0041)

The exchange-critical set is `.github/exchange-critical-deps.json` (`ccxt`,
`decimal.js`, `pg`), each pinned to an exact version. To bump one:

1. Read the upstream changelog/release notes for the new version. For `ccxt` (the
   only order-placing dep) review the diff for order-path / key-handling changes.
2. Update the **exact** version (no `^`/`~`/range) in **every** workspace
   `package.json` that declares it — `decimal.js` is in `apps/engine`,
   `packages/shared`, `packages/analysis`; `pg` is in `apps/engine`, `apps/agent`,
   `packages/analysis`. A mismatch fails `EXCHANGE_DEP_VERSION_SKEW`; a non-exact
   specifier fails `UNPINNED_EXCHANGE_DEP`.
3. Update the version in `.github/exchange-critical-deps.json` to match.
4. Regenerate the lockfile (`pnpm install`, then commit `pnpm-lock.yaml`) so the
   new integrity hash is recorded; `--frozen-lockfile` in CI verifies it.
5. Open the PR. The `deps:pin-and-provenance` job's BLOCKING check is exact-pin +
   cross-workspace skew (`UNPINNED_EXCHANGE_DEP` / `EXCHANGE_DEP_VERSION_SKEW`).
   The binding authenticity guarantee is the per-package sha512 integrity hash
   verified by `--frozen-lockfile` (a substituted critical-dep tarball fails
   install). A non-blocking step logs `PROVENANCE_ATTESTATION_PRESENT/ABSENT` per
   pinned critical dep for visibility. In the PR description state the changelog
   link and that the diff was reviewed for order-path / key-handling impact (ADR
   0041 §2.5); "require conversation resolution" (§2 payload) holds the human sign-off.

> **Provenance command note (R1 contract):** ADR 0041 §2.4 originally named
> `pnpm audit signatures`, which does not exist in pnpm 9.15.9 (the `signatures`
> arg is ignored and a normal audit runs). `npm/pnpm audit signatures` is not a
> meaningful check on a pnpm-managed tree, so the job does NOT run it (it would
> verify nothing or false-red). The binding guarantee is the lockfile integrity
> hash (layer 1); layer 2 is an advisory attestation-presence LOOKUP that makes no
> verification claim and never fails the gate. Adding/removing a dep from the
> critical set is itself a reviewed change (security-reviewer sign-off to loosen).

---

## 7. Boundary-grep refinement note (ADR 0033/0035)

The `boundary` job scopes its import greps to actual `import|export ... from`
edges in source (with the test trees excluded), rather than the bare-string
greps quoted in ADR 0033 §5.1 / ADR 0035 §2.4. A bare-string grep false-positives
on the boundary-documenting comments and the Dockerfile `COPY apps/engine/...`
plumbing (legitimate workspace install). The precise enforcement is still the
ADR 0033 §2.3 / ADR 0035 §2.3 layer-A workspace dependency graph + the
`no-restricted-imports` lint rule + the boundary spec suites, all of which the
`boundary` job runs; the grep is a cheap first-line edge check. (The scribe
records this as an ADR 0033/0035 consequence note at milestone close.)
