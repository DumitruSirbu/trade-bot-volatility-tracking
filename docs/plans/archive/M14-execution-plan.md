# M14 — Execution plan (deterministic CI gates)

**Goal recap.** Stand up GitHub Actions CI from scratch (`.github/` does not exist
yet) so that every PR targeting `main` is **hard-blocked** by a fixed set of
deterministic gates: install-integrity, build, typecheck, lint, format, unit tests,
structural boundary, supply-chain SCA, and exchange-dependency pinning + provenance.
Branch protection on `main` wires these as required status checks so a red gate
disables the merge button. The exception process for unfixable advisories is an
expiring, justified, signed in-repo allowlist.

**Scope locked by the user before this plan was written (do NOT re-litigate):**

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Deterministic CI gates ONLY.** LLM review agents, QA agent, scribe agent are **deferred** to a future pass. | The original M14 brief's agent team is the "agents-for-development" track; standing up reliable deterministic gates first is the prerequisite and is independently valuable. |
| 2 | **Gate policy: hard-block on critical/high.** Required status checks fail the PR and block merge. | A money bot's gate must be a wall, not a sign (ADR 0039). |
| 3 | **SCA threshold: block on HIGH + CRITICAL** (`pnpm audit`), with a documented exception process; provenance verification for exchange-touching deps. | ADR 0040 + ADR 0041. |
| 4 | **No new CI vendor/secret.** Use pnpm + the GitHub advisory DB only. | Minimize CI's own supply-chain attack surface. |

**Authoritative ADRs (drafted W0; main session moves to Accepted before W1):**

- **ADR 0039** — CI gate policy + branch protection. Required vs advisory checks;
  the exact gate commands; what "critical/high blocks merge" means as named GitHub
  required status checks; branch-protection config on `main`; least-privilege
  `GITHUB_TOKEN`.
- **ADR 0040** — Supply-chain SCA gate (`pnpm audit --audit-level=high --prod`),
  the expiring/justified/signed `.github/audit-allowlist.json` exception process,
  and lockfile integrity (`--frozen-lockfile` + per-package `sha512` + single-lockfile
  assertion).
- **ADR 0041** — Exact-pin + cross-workspace version-consistency + provenance
  (integrity hash + `pnpm audit signatures`) for the exchange-touching deps
  (`ccxt`, `decimal.js`, `pg`), driven by `.github/exchange-critical-deps.json`.
  Includes the immediate `ccxt ^4.5.54 → 4.5.54` pin fix.

---

## Repo facts the plan must fit

- pnpm@9.15.9, node>=22 (`engines.node`), monorepo. Workspaces: `apps/engine`,
  `apps/dashboard`, `apps/mcp`, `apps/agent`, `packages/shared`, `packages/analysis`.
- Root scripts: `build` = `pnpm -r build`; `lint` = `eslint .`; `format` =
  `prettier --check .`; `test` = `pnpm -r test`.
- Per-workspace `typecheck` exists for engine, dashboard, mcp, agent, analysis.
  **`packages/shared` has ONLY `build`** — no `test`/`typecheck`/`lint`. The gate
  matrix uses `pnpm -r --if-present <script>` and a `shared:coverage-guard`
  (ADR 0039 §2.5) so shared's gap is a visible blocking finding, not a silent skip.
- `ccxt` is `^4.5.54` (unpinned — fixed in W3). `decimal.js` is `10.6.0` exact in
  three packages.
- Boundary greps/specs already exist (ADR 0033 §5, ADR 0035 §2.4) — the boundary
  gate wraps them, it does not re-invent them.
- `.github/` does not exist. CI owner is **`bot-devops`** per its agent frontmatter.

---

## Wave plan

Each wave is ≤5 files/items per `docs/best-practices/dev-qa-cycle.md`. Serial unless
marked otherwise. All file paths are repo-relative.

### W0 — ADRs + scope lock

**Agents:** architect (this plan + the three ADRs).

**Deliverables:**

1. ADR 0039, 0040, 0041 drafted under `docs/architecture/adr/` (done in W0).
2. This execution plan (done in W0).
3. Main session reviews + moves all three ADRs `Proposed → Accepted` before W1.

**Acceptance criteria:** three ADRs present with Context → Decision → Consequences →
Alternatives; the gate matrix in ADR 0039 §2.2 matches the commands W1 will wire; the
deferred LLM-agent scope is recorded here in §Deferred. No YAML/code written yet.

### W1 — Core gate workflow (build / typecheck / lint / format / test / install)

**Agent:** `bot-devops`.

**Scope (5 items):**

1. **`.github/workflows/ci.yml`** — the PR + push-to-`main` gate workflow.
   - Triggers: `pull_request` (base `main`) + `push` (`main`).
   - `concurrency`: group on ref, `cancel-in-progress: true`.
   - `permissions: contents: read` (ADR 0039 §2.7 — no write scope).
   - Shared setup: checkout, `pnpm/action-setup@<pinned-sha>` pinned to
     `pnpm@9.15.9`, `actions/setup-node@<pinned-sha>` with `node-version: 22` +
     pnpm-store cache keyed on `pnpm-lock.yaml`. **Third-party actions pinned by
     commit SHA, not tag** (CI supply-chain hygiene).
   - Named jobs (each a separate required check; names are a contract per ADR 0039
     §2.6): `install`, `build`, `typecheck`, `lint`, `format`, `test`.
2. **`install` job** — `pnpm install --frozen-lockfile`. All other jobs `needs:
   install` and restore the same store cache.
3. **`build` / `test` / `typecheck` jobs** — `pnpm -r build`,
   `pnpm -r --if-present test`, `pnpm -r --if-present typecheck`.
4. **`lint` / `format` jobs** — `pnpm lint` (`eslint .`), `pnpm format`
   (`prettier --check .`).
5. **`shared:coverage-guard` job + the `packages/shared` typecheck script.**
   - Deterministic guard: fails if `packages/shared/package.json` lacks a
     `typecheck` script (ADR 0039 §2.5).
   - **Routed through `bot-shared-maintainer`** (shared-contract touch per CLAUDE.md
     rule 5): add `"typecheck": "tsc --noEmit"` to `packages/shared/package.json`
     (+ a `tsconfig` if needed) so `--if-present typecheck` covers shared and the
     guard becomes a no-op pass.

**Exact gate commands wired:**

| Job | Command |
|-----|---------|
| install | `pnpm install --frozen-lockfile` |
| build | `pnpm -r build` |
| typecheck | `pnpm -r --if-present typecheck` |
| lint | `pnpm lint` |
| format | `pnpm format` |
| test | `pnpm -r --if-present test` |

**Files:** `.github/workflows/ci.yml`, `packages/shared/package.json`
(+ `packages/shared/tsconfig.json` if absent).

**Acceptance criteria:** workflow validates (`actionlint` clean / `gh workflow view`
parses); on a throwaway branch every job runs and is green against the current tree;
seeding a deliberate type error makes only `typecheck` red; seeding an unformatted
file makes only `format` red; `shared` typecheck runs (guard passes once the script
is added). Each job appears as a distinct check on the PR.

### W2 — Boundary gate + branch protection on `main`

**Agent:** `bot-devops`.

**Scope (5 items):**

1. **`boundary` job in `ci.yml`** — wraps the existing ADR 0033 §5.1 + ADR 0035
   §2.4 greps and runs the boundary spec suites
   (`apps/mcp/tests/boundary*.spec.ts`, `apps/agent/tests/boundary*.spec.ts`,
   `packages/analysis` boundary). Fails on any banned import edge. (Does NOT
   re-implement the guards; runs the existing ones in CI.)
2. **Branch-protection rule on `main`** — applied via `gh api`
   (`PUT /repos/DumitruSirbu/trade-bot-volatility-tracking/branches/main/protection`).
   Required checks = every job name from W1 + the `boundary` job + the W3 jobs
   (added when W3 lands). Settings per ADR 0039 §2.6: require PR, require up-to-date,
   require status checks, linear history, no admin bypass (single logged
   emergency-revert exception), require conversation resolution.
3. **`docs/runbooks/ci-gates.md`** — records the exact `gh api` branch-protection
   payload (since GitHub config is not file-versionable), the required-check job-name
   contract, how to add/rotate an audit-allowlist entry, how to bump a pinned
   exchange dep, and the emergency-revert bypass procedure.
4. **Required-check job-name freeze** — runbook lists the canonical job names and
   warns that renaming a job silently breaks the protection binding (GitHub matches
   by name).
5. **Disallow direct push to `main`** — verified by the branch-protection settings;
   the runbook documents that all changes flow through PRs.

**Files:** `.github/workflows/ci.yml` (boundary job),
`docs/runbooks/ci-gates.md`.

**Acceptance criteria:** branch protection visible via `gh api ... /protection`;
a test PR with a red required check shows the merge button disabled; a clean PR shows
it enabled; the runbook's `gh api` payload reproduces the rule from scratch.

### W3 — Supply-chain SCA + lockfile integrity + exchange-dep pinning/provenance

**Agent:** `bot-devops` → `bot-shared-maintainer` (the `ccxt` pin change).

**Scope (5 items):**

1. **`sca` job** — `pnpm audit --audit-level=high --prod --json` piped to a
   deterministic allowlist-filter step (ADR 0040 §2.2): matched-and-unexpired →
   suppress; matched-and-expired → fail `ALLOWLIST_ENTRY_EXPIRED`; unmatched
   HIGH/CRITICAL → fail; malformed/`>90d` entry → fail `ALLOWLIST_MALFORMED`. A
   second **advisory** (non-blocking) dev-scope `pnpm audit --audit-level=high`
   run logs dev-dep findings without blocking.
2. **`.github/audit-allowlist.json`** — initially `[]` (empty allowlist). Schema +
   field semantics per ADR 0040 §2.2. The allowlist-filter step + its unit tests
   live where they can run under the repo's test runner (devops places them; a small
   pure module + spec, e.g. under a `tools/ci/` or `scripts/ci/` dir with a paired
   `.spec`). A W3 test asserts `pnpm.auditConfig.ignoreGhsas` in root
   `package.json` stays in sync with the non-expired allowlist entries.
3. **`lockfile:single-source` job** — assert exactly one root `pnpm-lock.yaml` and no
   `package-lock.json`/`yarn.lock`/nested lockfiles
   (`git ls-files | grep -E '(package-lock\.json|yarn\.lock)$'` empty). The
   `--frozen-lockfile` integrity-hash guarantee already rides on the W1 `install`
   job (ADR 0040 §2.3).
4. **`deps:pin-and-provenance` job** — reads `.github/exchange-critical-deps.json`
   (`ccxt`, `decimal.js`, `pg`); fails on any non-exact specifier
   (`UNPINNED_EXCHANGE_DEP`) or cross-workspace version skew
   (`EXCHANGE_DEP_VERSION_SKEW`); runs `pnpm audit signatures` (hard-fail on a
   failed signature for a critical dep = `PROVENANCE_SIGNATURE_INVALID`); records
   `PROVENANCE_ABSENT` (non-fatal) where no attestation exists (ADR 0041 §2.4);
   flags any PR that changes a pinned critical-dep spec for the security reviewer
   (ADR 0041 §2.5).
5. **`ccxt` pin fix** — `apps/engine/package.json` `"ccxt": "^4.5.54"` →
   `"ccxt": "4.5.54"`; regenerate `pnpm-lock.yaml`. **Routed through
   `bot-shared-maintainer`** (pins the only exchange client — shared-contract-adjacent
   per CLAUDE.md rule 5). Add `.github/exchange-critical-deps.json` listing the three
   deps with their pinned versions.

**Files:** `.github/workflows/ci.yml` (sca, lockfile, pin/provenance jobs),
`.github/audit-allowlist.json`, `.github/exchange-critical-deps.json`,
`apps/engine/package.json`, `pnpm-lock.yaml`, `package.json` (`pnpm.auditConfig`),
allowlist-filter module + spec (devops-placed `tools/ci/` or `scripts/ci/`).

**Acceptance criteria:** `sca` green on the current tree (no HIGH/CRITICAL prod
advisories, or each is allowlisted+unexpired); seeding an expired allowlist entry
fails the job; `deps:pin-and-provenance` green after the `ccxt` pin; reverting the
pin to `^` re-fails it; `decimal.js` skew (temporarily bumping one workspace) fails
the skew check; `lockfile:single-source` green; a one-byte `pnpm-lock.yaml` edit
fails the W1 `install` job (integrity-hash proof); the three new jobs are added to
the `main` required-check set (W2 runbook payload updated).

### W4 — Security + clean-code review, then local gate smoke

**Agents:** parallel `bot-review-security` + `bot-review-clean-code` (W4a) →
`bot-devops` (W4b smoke). Reviewers resumed via `SendMessage` on round 2+ per
`dev-qa-cycle.md` §3.

**Scope (W4a — review):**

- **Security:** confirm `GITHUB_TOKEN` is `contents: read` only; third-party actions
  are SHA-pinned; no secret is exposed to gate jobs; the SCA threshold + exception
  expiry semantics match ADR 0040; the exchange-dep pin/provenance gate matches ADR
  0041; branch protection forbids admin bypass except the logged emergency revert;
  the allowlist cannot be silently widened (it is a versioned file under the same
  gate).
- **Clean-code:** the allowlist-filter module obeys `code-conventions.md` (≤20-line
  functions, intention-revealing names, no magic numbers — severity levels/expiry-day
  caps as named constants); the workflow YAML job names match the runbook contract;
  no dead/commented config.

**Scope (W4b — local gate smoke, mirrors `dev-qa-cycle.md` §6.4 for a CI milestone):**

The "live-app smoke" for a CI milestone is **driving every gate to both green and
red on a real branch**, not booting the trading engine. `bot-devops`:

1. Opens a throwaway PR; confirms all required checks run and the merge button is
   **enabled** when green.
2. Seeds, one at a time, a failure for each gate and confirms (a) only that gate goes
   red and (b) the merge button is **disabled**: type error → `typecheck`;
   unformatted file → `format`; lint violation → `lint`; failing test → `test`;
   `import { ExecutionService } from '@bot/engine'` in `apps/agent` → `boundary` +
   `lint`; lockfile one-byte edit → `install`; `ccxt` reverted to `^` →
   `deps:pin-and-provenance`; an expired `.github/audit-allowlist.json` entry → `sca`.
3. Confirms a second lockfile (`package-lock.json`) fails `lockfile:single-source`.
4. Records the smoke matrix (gate → seeded failure → observed red → merge blocked) in
   `docs/runbooks/ci-gates.md`.

**Fix-wave discipline:** ≤5 items per fix wave, reviewers resumed via `SendMessage`.
Cycle until zero blockers, zero highs, majority of mediums resolved.

**Acceptance criteria:** every gate proven to block on its seeded failure; merge
button proven disabled on red and enabled on green; smoke matrix recorded; reviewers
sign off zero blockers / zero highs.

### W5 — Scribe close

**Agent:** `bot-scribe`.

**Deliverables:** work-log entry; CLAUDE.md status block updated (M14 deterministic
gates done; LLM-agent phase deferred); ADRs 0039–0041 status → Accepted-and-shipped;
`docs/plans/00-overview.md` cross-cutting risk "Order-policy matrix as shared truth /
CI smoke" updated to reference the now-live boundary gate; the deferred LLM-agent
items recorded with their owning future milestone.

---

## Deferred (explicitly out of M14 scope — locked by the user)

Carried forward to a **future LLM-CI pass** (proposed milestone **M14.5 — CI review
agents**, gated by M14 deterministic gates being green + M15 cloud topology
decisions). None of these are designed or wired in M14:

| Deferred item | Owning future milestone | Note |
|---------------|-------------------------|------|
| **LLM review agents in CI** (clean-code / business-logic / security) posting PR comments | M14.5 (CI review agents) | Adds an additional *required* check on top of the deterministic set; needs claude-code-action or equivalent, a token with PR-comment scope, and a cost/rate budget — none designed now. |
| **QA agent in CI** (generate/verify tests for the diff) | M14.5 | Test-generation feedback per PR; advisory at first, not blocking. |
| **Scribe agent in CI** (keep CLAUDE.md / plans / README in sync post-merge) | M14.5 | Doc-drift detection; runs on `push` to `main`, not a merge gate. |
| **Coverage-threshold gate** | M14.5 (advisory) | Proxy metric; `dev-qa-cycle.md` paired-test rule is the stronger control. |
| **Dependabot/Renovate version-bump PRs** | M14.5 (advisory) | Version freshness; not a blocking gate — pinned exchange deps bump via reviewed PR (ADR 0041). |
| **SaaS SCA / SBOM attestation** (Snyk, Sigstore policy-controller) | M15 (cloud go-live) | Revisit only if the cloud deploy pipeline needs SBOM; M14 stays on `pnpm audit` + integrity hash to avoid new vendor/secret. |
| **Bearer-token auto-rotation for agent → MCP** | M14.5 / M15 | Carried from M13 deferred; orthogonal to gates. |

Per ADR 0039 §6 and ADR 0040/0041, the deterministic gates stand alone and are
sufficient to block on the objective failure classes (build/type/lint/format/test/
boundary/SCA/lockfile/pinning/provenance) without any LLM-in-CI component.

---

## Test strategy

1. **Gate-block proof (W4b):** every required gate is driven to red on a seeded
   failure and the merge button is confirmed disabled — the deterministic analogue
   of `dev-qa-cycle.md` §6.4 live-app smoke.
2. **Allowlist-filter unit tests (W3):** boundary cases — matched+unexpired (pass),
   matched+expired (fail), unmatched HIGH/CRITICAL (fail), malformed entry (fail),
   `expiresOn` > 90d (fail), MODERATE not on list (pass/log-only).
3. **Pin/provenance unit tests (W3):** caret/tilde/star/tag/git spec on a critical
   dep → `UNPINNED_EXCHANGE_DEP`; matching exact pins across workspaces → pass;
   divergent `decimal.js` versions → `EXCHANGE_DEP_VERSION_SKEW`.
4. **Lockfile-integrity proof (W3/W4b):** one-byte `pnpm-lock.yaml` edit → `install`
   fails; a second lockfile → `lockfile:single-source` fails.
5. **Auditconfig-sync test (W3):** `pnpm.auditConfig.ignoreGhsas` matches the
   non-expired allowlist entry set.
6. **Boundary inheritance (W2):** the existing ADR 0033/0035 boundary specs run in
   the `boundary` CI job and a seeded banned import fails it.

---

## Summary — wave dispatch for orchestrator

1. **W0** — ADRs 0039–0041 + this plan; main session accepts ADRs. Architect.
2. **W1** — core `ci.yml` (install/build/typecheck/lint/format/test) +
   `shared` typecheck script + coverage-guard. `bot-devops` → `bot-shared-maintainer`
   (shared typecheck script).
3. **W2** — `boundary` job + branch protection on `main` via `gh api` +
   `ci-gates.md` runbook. `bot-devops`.
4. **W3** — `sca` + allowlist filter + `lockfile:single-source` +
   `deps:pin-and-provenance` + `ccxt` exact pin. `bot-devops` →
   `bot-shared-maintainer` (`ccxt` pin).
5. **W4a** — security + clean-code review (resume via `SendMessage` round 2+).
6. **W4b** — local gate smoke: drive every gate green→red, prove merge-block.
   `bot-devops`.
7. **W5** — `bot-scribe` close: work log, status block, ADRs → Accepted-and-shipped,
   deferred LLM-agent items recorded.

ADRs **0039** (gate policy + branch protection), **0040** (SCA + lockfile integrity +
exception process), and **0041** (exchange-dep pinning + provenance) are the
load-bearing decisions; all three are accepted at the start of W1 so `bot-devops` has
an authoritative reference throughout the milestone.
