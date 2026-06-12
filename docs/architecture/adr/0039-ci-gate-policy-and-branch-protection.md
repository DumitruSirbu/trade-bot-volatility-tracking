# ADR 0039 — CI gate policy + branch protection (deterministic gates only)

**Status:** Accepted-and-shipped (M14 closed 2026-05-28)
**Date:** 2026-05-28
**Milestone:** M14 — CI review gate (deterministic gates phase)
**Depends on:** ADR 0033 (MCP boundary), ADR 0035 (agent boundary), ADR 0034/0036 (DB-role isolation), `docs/best-practices/dev-qa-cycle.md` (definition of done — "green CI ≠ correct"), `docs/best-practices/code-conventions.md`.
**Consumed by:** M14 W1 (workflow authoring), M14 W2 (branch-protection config), M14 W4 (gate smoke).
**Related:** ADR 0040 (supply-chain/SCA gate), ADR 0041 (dependency pinning + provenance), `docs/plans/archive/M14-execution-plan.md`.

## 1. Context

The repo has no `.github/` directory. Every change has landed on `main` with the
gates run **only on the orchestrator's local machine** (`pnpm build`, `pnpm lint`,
`pnpm format`, `pnpm -r test`, per-workspace `typecheck`). `dev-qa-cycle.md` §5
("trust but verify") makes the orchestrator personally re-run them — but that is a
human discipline, not an enforced gate. For a conservative money-handling bot whose
top invariant is *survival over returns*, an unverified merge to `main` that breaks
the build, drops a money-as-`decimal` guard, or smuggles in a vulnerable transitive
dependency is exactly the failure class the project cannot tolerate.

**Scope decision locked by the user (do NOT re-litigate):** M14 ships
**deterministic CI gates only**. The LLM review agents, the QA agent, and the
scribe agent named in `docs/plans/archive/M14-ci-review-gate.md` are **explicitly deferred**
to a future pass (see §6 and the execution plan's Deferred section). This ADR
therefore decides *only* the deterministic-gate policy and how GitHub enforces it.

Repo facts the policy must fit:

- pnpm@9.15.9, node>=22, monorepo. Workspaces: `apps/engine`, `apps/dashboard`,
  `apps/mcp`, `apps/agent`, `packages/shared`, `packages/analysis`.
- Root scripts: `build` (`pnpm -r build`), `lint` (`eslint .`), `format`
  (`prettier --check .`), `test` (`pnpm -r test`).
- Per-workspace `typecheck` (`tsc --noEmit`) exists for `engine`, `dashboard`,
  `mcp`, `agent`, `analysis`. **`packages/shared` has only a `build` script** — no
  `test`/`typecheck`/`lint`. The gate matrix must not assume scripts that do not
  exist (a missing script makes `pnpm -r run <x>` a silent no-op for that package,
  which would be a false-green).
- Boundary guards (ADR 0033 §5, ADR 0035 §2.4) ship as CI greps + boundary specs.
  Those are deterministic and inherit into this gate set.

## 2. Decision

### 2.1 Two tiers: **required (hard-block)** and **advisory (non-blocking)**

A check is **required** when its failure provably means the change is unsafe to
merge: it breaks compilation, fails a test, violates a structural boundary, or
introduces a known high/critical advisory. Required checks are wired as **GitHub
required status checks** on a branch-protection rule for `main`; a red required
check **blocks the merge button**.

A check is **advisory** when its signal is useful but a failure is not, by itself,
proof of unsafety (e.g., a coverage delta, a benchmark drift). Advisory checks run
on the PR and surface output but never block.

### 2.2 Required (hard-blocking) checks

All run on every PR targeting `main` and on pushes to `main`:

| Gate | Command | Why required |
|------|---------|--------------|
| **install integrity** | `pnpm install --frozen-lockfile` | Lockfile tamper / drift detection (ADR 0040 §2.3). A PR that edits a manifest without updating the lock fails here. |
| **build** | `pnpm -r build` | A non-compiling tree must never reach `main`. |
| **typecheck** | `pnpm -r --if-present typecheck` | `tsc --noEmit` across every workspace that declares it. `--if-present` keeps `packages/shared` (build-only) from erroring; §2.5 covers shared's gap. |
| **lint** | `pnpm lint` | `eslint .` — also enforces the ADR 0033/0035 `no-restricted-imports` boundary blocks. |
| **format** | `pnpm format` | `prettier --check .` — fails on unformatted files (does not rewrite in CI). |
| **unit tests** | `pnpm -r --if-present test` | Every workspace's suite, including the adversarial regression suites that `dev-qa-cycle.md` §7.2 mandates never be deleted. |
| **boundary** | `git grep` boundary greps (ADR 0033 §5.1, ADR 0035 §2.4 item 4) + the boundary specs | Structural read-only / no-engine guarantees. A boundary regression is a blocker-severity finding. |
| **supply-chain SCA** | `pnpm audit --audit-level=high --prod` + allowlist filter (ADR 0040) | High/critical advisory blocks merge. |
| **dependency pinning** | exact-pin + provenance assertion for exchange-touching deps (ADR 0041) | An unpinned `ccxt`/`decimal.js` or a provenance-verification failure blocks merge. |

**`--if-present` is mandatory** on `typecheck` and `test`: `pnpm -r run <script>`
errors if *any* selected package lacks the script, which would turn a legitimate
build-only package (`@bot/shared`) into a CI failure for the wrong reason. `--if-present`
skips packages that don't declare the script, while still running it everywhere it
exists. See §2.5 for closing the shared-package coverage gap.

### 2.3 Advisory (non-blocking) checks

- A `format:fix`/`lint:fix` *diff preview* comment is **not** added in M14 (that is
  agent-adjacent; deferred).
- Nothing else is advisory in M14. The deterministic-gate phase keeps the required
  set small and the advisory set empty on purpose: every gate that runs either
  blocks or is removed. (Coverage thresholds, benchmark-drift, and review-agent
  comments are advisory candidates for the deferred phase — §6.)

### 2.4 What "critical/high finding blocks merge" means concretely

It is **not** a free-text human judgment in M14 — it is the union of these
deterministic conditions, each surfaced as a **named, required GitHub status check**:

1. **Build/typecheck/lint/format/test** red → blocked. (Compilation, type, style,
   and behavioral findings.)
2. **Boundary** grep/spec red → blocked. (Structural critical: an LLM-reachable or
   execution-reachable import edge.)
3. **SCA** reports a HIGH or CRITICAL advisory not on the expiring allowlist (ADR
   0040) → blocked.
4. **Lockfile** drift / `--frozen-lockfile` failure → blocked. (Tamper/integrity
   critical.)
5. **Exchange-dep pinning/provenance** assertion red (ADR 0041) → blocked.

Branch protection on `main` (§2.6) requires **all** of these checks green plus a
linear, up-to-date branch before the merge button is enabled. The LLM
"critical-finding" review comments from the original M14 brief are **out of scope**
here; when that phase lands it adds an additional required check, but the
deterministic gates in this ADR stand alone and are sufficient to block on the
objective failure classes above.

### 2.5 Closing the `packages/shared` coverage gap

`@bot/shared` ships DTOs, enums, money helpers, and the shared trigger — load-bearing
contract code consumed by every app. It currently has only a `build` script, so
`--if-present typecheck`/`test` skip it silently. Rather than let a critical package
sit untyped/untested in CI, M14 W1 adds a **deterministic** assertion job
(`shared:coverage-guard`) that fails the PR if `packages/shared/package.json` lacks a
`typecheck` script. This is a forcing function: it does not invent tests, it makes the
*absence* of a typecheck on the most-depended-on package a visible, blocking finding,
to be resolved by `bot-shared-maintainer` adding the script (tracked as a W1
deliverable). Until the script exists, the guard is the gate; once it exists,
`--if-present typecheck` covers shared automatically and the guard is a no-op pass.

### 2.6 Branch protection on `main`

Configured via `gh api` (documented in the runbook + execution plan W2; GitHub
branch-protection is not file-versionable, so the exact `gh api` payload is recorded
in `docs/runbooks/ci-gates.md` so it is reproducible):

- **Require status checks to pass before merging** — ON.
- **Require branches to be up to date before merging** — ON (forces re-run against
  latest `main`; prevents a stale green from merging a regression).
- **Required checks:** every job named in §2.2 (the workflow's job names are the
  contract; renaming a job requires updating the protection rule — called out in the
  runbook).
- **Require a pull request before merging** — ON. Direct pushes to `main` are
  disallowed; the same workflow runs on the PR.
- **Require linear history** — ON (matches the project's squash/rebase-style log).
- **Do not allow bypassing the above settings** — ON, including for administrators,
  with one documented exception: the repo owner may bypass *only* to land an
  emergency revert, recorded in the work log. (No routine admin bypass.)
- **Require conversation resolution before merging** — ON (cheap; keeps review
  threads from being merged-over).

### 2.7 Trigger model + concurrency

- Workflow triggers: `pull_request` (targeting `main`) and `push` (to `main`).
- `concurrency` group keyed on the ref with `cancel-in-progress: true` for PR runs,
  so a force-push supersedes the stale run.
- pnpm store cached keyed on `pnpm-lock.yaml` hash; `node>=22` pinned via the
  `engines` field and the setup action's node-version input (kept consistent with
  `package.json` `engines.node`).
- **Least privilege:** the workflow's `GITHUB_TOKEN` is `permissions: contents:
  read` only in M14 (deterministic gates do not comment or write). No third-party
  action with repo-write scope is used. No secrets are exposed to the gate jobs (the
  SCA/audit jobs hit the public npm registry and the GitHub advisory DB, neither of
  which needs a repo secret). This keeps the supply-chain attack surface of CI
  itself minimal — consistent with the project's least-privilege key posture.

## 3. Consequences

**Positive.**

- A red required check disables the merge button — the `dev-qa-cycle.md` §5 "trust
  but verify" discipline is now machine-enforced, not human-remembered.
- The gate set is the *same commands the orchestrator already runs locally*, so
  there is no local/CI drift and the smoke wave (W4) is a 1:1 reproduction.
- Boundary regressions (the most dangerous structural failure for an LLM-adjacent
  codebase) cannot merge.
- The token has read-only scope; CI adds no new write surface to the repo.

**Negative.**

- Branch protection lives in GitHub config, not in a versioned file. Mitigation: the
  exact `gh api` payload is checked into `docs/runbooks/ci-gates.md` and is part of
  the W2 acceptance criteria, so it is reproducible and reviewable.
- Renaming a workflow job silently breaks the required-check binding (GitHub matches
  by job name). Mitigation: job names are frozen as a contract and called out in the
  runbook; the W4 smoke verifies the merge button actually blocks on a seeded red.

**Neutral.**

- `--if-present` masks a *typo'd* script name as a skip rather than an error. The
  `shared:coverage-guard` (§2.5) is the deterministic backstop for the one package
  where that matters; other packages all declare the scripts.

## 4. Alternatives considered

- **A. Soft gates (CI runs, posts results, but nothing blocks merge).** Rejected:
  reproduces today's "human remembers to check" failure mode. For a money bot the
  gate must be a wall, not a sign.
- **B. One mega-job running all gates sequentially.** Rejected: a build failure
  would mask the audit result, and a slow test suite would delay the fast lint
  signal. Separate named jobs give granular required-check binding and parallelism.
- **C. `pnpm -r test` without `--if-present`.** Rejected: errors on `@bot/shared`
  (no `test` script), producing a false-red for the wrong reason and training
  engineers to ignore the gate.
- **D. Coverage-threshold gate in M14.** Deferred: a coverage number is a proxy, not
  a correctness proof, and `dev-qa-cycle.md` already mandates paired adversarial
  tests per fix item — a process control stronger than a line-coverage floor.
  Revisit as an advisory check in the deferred phase.
- **E. Allowing admin bypass routinely.** Rejected: defeats the gate. The single
  documented emergency-revert exception is the only escape hatch and is logged.
- **F. Running gates only on `main` push (not on PR).** Rejected: that gates *after*
  merge — the damage is already on `main`. PR-time gating is the whole point.

## 5. References

- `docs/plans/archive/M14-execution-plan.md` §W1 (workflow), §W2 (branch protection), §W4
  (gate smoke).
- `docs/best-practices/dev-qa-cycle.md` §4.1 (green CI ≠ correct), §5 (trust but
  verify), §7.2 (adversarial tests inherit forward).
- ADR 0040 (supply-chain SCA + exception process + lockfile integrity).
- ADR 0041 (dependency pinning + provenance for exchange-touching deps).
- ADR 0033 §5, ADR 0035 §2.4 (boundary gates this set inherits).
