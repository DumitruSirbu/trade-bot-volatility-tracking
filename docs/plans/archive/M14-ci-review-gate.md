# M14 — CI review gate (phase 2)

**Goal:** An automated agent team that reviews every change for clean code, business
logic, and security before merge.

**Depends on:** a working repo + CI.

## Tasks

- **Review agents** (clean-code, business-logic, security) wired into CI on PRs.
  - *Output:* each PR gets automated review comments.
- **QA agent.** Generate/verify tests for the diff.
  - *Output:* test coverage feedback per PR.
- **Scribe agent.** Keep docs (`CLAUDE.md`, plans, README) in sync after merges.
  - *Output:* doc drift flagged/updated.
- **Supply-chain / dependency gate.** SCA (`npm/pnpm audit`) + lockfile-integrity check on every PR; pin and verify exchange-touching dependencies (ccxt, decimal.js). **Block on high/critical advisories** (define the threshold), with a documented exception process for unfixable findings and provenance verification for the exchange-touching deps. Critical for a money-handling bot.
  - *Output:* a high/critical advisory or lockfile tampering blocks merge; exceptions are tracked.
- **Gate policy.** Block merge on critical security/logic findings.
  - *Output:* failing review blocks merge.

## Definition of done

PRs are automatically reviewed by the agent team, tests are checked, docs stay in
sync, and critical findings block merge.

> This is the deliberate "agents for development" / résumé-skills track, kept
> entirely outside the trading runtime.

## Outcome

**M14 shipped deterministic CI gates from scratch (W1–W3 complete).** User locked scope explicitly DEFERRED LLM review/QA/scribe agents to M14.5/M15 (phase-2); M14 scope is gates + supply-chain + green-up + runbook only. **Repo `main` provably green at root level for first time** — legacy gating never passed; migrations exposed 22 test failures invisible to unit-only runs.

### Deterministic gates (10 jobs, all required)

`.github/workflows/ci.yml` wires 10 jobs as separate required status checks on `main`:

1. **install** — `pnpm install --frozen-lockfile` (lockfile integrity)
2. **build** — `pnpm -r build`
3. **typecheck** — `pnpm -r --if-present typecheck` (TypeScript strict mode)
4. **lint** — `pnpm lint` (ESLint + no-restricted-imports boundary rules)
5. **format** — `pnpm format` (Prettier --check)
6. **test** — full suite incl. DB-integration (ephemeral Postgres service, migrations run before tests)
7. **boundary** — ADR 0033/0035 import greps + boundary spec suites (MCP/agent structural isolation)
8. **sca** — `pnpm audit --prod --json` + allowlist-filtered (ADR 0040, HIGH/CRITICAL block)
9. **lockfile:single-source** — exactly one root `pnpm-lock.yaml`, no foreign lockfiles
10. **deps:pin-and-provenance** — exchange-critical exact-pin + cross-workspace skew (ADR 0041), advisory attestation lookup non-blocking

Workflow: concurrency cancels PR runs only; post-merge `main` runs always complete (gate history never left half-finished); permissions `contents: read` (no write); third-party actions SHA-pinned; job-name contract (renaming breaks branch-protection binding).

### Supply-chain layer

- `.github/audit-allowlist.json` — empty `[]` by design; exceptions require time-boxed, justified entries (GHSA ID, package, severity, reason, reachability, approver, dates, max 90-day expiry)
- `.github/exchange-critical-deps.json` — ccxt 4.5.54, decimal.js 10.6.0, pg 8.21.0 (exact pins, cross-workspace skew checked)
- `pnpm.auditConfig.ignoreGhsas: []` — kept empty by binding enforcement (pnpm strips ignoreGhsas before audit output, would blind allowlist expirations); `.github/audit-allowlist.json` is sole suppression authority
- Pure modules `apps/engine/tests/ci/` — 5 gate functions + 30 unit tests (auditAllowlistFilter, exchangeDepPinCheck, ciPaths, runScaGate, runPinGate); no production-code impact

### Green-up (repo never passed root gates before M14)

- **eslint.config.js:** wired `globals` package (killed ~12,220 `no-undef`), `^_` unused-ignore convention, `.agents/`/`.claude/` ignores
- **.prettierignore:** scoped format gate to CODE only; deliberately excludes `docs/`, `README.md`, `CLAUDE.md` (ADR 0039 §2.2 refinement — auto-formatting 80 prose-markdown files was 5,197 lines low-value table-repad churn)
- **typecheck:** added `packages/shared/package.json` `typecheck` script, engine `tsconfig.typecheck.json` (typecheck now covers tests)
- **prettier:** formatted 97 code/config files (consolidate whitespace, consistent imports)
- **lint:** fixed ~90 real errors (dead code, require→import conversions, double-imports)

### Production bug caught (headline outcome)

M13 agent DB-write path broken at runtime — invisible to mocked unit tests. **Root cause:** `agent_writer` role has `default_transaction_read_only=on`; SDF `SET LOCAL transaction_read_only=off` fires AFTER the first query (must fire BEFORE). Every weekly agent write would fail in production.

**Fix:** `apps/agent/src/persistence/AgentPgClient.ts` — explicit `SET TRANSACTION READ WRITE` before any query, paired unit + integration tests. Also fixed 21 migrate-only test-quality failures (partition fixtures → relative dates, stale `auth_tokens` phantom-table refs, invalid UUID fixtures, stale KeyPermission predicates, BACKTEST_ARTEFACT_ROOT path, stale migration count).

**Why unit tests missed it:** mocked `pool.query()`, never ran real-Postgres transaction semantics.

### Test counts at close

- Engine: 2,555 pass / 0 fail (was 22 failing pre-migration; migrate-only Postgres run exposed M13 DB bug)
- CI-gate unit tests: +30 new (auditAllowlistFilter, exchangeDepPinCheck, ciPaths, runScaGate, runPinGate specs)
- Agent: 261 (M13 regression green)
- Dashboard: 153 (M13 regression green)
- All root gates: install, build, typecheck, lint, format all clean

### ADR refinements (0039–0041 Accepted-and-shipped)

- **ADR 0039 § 2.2:** `.prettierignore` format gate scopes to CODE only (deliberate refinement — prose docs excluded to avoid mechanical repad churn)
- **ADR 0040 § 2.2:** `pnpm.auditConfig.ignoreGhsas` MUST stay empty; `.github/audit-allowlist.json` is sole suppression authority (pnpm's native ignore-list blinds the allowlist's expiry forcing-function by stripping advisories before filter sees them); `auditConfigSync` test enforces invariant
- **ADR 0041 § 2.4:** Provenance-verification contract clarified — layer 1 (binding) is per-package sha512 integrity hash enforced by `--frozen-lockfile`, layer 2 (advisory only) is npm-registry attestation-presence lookup (non-blocking; crypto signature verification deferred as not meaningful on pnpm-managed tree)

### Dependency changes

- **ccxt** `^4.5.54` → `4.5.54` (exact pin per exchange-critical set)
- **react-router-dom** `7.1.5` → `7.15.1` (cleared 4 HIGH advisories: path-traversal, source-map-related, race-condition in loader; gates now green)

### Runbook & documentation

`docs/runbooks/ci-gates.md` — operator reference for deterministic gates + branch-protection rule (NOT YET APPLIED by infrastructure).

**Key sections:**
1. Required status checks (job-name contract, 10 jobs)
2. Branch-protection payload (`gh api` command, `enforce_admins=true`, `required_linear_history=true`, job-name bindings to Actions app id 15368)
3. Emergency-revert exception (only sanctioned admin bypass: log in work-log, re-apply protection after revert)
4. Test-job Postgres service (ephemeral, throwaway credentials, migrations run before tests)
5. Audit-allowlist rotation (ADR 0040 process, 90-day expiry cap, time-boxed exceptions)
6. Exchange-dependency bumps (ADR 0041 procedure, changelog review, exact-pin sync, integrity verification)
7. Boundary-grep refinement (import/export edges in source, not bare-string greps; false-positive guard for comments/Dockerfile)

README section added (CI overview, 10 gates, local gate-running commands, supply-chain exception process, exchange-dep bump workflow).

### Review cycle

**R1:** 0 blockers, 2 highs
- **S-H1 (security):** SCA fail-open design — `pnpm audit --json` output strips `ignoreGhsas` before the in-repo allowlist filter sees it; adding GHSA to ignoreGhsas blinds the allowlist's 90-day forcing-function. **Fix:** inverted design: keep ignoreGhsas empty, `audit-allowlist.json` is sole authority, synchronization test enforces invariant, `pnpm run audit:ci` wrapper gives local parity.
- **S-H2 (security):** Provenance inert — `pnpm audit signatures` doesn't exist (ignored in pnpm 9), `npm audit signatures` can't read pnpm tree. **Fix:** downgrade layer-2 provenance to advisory attestation-presence lookup (non-blocking), layer-1 binding is sha512 integrity (already enforced by `--frozen-lockfile`), crypto verification deferred (not meaningful on pnpm-managed tree).

**R2:** 4 reviewers (security, logic, clean-code, quant), 0 blockers / 0 highs. All mediums resolved.

### Deferred to M14.5/M15

- **LLM review/QA/scribe agents in CI** — phase-2 proposal (user locked scope to gates-only for M14)
- **Coverage-threshold gate** — code coverage % bar (currently advisory-only; baseline TBD)
- **Dependabot/Renovate** — dependency automation (supply-chain gate works stand-alone; auto-bump-and-PR future enhancement)
- **Short-position funding-sign test** — optional belt-and-suspenders (funding math verified in M4/M6; asymmetric position direction sign inversion not explicit test target)

### Critical infrastructure note

**Branch protection (main) is NOT YET APPLIED.** M14 scope is deterministic gates + green-up + runbook. The `gh api` payload in `docs/runbooks/ci-gates.md` §2 is ready for the repo owner to apply when ready (shared-state GitHub admin change; cannot be automated; must be verified afterward via `gh api /repos/.../branches/main/protection`).

### Zero blockers, zero highs at close

Engine test suite green (2,555/2,555); all root gates green (install, build, typecheck, lint, format, test, boundary, sca, lockfile, deps); M13 production bug caught + fixed; runbook complete; ADRs refined + shipped.
